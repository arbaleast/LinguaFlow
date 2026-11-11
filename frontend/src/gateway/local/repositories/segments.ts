/**
 * 段落 Repository（对应后端 `service/segment.go` + `service/segment_search_replace.go`
 * + `service/review.go`）。
 *
 * ## 窗口分页（`listResourceSegments`）
 *
 * 后端有两条列表路径：无 search / group_key 走「SQL 分页」，否则走「keyset 扫描」。
 * 两条路径的可观察语义完全一致，本移植统一用扫描实现，但**逐条复刻**其边界规则：
 *
 * 1. **锚点**（`anchorSegmentId`）按数据库段落 ID 定位，只要求存在于本资源下，
 *    不要求锚点本身满足过滤条件；取 `anchorIndex = anchor.segment_index` 作为
 *    窗口起点（`index >= anchorIndex`）。请求带 `group_key` 时锚点必须同属该章节。
 * 2. **游标**：显式 `cursor`（含空串，`hasCursor`）或 `cursor > 0` 都算「有游标」；
 *    `direction=desc` 只有在「有游标且无锚点」时才是降序窗口——**desc 无游标仍按
 *    升序首页返回**（对齐 Go `descWindow := direction == "desc" && cursorRequested
 *    && AnchorSegmentID == nil`）。
 * 3. **取批 Limit+1**：升序窗口取 `index > cursor`（或 `>= anchorIndex`）的前
 *    `limit+1` 条匹配；降序窗口取 `index < cursor` 的最后 `limit+1` 条匹配，再
 *    截断并**反转**，因此响应 `items` 恒按 `segment_index` 升序。
 * 4. **页边界重复检测**（Go `checkSegmentPageBoundaryDuplicate`）：第 `limit+1`
 *    行是被页丢弃的一行。若它与页内边界行同 `segment_index`，游标（只能表达
 *    index）无法再次表达这些行——返回 `DuplicateSegmentIndexError`（HTTP 409，
 *    code `duplicate_segment_index`），**绝不静默返回不完整页**。
 * 5. **邻接游标**：两侧邻接性用**完整过滤条件 F** 做存在性判断
 *    （`F(index < 首条).exists` / `F(index > 末条).exists`），不复用已叠加窗口与
 *    limit 的查询；不存在时响应字段为 `null`（不是省略）。
 * 6. **include_total**：独立的、只含过滤条件 F（不含窗口与 limit）的计数。
 *
 * `segment_index` 不唯一时以 `localId` 作决胜键，复刻后端 `ORDER BY
 * segment_index, id` 的稳定顺序。
 *
 * ## CAS 与代际
 *
 * - 段落 `content_version` 单调递增：任何内容列（target_text / status /
 *   review_comment / quality_issues）变更都 +1，复刻 ent `Segment` hook。
 * - 每个写事务开头先把 `Resource.translation_generation` +1，条件是
 *   `source_generation` 仍等于请求开始时的值（Go `AdvanceTranslationGeneration`）；
 *   不匹配 → 409。失败时整个 Dexie 事务回滚，代际不会虚增。
 * - 单段 PATCH 支持可选 `expected_content_version`：不匹配时抛
 *   `ConflictError`（409）。OpenAPI 的 PATCH 请求体没有该字段，因此它是浏览器
 *   本地模式的**可选扩展**；不传时行为与后端一致（只做事务内读改写）。
 *
 * ## 搜索替换
 *
 * `preview` 只读；`apply` 在**单个 Dexie 事务**内完成「逐段重新匹配 → 替换 →
 * content_version +1 → 写 segment_revisions 快照」，返回 `operationId`；
 * `undo` 按 operation_id 载入快照，在事务内逐段乐观校验（当前 target/status/
 * comment/issues 仍等于快照 after 才回滚到 before），写一条反向 revision，并
 * 生成新的 `undoOperationId`（因此可再撤销 = 重做）。撤销把 `before.target_text`
 * **原样**写回，保证与 apply 前逐字节相同；`content_version` 只增不减。
 *
 * 与后端的已知差异（均因本地数据模型没有对应列，见各处注释）：
 * - 手动编辑 / 搜索替换后不重跑零配置 QA（QA 写路径归流水线所有，本地
 *   `quality_issues` 由 QA 线程维护），因此也不做 issue 对账；
 * - revision 行没有 `source_generation` 列，undo 不做源修订代际校验，也不做
 *   90 天按龄裁剪；
 * - 快照没有 `reviewed_by` 列，undo 的乐观校验不比较审核人；但快照含
 *   `review_comment`，undo 会比较并还原它（比后端更严格，避免覆盖批注）；
 * - revision `kind` 使用本地 `SegmentRevisionRow` 契约里的 `search_replace`
 *   （后端 `SegmentRevision.KindReplace` 为 `replace`）；
 * - `Project.storage_generation` / `Resource.source_generation` 不由段落写路径
 *   推进：前者属于存储迁移，后者是**原文替换**的代际，只作为写事务的 CAS
 *   期望值参与校验。
 */
import type { ApiSchemas } from '@/gateway/contracts'
import type { LinguaFlowDatabase } from '@/infrastructure/indexeddb/db'
import {
  ConflictError,
  getDeviceId,
  newId,
  newRow,
  nowIso,
  touch,
} from '@/infrastructure/indexeddb/repo'
import type {
  BaseRow,
  QualityIssueRow,
  ResourceRow,
  SegmentRevisionRow,
  SegmentRow,
  SegmentSnapshot,
  SegmentStatus,
} from '@/infrastructure/indexeddb/types'
import { goToLower, goTrimSpace } from '@/domain/glossary'
import { requiresWellFormedTargets, validateFragment } from '@/domain/markup'
import { isFilterableIssueCode } from '@/domain/qa'
import { createSearchMatcher, type SearchMatchMode, type SearchMatcher } from '@/domain/search'

import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  RepositoryValidationError,
} from './errors'
import { requireProject } from './projects'
import { getResource } from './resources'

// ── 常量 ──

/** 分页默认条数（Go `parseCursorPagination(50, 200)`）。 */
export const DEFAULT_SEGMENT_LIMIT = 50
/** 分页条数上限；超过按默认值处理（Go `ListResourceSegments`）。 */
export const MAX_SEGMENT_LIMIT = 200

/**
 * 本地单用户模式的隐式操作者 ID。
 *
 * 浏览器本地模式没有服务端账号体系，`reviewed_by` 一律保持 `null`（见
 * `infrastructure/indexeddb/types.ts` 的约定）；只有质量问题的
 * `decided_by` 需要一个非空「用户裁决」标记，用固定 1 表示本机用户。
 */
export const LOCAL_ACTOR_ID = 1

/** 搜索替换 apply 写入的历史类型。 */
export const REVISION_KIND_SEARCH_REPLACE = 'search_replace'
/** 搜索替换 undo 写入的反向历史类型。 */
export const REVISION_KIND_REVERSE = 'reverse'
/** 批量审校 / approve-all 写入的历史类型。 */
export const REVISION_KIND_REVIEW = 'review'

// ── 错误（路由层负责映射为 Problem 状态码） ──

/** 同一资源下 `segment_index` 重复且跨越页边界（HTTP 409 `duplicate_segment_index`）。 */
export class DuplicateSegmentIndexError extends Error {
  constructor(readonly resourceId: number) {
    super(
      '资源段落索引损坏：segment_index 存在重复，分页游标无法跨越该边界表达遍历位置，' +
        '其后的数据不可达。请重新导入或修复该资源的段落后再试',
    )
    this.name = 'DuplicateSegmentIndexError'
  }
}

/** 锚点段落不属于请求的 `group_key` 章节（后端 handler 映射为 400）。 */
export class SegmentGroupMismatchError extends Error {
  constructor() {
    super('锚点段落不属于指定的 group_key 章节')
    this.name = 'SegmentGroupMismatchError'
  }
}

/** 译文不是 well-formed XML 片段，无法嵌入导出文档（HTTP 400）。 */
export class SegmentMarkupInvalidError extends Error {
  constructor(detail: string | null) {
    super(
      detail === null
        ? '译文标签结构损坏，无法保存。请检查标签是否成对闭合。'
        : `译文标签结构损坏，无法保存：${detail}。请检查标签是否成对闭合。`,
    )
    this.name = 'SegmentMarkupInvalidError'
  }
}

/** 按 (code, matched_text) 定位不到质量问题（HTTP 404）。 */
export class SegmentIssueNotFoundError extends Error {
  constructor() {
    super('未找到匹配的质量问题')
    this.name = 'SegmentIssueNotFoundError'
  }
}

/** 撤销目标 operation 不存在或已被裁剪（HTTP 404）。 */
export class SearchReplaceOperationNotFoundError extends Error {
  constructor(readonly operationId: string) {
    super(`search-replace operation ${operationId} 不存在或已被裁剪`)
    this.name = 'SearchReplaceOperationNotFoundError'
  }
}

/** operation 的全部段落都已被后续编辑改变（HTTP 409）。 */
export class NoReversibleSegmentsError extends Error {
  constructor() {
    super('没有可撤销的段落：自该操作后全部段落都已被后续编辑改变')
    this.name = 'NoReversibleSegmentsError'
  }
}

// ── DTO / 选项类型 ──

/**
 * 段落响应 DTO。
 *
 * 与 `ApiSchemas['Segment']` 的差异：`sub_job_id`、`reviewed_by` 在本地模式没有
 * 对应数据（后端也是 `omitempty`），因此从类型里剔除、响应里不出现。
 */
export type SegmentDto = Omit<ApiSchemas['Segment'], 'sub_job_id' | 'reviewed_by'>

/** 一页段落。游标是「可再次传回的 segment_index 字符串」，不存在时为 `null`。 */
export interface SegmentPage {
  items: SegmentDto[]
  next_cursor: string | null
  prev_cursor: string | null
  total?: number
}

/** 列表过滤/窗口选项（字段语义对齐 Go `ResourceSegmentListOptions`）。 */
export interface SegmentListOptions {
  status?: string
  /** 搜索文本；`undefined`/空串表示不搜索（保留原文空白，不 trim）。 */
  search?: string
  matchMode?: string
  wholeWord?: boolean
  groupKey?: string
  qualityIssues?: string
  qualitySeverity?: string
  qualityCode?: string
  searchField?: string
  caseSensitive?: boolean
  includeTotal?: boolean
  /** 锚点段落 ID（数据库 ID）；与 cursor / direction=desc 互斥由路由层校验。 */
  anchorSegmentId?: number | null
  direction?: string
  cursor?: number
  /** 请求是否显式携带 cursor（区分 `cursor=0` 与未传游标）。 */
  hasCursor?: boolean
  limit?: number
}

/** 单段更新输入。 */
export interface SegmentUpdateInput {
  targetText?: string
  comment?: string
  /** 可选 CAS：与当前 content_version 不符时抛 `ConflictError`。 */
  expectedContentVersion?: number
}

/** 批量审校输入。 */
export interface BatchReviewInput {
  segmentIds: number[]
  action: string
  comment?: string
}

/** 质量问题裁决输入。 */
export interface IssueDispositionInput {
  code: string
  matchedText: string
  disposition: string
  note?: string
}

/** 搜索替换跳过原因（与 OpenAPI `SearchReplaceSkippedItemReason` 一致）。 */
export type SearchReplaceSkipReason =
  | 'no_longer_matches'
  | 'empty_result'
  | 'target_diverged'
  | 'invalid_markup'

/** 被跳过的段落。 */
export interface SearchReplaceSkip {
  segmentId: number
  reason: SearchReplaceSkipReason
}

/** 搜索替换选项（apply 只使用 find/replace/match/segmentIds，其余仅预览生效）。 */
export interface SearchReplaceOptions {
  find: string
  replaceWith: string
  matchMode?: string
  caseSensitive?: boolean
  wholeWord?: boolean
  maxResults?: number
  status?: string
  qualityIssues?: string
  qualitySeverity?: string
  qualityCode?: string
  groupKey?: string
  segmentIds?: number[]
}

/** 搜索替换预览样本。 */
export interface SearchReplacePreviewItem {
  segmentId: number
  segmentIndex: number
  sourceText: string
  before: string
  after: string
  matchCount: number
}

/** 搜索替换预览结果。 */
export interface SearchReplacePreviewResult {
  matchedSegmentCount: number
  totalReplacements: number
  items: SearchReplacePreviewItem[]
}

/** 搜索替换 apply 结果。 */
export interface SearchReplaceApplyOutcome {
  operationId: string
  applied: SegmentRow[]
  skipped: SearchReplaceSkip[]
}

/** 搜索替换 undo 结果。 */
export interface SearchReplaceUndoOutcome {
  undoOperationId: string
  undone: SegmentRow[]
  skipped: SearchReplaceSkip[]
}

/** 章节分组统计（对齐 `ResourceSegmentGroup`）。 */
export interface SegmentGroupDto {
  group_key: string
  group_title: string
  segment_count: number
  translated_count: number
  approved_count: number
}

// ── 行读取与 DTO 映射 ──

/** 段落行 → OpenAPI `Segment` DTO（`omitempty` 字段为空时不出现）。 */
export function toSegmentDto(row: SegmentRow): SegmentDto {
  const dto: SegmentDto = {
    id: row.localId,
    segment_index: row.segment_index,
    source_text: row.source_text,
    status: row.status,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
  if (row.target_text !== '') dto.target_text = row.target_text
  if (row.review_comment !== null && row.review_comment !== '') {
    dto.review_comment = row.review_comment
  }
  const issues = readIssues(row)
  if (issues.length > 0) {
    dto.quality_issues = issues.map((issue) => toQualityIssueDto(issue, row.segment_index))
  }
  const groupKey = segmentGroupKey(row)
  if (groupKey !== '') dto.group_key = groupKey
  return dto
}

/**
 * 段落分组键：优先 `meta.epub_file`（后端 `toSegmentResponse` / `segmentGroupKey`
 * 的唯一来源），回退到行上的 `group_key` 冗余列（解析器写入）。
 */
export function segmentGroupKey(row: SegmentRow): string {
  const meta = row.meta
  if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) {
    const value = (meta as Record<string, unknown>).epub_file
    if (typeof value === 'string' && value !== '') return value
  }
  return typeof row.group_key === 'string' ? row.group_key : ''
}

/** 章节标题：`meta.epub_chapter_title`（后端无书籍标题回退）。 */
function segmentGroupTitle(row: SegmentRow): string {
  const meta = row.meta
  if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) {
    const value = (meta as Record<string, unknown>).epub_chapter_title
    if (typeof value === 'string') return value
  }
  return ''
}

/** 读取行上的质量问题列表（保留原始对象形状，容忍 wire / row 两种编码）。 */
function readIssues(row: SegmentRow): Record<string, unknown>[] {
  const raw = row.quality_issues
  if (!Array.isArray(raw)) return []
  const out: Record<string, unknown>[] = []
  for (const item of raw) {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      out.push(item as unknown as Record<string, unknown>)
    }
  }
  return out
}

/** 读取问题的匹配文本（与 `qa.Fingerprint` 的 matched_text 分量一致）。 */
function issueMatchedText(raw: Record<string, unknown>): string {
  const span = raw.span
  if (span !== null && typeof span === 'object' && !Array.isArray(span)) {
    return asString((span as Record<string, unknown>).matched_text)
  }
  // 行形态（`QualityIssueRow`）：matched_text 落在 target_text / source_text。
  const target = raw.target_text
  if (typeof target === 'string') return target
  return asString(raw.source_text)
}

/** 问题指纹（Go `qa.Fingerprint` = `code + ":" + matched_text`）。 */
function issueFingerprint(raw: Record<string, unknown>): string {
  return `${asString(raw.code)}:${issueMatchedText(raw)}`
}

/** 存储态问题 → OpenAPI `QualityIssue` DTO。 */
function toQualityIssueDto(
  raw: Record<string, unknown>,
  fallbackIndex: number,
): ApiSchemas['QualityIssue'] {
  const dto: ApiSchemas['QualityIssue'] = {
    segment_index: asNumber(raw.segment_index) ?? fallbackIndex,
    severity: raw.severity === 'error' ? 'error' : 'warning',
    code: asString(raw.code),
    message: asString(raw.message),
    // disposition 缺失（旧数据）/任意非 dismissed 值一律视为 pending。
    disposition: raw.disposition === 'dismissed' ? 'dismissed' : 'pending',
  }

  const span = raw.span
  if (span !== null && typeof span === 'object' && !Array.isArray(span)) {
    const wire = span as Record<string, unknown>
    const built: NonNullable<ApiSchemas['QualityIssue']['span']> = {
      matched_text: asString(wire.matched_text),
    }
    const start = asNumber(wire.target_start)
    if (start !== undefined) built.target_start = start
    const end = asNumber(wire.target_end)
    if (end !== undefined) built.target_end = end
    dto.span = built
  } else {
    const matched = issueMatchedText(raw)
    if (matched !== '') {
      const built: NonNullable<ApiSchemas['QualityIssue']['span']> = { matched_text: matched }
      const start = asNumber(raw.start)
      if (start !== undefined) built.target_start = start
      const end = asNumber(raw.end)
      if (end !== undefined) built.target_end = end
      dto.span = built
    }
  }

  const decidedBy = asNumber(raw.decided_by)
  if (decidedBy !== undefined) dto.decided_by = decidedBy
  if (typeof raw.decided_at === 'string') dto.decided_at = raw.decided_at
  const note = typeof raw.note === 'string' ? raw.note : asString(raw.disposition_comment)
  if (note !== '') dto.note = note
  return dto
}

/** 问题是否仍「待处理」：只排除显式 `dismissed`（对齐 `qa.NeedsAction`）。 */
function isPendingIssue(raw: Record<string, unknown>): boolean {
  return raw.disposition !== 'dismissed'
}

// ── 列表：过滤条件 F ──

interface SegmentFilter {
  status: string
  matcher: SearchMatcher | null
  searchField: string
  groupKey: string
  qualityIssues: string
  qualitySeverity: string
  qualityCode: string
}

/** 单行是否满足完整过滤条件 F（status + quality + group_key + search）。 */
function matchesFilter(row: SegmentRow, filter: SegmentFilter): boolean {
  if (filter.status !== '' && String(row.status) !== filter.status) return false
  if (!matchesQualityFilter(readIssues(row), filter)) return false
  if (filter.groupKey !== '' && segmentGroupKey(row) !== filter.groupKey) return false
  if (filter.matcher !== null && !matchesSearch(row, filter.matcher, filter.searchField)) {
    return false
  }
  return true
}

/**
 * 质量三维过滤。非法枚举值安全降级为不过滤；三个维度都只统计 pending 问题
 * （`dismissed` 已被用户驳回，不算问题；disposition 缺失视为 pending）。
 */
function matchesQualityFilter(issues: Record<string, unknown>[], filter: SegmentFilter): boolean {
  const needsPending =
    filter.qualityIssues !== '' || filter.qualitySeverity !== '' || filter.qualityCode !== ''
  if (!needsPending) return true
  const pending = issues.filter(isPendingIssue)
  if (filter.qualityIssues === 'has' && pending.length === 0) return false
  if (filter.qualityIssues === 'none' && pending.length > 0) return false
  if (
    (filter.qualitySeverity === 'warning' || filter.qualitySeverity === 'error') &&
    !pending.some((issue) => issue.severity === filter.qualitySeverity)
  ) {
    return false
  }
  if (
    filter.qualityCode !== '' &&
    isFilterableIssueCode(filter.qualityCode) &&
    !pending.some((issue) => issue.code === filter.qualityCode)
  ) {
    return false
  }
  return true
}

/** 单段搜索命中：target 为空（本地用空串表示后端 nil）时不命中。 */
function matchesSearch(row: SegmentRow, matcher: SearchMatcher, field: string): boolean {
  switch (field) {
    case 'source':
      return matcher.hasMatch(row.source_text)
    case 'target':
      return row.target_text !== '' && matcher.hasMatch(row.target_text)
    default: // '' / 'both'
      return (
        matcher.hasMatch(row.source_text) ||
        (row.target_text !== '' && matcher.hasMatch(row.target_text))
      )
  }
}

// ── 列表：窗口分页 ──

/**
 * 列出资源段落（窗口分页）。
 *
 * 统一扫描实现：先按 `(segment_index, localId)` 升序取出资源内全部未删除段落，
 * 再用完整过滤条件 F 过滤，最后在**匹配序列**上取窗口。结果与后端 SQL / 扫描
 * 两条路径等价（见文件头注释）。
 *
 * 复杂度是每次请求 O(资源段落数)：搜索用 SimpleFold 折叠 + KMP / RE2，无法下推
 * 到 IndexedDB 索引；这与后端「有 search 或 group_key 即走扫描路径」的取舍一致，
 * 浏览器本地单资源规模下（万级段落）足够。
 */
export async function listResourceSegments(
  db: LinguaFlowDatabase,
  projectId: number,
  resourceId: number,
  options: SegmentListOptions = {},
): Promise<SegmentPage> {
  await requireSegmentResource(db, projectId, resourceId)

  const limit = normalizeLimit(options.limit)
  // 非空 search 的构建失败（regex 不可编译 / match mode 不支持 / 过长）在此上抛，
  // 由路由层映射 400；空 search 不建 matcher。
  const matcher =
    options.search === undefined || options.search === ''
      ? null
      : createSearchMatcher({
          find: options.search,
          matchMode: normalizeMatchMode(options.matchMode),
          caseSensitive: options.caseSensitive ?? true,
          wholeWord: options.wholeWord ?? false,
        })

  const groupKey = options.groupKey ?? ''
  let anchorIndex = 0
  if (options.anchorSegmentId !== undefined && options.anchorSegmentId !== null) {
    const anchor = await db.segments.where('localId').equals(options.anchorSegmentId).first()
    if (!anchor || anchor.resource_id !== resourceId || anchor.deletedAt !== null) {
      throw new RepositoryNotFoundError('段落', options.anchorSegmentId)
    }
    // 锚点本身不要求满足筛选条件，但 group_key 过滤时锚点必须同属该章节，
    // 否则它在筛选序列里没有位置，窗口起点无意义。
    if (groupKey !== '' && segmentGroupKey(anchor) !== groupKey) {
      throw new SegmentGroupMismatchError()
    }
    anchorIndex = anchor.segment_index
  }

  const cursor = options.cursor ?? 0
  const cursorRequested = options.hasCursor === true || cursor > 0
  // desc 无游标仍按升序首页返回。
  const descWindow =
    options.direction === 'desc' &&
    cursorRequested &&
    (options.anchorSegmentId === undefined || options.anchorSegmentId === null)

  const filter: SegmentFilter = {
    status: options.status ?? '',
    matcher,
    searchField: options.searchField ?? '',
    groupKey,
    qualityIssues: options.qualityIssues ?? '',
    qualitySeverity: options.qualitySeverity ?? '',
    qualityCode: options.qualityCode ?? '',
  }

  const rows = await loadResourceSegments(db, resourceId)
  const matches = rows.filter((row) => matchesFilter(row, filter))

  const pageRows = descWindow
    ? collectDescWindow(matches, cursor, limit, resourceId)
    : collectAscWindow(
        matches,
        options.anchorSegmentId ?? null,
        anchorIndex,
        cursorRequested,
        cursor,
        limit,
        resourceId,
      )

  const first = pageRows[0]
  const last = pageRows[pageRows.length - 1]
  let prevCursor: number | null = null
  let nextCursor: number | null = null
  if (first !== undefined && last !== undefined) {
    // 邻接性用完整过滤条件 F 的存在性判断；不复用已叠加窗口 / limit 的集合。
    if (matches.some((row) => row.segment_index < first.segment_index)) {
      prevCursor = first.segment_index
    }
    if (matches.some((row) => row.segment_index > last.segment_index)) {
      nextCursor = last.segment_index
    }
  }

  const page: SegmentPage = {
    items: pageRows.map(toSegmentDto),
    next_cursor: nextCursor === null ? null : String(nextCursor),
    prev_cursor: prevCursor === null ? null : String(prevCursor),
  }
  if (options.includeTotal === true) page.total = matches.length
  return page
}

/** 升序窗口：取 `limit+1` 条并做页边界重复检测。 */
function collectAscWindow(
  matches: readonly SegmentRow[],
  anchorSegmentId: number | null,
  anchorIndex: number,
  cursorRequested: boolean,
  cursor: number,
  limit: number,
  resourceId: number,
): SegmentRow[] {
  let windowed: readonly SegmentRow[]
  if (anchorSegmentId !== null) {
    // 锚点窗口：index >= anchorIndex（锚点本身不要求匹配）。
    windowed = matches.filter((row) => row.segment_index >= anchorIndex)
  } else if (cursorRequested) {
    windowed = matches.filter((row) => row.segment_index > cursor)
  } else {
    windowed = matches
  }

  const fetched = windowed.slice(0, limit + 1)
  const overflow = fetched[limit]
  const boundary = fetched[limit - 1]
  if (
    overflow !== undefined &&
    boundary !== undefined &&
    overflow.segment_index === boundary.segment_index
  ) {
    throw new DuplicateSegmentIndexError(resourceId)
  }
  return fetched.slice(0, limit)
}

/** 降序窗口：取 `index < cursor` 的最后 `limit+1` 条，截断后已是升序。 */
function collectDescWindow(
  matches: readonly SegmentRow[],
  cursor: number,
  limit: number,
  resourceId: number,
): SegmentRow[] {
  const below = matches.filter((row) => row.segment_index < cursor)
  const start = Math.max(0, below.length - (limit + 1))
  const fetched = below.slice(start) // 升序
  // fetched[0] 是被丢弃的第 limit+1 行（最低 index），fetched[1] 是页内边界行。
  const overflow = fetched[0]
  const boundary = fetched[1]
  if (fetched.length > limit && overflow !== undefined && boundary !== undefined) {
    if (overflow.segment_index === boundary.segment_index) {
      throw new DuplicateSegmentIndexError(resourceId)
    }
  }
  return fetched.slice(-limit)
}

/** 读取资源内全部未删除段落，按 `(segment_index, localId)` 升序。 */
async function loadResourceSegments(
  db: LinguaFlowDatabase,
  resourceId: number,
): Promise<SegmentRow[]> {
  const rows = await db.segments
    .where('resource_id')
    .equals(resourceId)
    .filter((row) => row.deletedAt === null)
    .toArray()
  rows.sort(compareSegmentRows)
  return rows
}

/** 后端 `ORDER BY segment_index, id` 的等价比较。 */
function compareSegmentRows(left: SegmentRow, right: SegmentRow): number {
  if (left.segment_index !== right.segment_index) return left.segment_index - right.segment_index
  return left.localId - right.localId
}

/** 分页条数规范化（对齐 Go：非正数或超上限 → 50）。 */
function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_SEGMENT_LIMIT
  const value = Math.floor(limit)
  if (value <= 0 || value > MAX_SEGMENT_LIMIT) return DEFAULT_SEGMENT_LIMIT
  return value
}

/** 匹配模式规范化：空值 → substring（非法值交给 matcher 抛 `SearchError`）。 */
function normalizeMatchMode(mode: string | undefined): SearchMatchMode {
  if (mode === undefined || mode === '') return 'substring'
  return mode as SearchMatchMode
}

// ── 单段更新（CAS） ──

/**
 * 更新单段（审校）：target_text / review_comment。
 *
 * 事务内：推进资源翻译代际 → 读取段落 → 可选 CAS（expected_content_version）
 * → 写入（content_version +1）。`target_text` 为空或译文结构非法时 400。
 */
export async function updateResourceSegment(
  db: LinguaFlowDatabase,
  projectId: number,
  resourceId: number,
  segmentId: number,
  input: SegmentUpdateInput,
): Promise<SegmentRow> {
  const deviceId = await getDeviceId(db)
  return db.transaction('rw', db.projects, db.resources, db.segments, async () => {
    const resource = await requireSegmentResource(db, projectId, resourceId)
    await advanceTranslationGeneration(db, resource)

    const current = await findSegmentRow(db, resourceId, segmentId)
    if (!current) throw new RepositoryNotFoundError('段落', segmentId)

    if (
      input.expectedContentVersion !== undefined &&
      current.content_version !== input.expectedContentVersion
    ) {
      throw new ConflictError(
        'segment',
        current.localId,
        input.expectedContentVersion,
        current.content_version,
      )
    }

    const patch: Partial<SegmentRow> = {}
    let changed = false
    if (input.targetText !== undefined) {
      const target = goTrimSpace(input.targetText)
      if (target === '') throw new RepositoryValidationError('target_text 不能为空')
      // 结构守卫只施加于 renderer 会把译文原样嵌入 XML 文档的格式（当前仅 epub）。
      if (requiresWellFormedTargets(resource.format)) {
        const detail = validateFragment(target)
        if (detail !== null) throw new SegmentMarkupInvalidError(detail)
      }
      patch.target_text = target
      patch.target_lower = goToLower(target)
      patch.status = 'edited'
      // 本地模式没有用户身份，审核人保持 null（见 LOCAL_ACTOR_ID 注释）。
      patch.reviewed_by = null
      changed = true
    }
    if (input.comment !== undefined) {
      const comment = goTrimSpace(input.comment)
      patch.review_comment = comment === '' ? null : comment
      changed = true
    }
    if (!changed) {
      throw new RepositoryValidationError('至少需要提供 target_text 或 comment')
    }

    // 仅 comment 变更时不触碰 quality_issues（对齐后端 switch）。
    const next = applyContentChange(current, patch)
    await db.segments.put(next)
    return next
  })
}

// ── 批量审校 / approve-all ──

/**
 * 批量审核段落（approve / reject）。
 *
 * 校验：`segment_ids` 非空、action 合法、所有 ID 都属于该资源（否则 404，且
 * 与 Go 一样按**请求长度**比较，重复 ID 会因行数不足而 404）。状态不允许时
 * 静默跳过该段，但响应仍包含全部被请求的段落（对齐后端返回查询）。
 */
export async function batchReviewSegments(
  db: LinguaFlowDatabase,
  projectId: number,
  resourceId: number,
  input: BatchReviewInput,
): Promise<SegmentRow[]> {
  if (input.segmentIds.length === 0) {
    throw new RepositoryValidationError('segment_ids 不能为空')
  }
  if (input.action !== 'approve' && input.action !== 'reject') {
    throw new RepositoryValidationError('action 必须是 approve 或 reject')
  }
  const targetStatus: SegmentStatus = input.action === 'approve' ? 'approved' : 'rejected'
  const comment = goTrimSpace(input.comment ?? '')
  const deviceId = await getDeviceId(db)

  return db.transaction(
    'rw',
    db.projects,
    db.resources,
    db.segments,
    db.segment_revisions,
    db.sequences,
    async () => {
      const resource = await requireSegmentResource(db, projectId, resourceId)
      await advanceTranslationGeneration(db, resource)

      const rows = await loadSegmentsByIds(db, resourceId, input.segmentIds)
      if (rows.length !== input.segmentIds.length) {
        throw new RepositoryNotFoundError('段落', input.segmentIds.join(','))
      }

      const operationId = newOperationId('rv-')
      const updatedById = new Map<number, SegmentRow>()
      for (const row of rows) {
        const allowed =
          input.action === 'approve'
            ? row.status === 'translated' || row.status === 'edited' || row.status === 'rejected'
            : row.status === 'translated' || row.status === 'edited'
        if (!allowed) continue
        const next = applyContentChange(row, {
          status: targetStatus,
          review_comment: comment === '' ? null : comment,
          reviewed_by: null,
        })
        await db.segments.put(next)
        await appendRevision(db, deviceId, {
          segment: next,
          projectId,
          resourceId,
          before: snapshotOf(row),
          after: snapshotOf(next),
          operationId,
          kind: REVISION_KIND_REVIEW,
        })
        updatedById.set(row.localId, next)
      }

      // 响应包含全部被请求的段落（含状态不允许而未被改动的），按 index 升序。
      return rows
        .map((row) => updatedById.get(row.localId) ?? row)
        .sort((left, right) => left.segment_index - right.segment_index)
    },
  )
}

/**
 * 批准资源中所有已翻译 / 已编辑 / 已拒绝的段落；返回实际批准数量。
 * 清空审核备注（对齐后端 `ClearReviewComment`）。
 */
export async function approveAllResourceSegments(
  db: LinguaFlowDatabase,
  projectId: number,
  resourceId: number,
): Promise<number> {
  const deviceId = await getDeviceId(db)
  return db.transaction(
    'rw',
    db.projects,
    db.resources,
    db.segments,
    db.segment_revisions,
    db.sequences,
    async () => {
      const resource = await requireSegmentResource(db, projectId, resourceId)
      await advanceTranslationGeneration(db, resource)

      const rows = await loadResourceSegments(db, resourceId)
      const operationId = newOperationId('rv-')
      let count = 0
      for (const row of rows) {
        if (row.status !== 'translated' && row.status !== 'edited' && row.status !== 'rejected') {
          continue
        }
        const next = applyContentChange(row, {
          status: 'approved',
          review_comment: null,
          reviewed_by: null,
        })
        await db.segments.put(next)
        await appendRevision(db, deviceId, {
          segment: next,
          projectId,
          resourceId,
          before: snapshotOf(row),
          after: snapshotOf(next),
          operationId,
          kind: REVISION_KIND_REVIEW,
        })
        count++
      }
      return count
    },
  )
}

// ── 质量问题裁决 ──

/**
 * 对单条质量问题下裁决（`dismissed`）或撤销裁决（`pending`）。
 *
 * 事务内读改写整列 `quality_issues`，避免与其它写者 last-writer-wins 丢裁决。
 * 目标 issue 由 `(code, matched_text)` 指纹定位（与 `qa.Fingerprint` 一致）。
 */
export async function setSegmentIssueDisposition(
  db: LinguaFlowDatabase,
  projectId: number,
  resourceId: number,
  segmentId: number,
  input: IssueDispositionInput,
): Promise<SegmentRow> {
  if (input.disposition !== 'pending' && input.disposition !== 'dismissed') {
    throw new RepositoryValidationError('disposition 必须是 pending 或 dismissed')
  }
  return db.transaction('rw', db.projects, db.resources, db.segments, async () => {
    const resource = await requireSegmentResource(db, projectId, resourceId)
    await advanceTranslationGeneration(db, resource)

    const row = await findSegmentRow(db, resourceId, segmentId)
    if (!row) throw new RepositoryNotFoundError('段落', segmentId)

    const issues = readIssues(row)
    const target = `${input.code}:${input.matchedText}`
    const index = issues.findIndex((issue) => issueFingerprint(issue) === target)
    if (index < 0) throw new SegmentIssueNotFoundError()

    const issue: Record<string, unknown> = { ...(issues[index] as Record<string, unknown>) }
    if (input.disposition === 'dismissed') {
      issue.disposition = 'dismissed'
      issue.decided_by = LOCAL_ACTOR_ID
      issue.decided_at = nowIso()
      if (input.note !== undefined && input.note !== '') issue.note = input.note
      else delete issue.note
    } else {
      // 撤销裁决：改回未决，清空裁决者 / 时间 / 说明。
      issue.disposition = 'pending'
      delete issue.decided_by
      delete issue.decided_at
      delete issue.note
    }
    delete issue.disposition_comment
    issues[index] = issue

    const next = applyContentChange(row, {
      quality_issues: issues as unknown as QualityIssueRow[],
    })
    await db.segments.put(next)
    return next
  })
}

// ── 搜索替换：preview / apply / undo ──

/**
 * 搜索替换预览（dry-run，不写库）。
 *
 * 只对 `target_text` 匹配；空译文不参与。替换结果结构非法的段落与 apply 一样
 * 直接跳过（否则预览展示会改、实际却被跳过）。
 * `segment_ids` 非空时限定范围；status / quality / group_key 仅预览生效。
 */
export async function previewSearchReplace(
  db: LinguaFlowDatabase,
  projectId: number,
  resourceId: number,
  options: SearchReplaceOptions,
): Promise<SearchReplacePreviewResult> {
  const resource = await requireSegmentResource(db, projectId, resourceId)
  if (goTrimSpace(options.find) === '') {
    throw new RepositoryValidationError('find 不能为空')
  }
  const matcher = createMatcher(options)
  const maxResults = normalizeMaxResults(options.maxResults)

  let rows = await loadResourceSegments(db, resourceId)
  if (options.segmentIds !== undefined && options.segmentIds.length > 0) {
    const scope = new Set(options.segmentIds)
    rows = rows.filter((row) => scope.has(row.localId))
  }
  if (options.status !== undefined && options.status !== '') {
    rows = rows.filter((row) => String(row.status) === options.status)
  }
  rows = rows.filter((row) =>
    matchesQualityFilter(readIssues(row), {
      status: '',
      matcher: null,
      searchField: '',
      groupKey: '',
      qualityIssues: options.qualityIssues ?? '',
      qualitySeverity: options.qualitySeverity ?? '',
      qualityCode: options.qualityCode ?? '',
    }),
  )
  if (options.groupKey !== undefined && options.groupKey !== '') {
    rows = rows.filter((row) => segmentGroupKey(row) === options.groupKey)
  }

  const result: SearchReplacePreviewResult = {
    matchedSegmentCount: 0,
    totalReplacements: 0,
    items: [],
  }
  for (const row of rows) {
    if (row.target_text === '') continue
    const matches = matcher.find(row.target_text)
    if (matches.length === 0) continue
    const after = matcher.replaceAll(row.target_text, options.replaceWith).text
    if (replaceResultMarkupInvalid(resource.format, after)) continue
    result.matchedSegmentCount++
    result.totalReplacements += matches.length
    if (result.items.length < maxResults) {
      result.items.push({
        segmentId: row.localId,
        segmentIndex: row.segment_index,
        sourceText: row.source_text,
        before: row.target_text,
        after,
        matchCount: matches.length,
      })
    }
  }
  return result
}

/**
 * 应用搜索替换。
 *
 * 单个 Dexie 事务内完成：推进代际 → 逐段按**当前**译文重新匹配 → 替换 →
 * content_version +1 → 写 `segment_revisions`（before/after + operation_id）。
 * apply 不应用 status / quality / group_key 过滤（范围只由 segment_ids 决定）；
 * 与后端一致，范围内「当前已不含匹配」的段落会以 `no_longer_matches` 进入
 * skipped，而不是被静默忽略。
 */
export async function applySearchReplace(
  db: LinguaFlowDatabase,
  projectId: number,
  resourceId: number,
  options: SearchReplaceOptions,
): Promise<SearchReplaceApplyOutcome> {
  if (goTrimSpace(options.find) === '') {
    throw new RepositoryValidationError('find 不能为空')
  }
  const matcher = createMatcher(options)
  const deviceId = await getDeviceId(db)

  return db.transaction(
    'rw',
    db.projects,
    db.resources,
    db.segments,
    db.segment_revisions,
    db.sequences,
    async () => {
      const resource = await requireSegmentResource(db, projectId, resourceId)
      await advanceTranslationGeneration(db, resource)

      let candidates = await loadResourceSegments(db, resourceId)
      if (options.segmentIds !== undefined && options.segmentIds.length > 0) {
        const scope = new Set(options.segmentIds)
        candidates = candidates.filter((row) => scope.has(row.localId))
      }

      const operationId = newOperationId('sr-')
      const skipped: SearchReplaceSkip[] = []
      const pending: { row: SegmentRow; target: string }[] = []

      // 第一遍：分流跳过与待应用（在事务内基于当前译文重新匹配）。
      for (const row of candidates) {
        if (row.target_text === '') continue
        if (matcher.find(row.target_text).length === 0) {
          skipped.push({ segmentId: row.localId, reason: 'no_longer_matches' })
          continue
        }
        const target = matcher.replaceAll(row.target_text, options.replaceWith).text
        if (goTrimSpace(target) === '') {
          skipped.push({ segmentId: row.localId, reason: 'empty_result' })
          continue
        }
        if (replaceResultMarkupInvalid(resource.format, target)) {
          skipped.push({ segmentId: row.localId, reason: 'invalid_markup' })
          continue
        }
        pending.push({ row, target })
      }

      // 第二遍：逐段更新 + 写历史快照。
      const applied: SegmentRow[] = []
      for (const item of pending) {
        const next = applyContentChange(item.row, {
          target_text: item.target,
          target_lower: goToLower(item.target),
          status: 'edited',
          reviewed_by: null,
        })
        await db.segments.put(next)
        await appendRevision(db, deviceId, {
          segment: next,
          projectId,
          resourceId,
          before: snapshotOf(item.row),
          after: snapshotOf(next),
          operationId,
          kind: REVISION_KIND_SEARCH_REPLACE,
        })
        applied.push(next)
      }

      return { operationId, applied, skipped }
    },
  )
}

/**
 * 撤销一笔搜索替换（或撤销一笔先前的撤销，即重做）。
 *
 * 按 operation_id 载入快照，逐段乐观校验当前值仍等于快照 `after`，一致才把
 * `before` 原样写回（逐字节相同）。撤销自身写入一条 `reverse` 历史并使用新的
 * undoOperationId，因此可再撤销。全部段落发散 → 409；operation 不存在 → 404。
 */
export async function undoSearchReplace(
  db: LinguaFlowDatabase,
  projectId: number,
  resourceId: number,
  operationId: string,
): Promise<SearchReplaceUndoOutcome> {
  if (goTrimSpace(operationId) === '') {
    throw new RepositoryValidationError('operationId 不能为空')
  }
  const deviceId = await getDeviceId(db)

  return db.transaction(
    'rw',
    db.projects,
    db.resources,
    db.segments,
    db.segment_revisions,
    db.sequences,
    async () => {
      const resource = await requireSegmentResource(db, projectId, resourceId)

      const revisions = await db.segment_revisions
        .where('operation_id')
        .equals(operationId)
        .toArray()
      const scoped = revisions
        .filter((revision) => revision.resource_id === resourceId)
        .sort((left, right) => left.localId - right.localId)
      if (scoped.length === 0) {
        throw new SearchReplaceOperationNotFoundError(operationId)
      }

      await advanceTranslationGeneration(db, resource)

      const undoOperationId = newOperationId('sr-u-')
      const skipped: SearchReplaceSkip[] = []
      const undone: SegmentRow[] = []

      for (const revision of scoped) {
        const current = await db.segments.where('localId').equals(revision.segment_id).first()
        if (!current || current.resource_id !== resourceId || current.deletedAt !== null) {
          // 段落已被删除：无法安全回滚，跳过。
          skipped.push({ segmentId: revision.segment_id, reason: 'target_diverged' })
          continue
        }
        if (!segmentMatchesSnapshot(current, revision.after)) {
          skipped.push({ segmentId: current.localId, reason: 'target_diverged' })
          continue
        }

        // 恢复 before 快照；content_version 只增不减（undo 绝不回退版本）。
        const restored: SegmentRow = touch(
          {
            ...current,
            target_text: revision.before.target_text,
            target_lower: goToLower(revision.before.target_text),
            status: revision.before.status,
            review_comment: revision.before.review_comment,
            quality_issues: cloneJson(revision.before.quality_issues),
            content_version: current.content_version + 1,
          },
          current.deviceId,
        )
        await db.segments.put(restored)
        await appendRevision(db, deviceId, {
          segment: restored,
          projectId,
          resourceId,
          before: snapshotOf(current),
          after: snapshotOf(restored),
          operationId: undoOperationId,
          kind: REVISION_KIND_REVERSE,
        })
        undone.push(restored)
      }

      if (undone.length === 0) throw new NoReversibleSegmentsError()
      return { undoOperationId, undone, skipped }
    },
  )
}

/**
 * 段落当前状态是否仍与快照一致（Go `segmentMatchesRevision`）。
 *
 * 比较 target_text / status / review_comment / quality_issues 四个被替换改动的
 * 字段；快照没有 reviewed_by 列，故不比较审核人（见文件头「已知差异」）。
 */
function segmentMatchesSnapshot(row: SegmentRow, snapshot: SegmentSnapshot): boolean {
  return (
    row.target_text === snapshot.target_text &&
    row.status === snapshot.status &&
    row.review_comment === snapshot.review_comment &&
    deepEqualJson(row.quality_issues, snapshot.quality_issues)
  )
}

/** 替换结果在需要 well-formed 译文的格式下是否结构非法。 */
function replaceResultMarkupInvalid(format: string, target: string): boolean {
  return requiresWellFormedTargets(format) && validateFragment(target) !== null
}

/** 预览样本上限：默认 20，夹紧到 [1, 100]（Go `PreviewSearchReplace`）。 */
function normalizeMaxResults(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 20
  const size = Math.floor(value)
  if (size < 1) return 1
  if (size > 100) return 100
  return size
}

/** 搜索替换匹配器（语义与列表搜索一致：默认大小写敏感、不整词）。 */
function createMatcher(options: SearchReplaceOptions): SearchMatcher {
  return createSearchMatcher({
    find: options.find,
    matchMode: normalizeMatchMode(options.matchMode),
    caseSensitive: options.caseSensitive ?? true,
    wholeWord: options.wholeWord ?? false,
  })
}

// ── 章节分组 ──

/**
 * 按 `meta.epub_file` 把段落归为章节组，返回每组的统计信息。
 *
 * 分组顺序按组内最小 `segment_index`（保持 spine 顺序）；组标题取
 * `meta.epub_chapter_title`，缺失时回退为 group_key（对齐后端）。
 */
export async function listResourceSegmentGroups(
  db: LinguaFlowDatabase,
  projectId: number,
  resourceId: number,
): Promise<SegmentGroupDto[]> {
  await requireSegmentResource(db, projectId, resourceId)
  const rows = await loadResourceSegments(db, resourceId)

  interface GroupEntry {
    groupKey: string
    groupTitle: string
    minIndex: number
    count: number
    translated: number
    approved: number
  }
  const groups = new Map<string, GroupEntry>()
  const order: string[] = []

  for (const row of rows) {
    const groupKey = segmentGroupKey(row)
    const title = segmentGroupTitle(row)
    let group = groups.get(groupKey)
    if (group === undefined) {
      group = {
        groupKey,
        groupTitle: title === '' ? groupKey : title,
        minIndex: row.segment_index,
        count: 0,
        translated: 0,
        approved: 0,
      }
      groups.set(groupKey, group)
      order.push(groupKey)
    }
    group.count++
    if (row.status === 'translated' || row.status === 'edited' || row.status === 'approved') {
      group.translated++
    }
    if (row.status === 'approved') group.approved++
  }

  return order
    .map((key) => groups.get(key) as GroupEntry)
    .sort((left, right) => left.minIndex - right.minIndex)
    .map((group) => ({
      group_key: group.groupKey,
      group_title: group.groupTitle,
      segment_count: group.count,
      translated_count: group.translated,
      approved_count: group.approved,
    }))
}

// ── 内部：事务与代际 ──

/** 校验项目与资源（404 语义）；供事务内复用。 */
async function requireSegmentResource(
  db: LinguaFlowDatabase,
  projectId: number,
  resourceId: number,
): Promise<ResourceRow> {
  await requireProject(db, projectId)
  const resource = await getResource(db, projectId, resourceId)
  if (!resource) throw new RepositoryNotFoundError('资源', resourceId)
  return resource
}

/** 按数据库 ID 读取本资源下的未删除段落。 */
async function findSegmentRow(
  db: LinguaFlowDatabase,
  resourceId: number,
  segmentId: number,
): Promise<SegmentRow | undefined> {
  const row = await db.segments.where('localId').equals(segmentId).first()
  if (!row || row.resource_id !== resourceId || row.deletedAt !== null) return undefined
  return row
}

/** 批量读取本资源下的未删除段落（含重复 ID 只返回一行）。 */
async function loadSegmentsByIds(
  db: LinguaFlowDatabase,
  resourceId: number,
  segmentIds: readonly number[],
): Promise<SegmentRow[]> {
  if (segmentIds.length === 0) return []
  const rows = await db.segments
    .where('localId')
    .anyOf([...segmentIds])
    .toArray()
  const filtered = rows.filter((row) => row.resource_id === resourceId && row.deletedAt === null)
  filtered.sort(compareSegmentRows)
  return filtered
}

/**
 * 推进资源翻译代际（Go `AdvanceTranslationGeneration`）。
 *
 * 以请求开始时的 `source_generation` 为期望值做 CAS 更新：资源原文代际已变
 * （重新解析 / 换源）时抛 409，要求调用方重新加载。`translation_generation`
 * 只增不减；失败由外层事务整体回滚。
 */
async function advanceTranslationGeneration(
  db: LinguaFlowDatabase,
  expected: ResourceRow,
): Promise<void> {
  const current = await db.resources.where('localId').equals(expected.localId).first()
  if (!current || current.deletedAt !== null) {
    throw new RepositoryNotFoundError('资源', expected.localId)
  }
  if (current.source_generation !== expected.source_generation) {
    throw new RepositoryConflictError('资源原文代际已变更，请重新加载后再试')
  }
  await db.resources.put(
    touch(
      { ...current, translation_generation: current.translation_generation + 1 },
      current.deviceId,
    ),
  )
}

/** 内容变更：content_version +1，并维护 revision / updatedAt（ent hook 语义）。 */
function applyContentChange(row: SegmentRow, patch: Partial<SegmentRow>): SegmentRow {
  return touch({ ...row, ...patch, content_version: row.content_version + 1 }, row.deviceId)
}

/** 段落快照（撤销历史用，深拷贝 issues 防止共享引用）。 */
function snapshotOf(row: SegmentRow): SegmentSnapshot {
  return {
    source_text: row.source_text,
    target_text: row.target_text,
    status: row.status,
    review_comment: row.review_comment,
    quality_issues: cloneJson(row.quality_issues),
    content_version: row.content_version,
  }
}

/** 追加一条段落修订历史。 */
async function appendRevision(
  db: LinguaFlowDatabase,
  deviceId: string,
  options: {
    segment: SegmentRow
    projectId: number
    resourceId: number
    before: SegmentSnapshot
    after: SegmentSnapshot
    operationId: string
    kind: string
  },
): Promise<void> {
  const revision = await newRow<Omit<SegmentRevisionRow, keyof BaseRow>>(db, {
    sequence: 'segment_revision',
    deviceId,
    fields: {
      segment_id: options.segment.localId,
      project_id: options.projectId,
      resource_id: options.resourceId,
      before: options.before,
      after: options.after,
      operation_id: options.operationId,
      kind: options.kind,
    },
  })
  await db.segment_revisions.put(revision)
}

/** 生成带前缀的 operation 标识（32 位十六进制，形状对齐后端 `newOperationID`）。 */
export function newOperationId(prefix: string): string {
  return `${prefix}${newId().replaceAll('-', '')}`
}

// ── 内部：小工具 ──

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** JSON 深拷贝（issues / 快照都是纯 JSON 数据）。 */
function cloneJson<T>(value: T): T {
  if (value === null || value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

/** 结构相等（对象键顺序不敏感），用于快照乐观校验。 */
function deepEqualJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null || left === undefined || right === undefined) {
    return left === right
  }
  if (typeof left !== typeof right) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    if (left.length !== right.length) return false
    return left.every((item, index) => deepEqualJson(item, right[index]))
  }
  if (typeof left === 'object') {
    const a = left as Record<string, unknown>
    const b = right as Record<string, unknown>
    const keys = Object.keys(a)
    if (keys.length !== Object.keys(b).length) return false
    return keys.every(
      (key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqualJson(a[key], b[key]),
    )
  }
  return false
}
