/**
 * 段落端点（对齐 OpenAPI `/projects/{projectId}/resources/{resourceId}/segments...`）。
 *
 * | 方法 | 路径 | 响应 |
 * |---|---|---|
 * | GET | `.../segments` | `ResourceSegmentListResponse` |
 * | GET | `.../segments/groups` | `{ items: ResourceSegmentGroup[] }` |
 * | PATCH | `.../segments/{segmentId}` | `Segment` |
 * | POST | `.../segments/batch-review` | `{ items: Segment[] }` |
 * | POST | `.../segments/approve-all` | `{ approved_count }` |
 * | POST | `.../segments/{segmentId}/issues/disposition` | `Segment` |
 * | POST | `.../segments/search-replace/preview` | 预览统计 + 样本 |
 * | POST | `.../segments/search-replace/apply` | `operation_id` + items/skipped |
 * | POST | `.../segments/search-replace/{operationId}/undo` | `undo_operation_id` + items/skipped |
 *
 * 路径模板逐字取自 `src/api/*.ts` 的 `client.GET/POST/PATCH` 调用，`LocalRouter`
 * 按模板精确匹配（路径参数在 `options.params.path` 里）。
 *
 * 状态码对齐后端 handler：
 *
 * | 情形 | 状态 / code |
 * |---|---|
 * | 路径参数、limit、cursor、direction、match_mode、anchor 组合非法 | 400 `invalid_query_parameter` |
 * | 译文标签结构非法 | 400 `invalid_target_markup` |
 * | 提交 `source_text` | 400 `source_read_only` |
 * | 段落 / 资源 / 项目 / operation 不存在 | 404 |
 * | 质量问题未命中 | 404 `issue_not_found` |
 * | `segment_index` 重复跨越页边界 | 409 `duplicate_segment_index` |
 * | 撤销时全部段落发散 | 409 `no_reversible_segments` |
 * | CAS / 唯一约束 / 源代际冲突 | 409 `conflict` |
 */
import type { GatewayResult } from '@/gateway/contracts'
import { SearchError } from '@/domain/search'

import { RepositoryValidationError } from '../repositories/errors'
import {
  DEFAULT_SEGMENT_LIMIT,
  DuplicateSegmentIndexError,
  MAX_SEGMENT_LIMIT,
  NoReversibleSegmentsError,
  SearchReplaceOperationNotFoundError,
  SegmentGroupMismatchError,
  SegmentIssueNotFoundError,
  SegmentMarkupInvalidError,
  applySearchReplace,
  approveAllResourceSegments,
  batchReviewSegments,
  listResourceSegmentGroups,
  listResourceSegments,
  previewSearchReplace,
  setSegmentIssueDisposition,
  toSegmentDto,
  undoSearchReplace,
  updateResourceSegment,
  type SegmentListOptions,
  type SegmentPage,
  type SearchReplaceOptions,
  type SearchReplaceSkip,
} from '../repositories/segments'
import { json, problem } from '../responses'
import type { LocalRoute } from '../router'
import { bodyObject, errorResult, pathId } from './support'

/** 查询参数非法（Go `writeProblem(..., "invalid_query_parameter", ...)`）。 */
class InvalidQueryParameterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidQueryParameterError'
  }
}

/** 原文只读（Go `source_read_only`）。 */
class SourceReadOnlyError extends Error {
  constructor() {
    super('文件原文只读，请通过更新原文件创建新版本')
    this.name = 'SourceReadOnlyError'
  }
}

/** Repository 错误 → Problem 响应；`queryParamErrors` 时 SearchError 按查询参数报 400。 */
function mapSegmentError(
  error: unknown,
  options: { queryParamErrors?: boolean } = {},
): GatewayResult<never> {
  if (error instanceof InvalidQueryParameterError) {
    return problem(400, '请求参数不合法', error.message, { error_code: 'invalid_query_parameter' })
  }
  if (error instanceof SourceReadOnlyError) {
    return problem(400, '请求参数不合法', error.message, { error_code: 'source_read_only' })
  }
  if (error instanceof SegmentGroupMismatchError) {
    // 后端 handler_resource_segment.go 对 ErrSegmentGroupMismatch 返回 400。
    return problem(400, '请求参数不合法', error.message, { error_code: 'invalid_query_parameter' })
  }
  if (error instanceof SegmentMarkupInvalidError) {
    return problem(400, '请求参数不合法', error.message, { error_code: 'invalid_target_markup' })
  }
  if (error instanceof DuplicateSegmentIndexError) {
    return problem(409, '状态冲突', error.message, { error_code: 'duplicate_segment_index' })
  }
  if (error instanceof NoReversibleSegmentsError) {
    return problem(409, '状态冲突', error.message, { error_code: 'no_reversible_segments' })
  }
  if (error instanceof SegmentIssueNotFoundError) {
    return problem(404, '质量问题不存在', error.message, { error_code: 'issue_not_found' })
  }
  if (error instanceof SearchReplaceOperationNotFoundError) {
    return problem(404, '资源不存在', error.message, { error_code: 'not_found' })
  }
  if (error instanceof SearchError) {
    return problem(400, '请求参数不合法', error.message, {
      error_code: options.queryParamErrors === true ? 'invalid_query_parameter' : 'invalid_input',
    })
  }
  return errorResult(error)
}

/** 处理器包装：捕获段落领域错误并映射为 Problem。 */
async function segmentRoute(
  handler: () => Promise<GatewayResult<unknown>> | GatewayResult<unknown>,
  options: { queryParamErrors?: boolean } = {},
): Promise<GatewayResult<unknown>> {
  try {
    return await handler()
  } catch (error) {
    return mapSegmentError(error, options)
  }
}

// ── 查询参数读取 ──

/** 查询键是否「存在」（`undefined` / `null` 视为未提供，模拟 URL 序列化语义）。 */
function hasQueryKey(query: Record<string, unknown>, key: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(query, key) &&
    query[key] !== undefined &&
    query[key] !== null
  )
}

/** 读取字符串查询参数；数组取首值（Go `query.Get`），非字符串标量转字符串。 */
function queryString(query: Record<string, unknown>, key: string): string | undefined {
  const raw = query[key]
  if (raw === undefined || raw === null) return undefined
  if (Array.isArray(raw)) {
    const first = raw[0]
    return first === undefined || first === null ? undefined : String(first)
  }
  if (typeof raw === 'boolean' || typeof raw === 'number') return String(raw)
  if (typeof raw !== 'string') {
    throw new InvalidQueryParameterError(`${key} 不合法`)
  }
  return raw
}

/**
 * 解析布尔查询参数（Go `parseBoolQuery`）。
 *
 * 本地网关拿到的是**未序列化的** query 对象，因此布尔值原样传入；
 * `"true"/"1"` → true，`"false"/"0"` → false，其余值视为未提供（nil）。
 */
function queryBool(query: Record<string, unknown>, key: string): boolean | undefined {
  const raw = query[key]
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'number') return raw === 1 ? true : raw === 0 ? false : undefined
  if (typeof raw === 'string') {
    if (raw === 'true' || raw === '1') return true
    if (raw === 'false' || raw === '0') return false
    return undefined
  }
  return undefined
}

/**
 * 解析 `limit`（Go `parseLimitParam(50, 200)`）：缺省或空串 → 50；
 * 非正整数或超过上限 → 400。
 */
function parseLimit(raw: string | undefined): number {
  const text = (raw ?? '').trim()
  if (text === '') return DEFAULT_SEGMENT_LIMIT
  if (!/^\d+$/.test(text)) {
    throw new InvalidQueryParameterError('limit 必须是有效正整数且不超过上限')
  }
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_SEGMENT_LIMIT) {
    throw new InvalidQueryParameterError('limit 必须是有效正整数且不超过上限')
  }
  return value
}

/**
 * 解析 `cursor`（Go `parseCursorPagination`）。
 *
 * 返回 `hasCursor`：请求是否显式携带 cursor（`cursor=` 空串也算携带，afterID=0）。
 * 非负整数以外 → 400。
 */
function parseCursor(raw: string | undefined, hasCursor: boolean): number {
  if (!hasCursor) return 0
  const text = (raw ?? '').trim()
  if (text === '') return 0
  if (!/^\d+$/.test(text)) {
    throw new InvalidQueryParameterError('cursor 必须是有效非负整数')
  }
  const value = Number(text)
  if (!Number.isSafeInteger(value)) {
    throw new InvalidQueryParameterError('cursor 必须是有效非负整数')
  }
  return value
}

/** 解析 `anchor_segment_id`：重复出现或非正整数 → 400。 */
function parseAnchorSegmentId(query: Record<string, unknown>): number | null {
  if (!hasQueryKey(query, 'anchor_segment_id')) return null
  const raw = query.anchor_segment_id
  if (Array.isArray(raw)) {
    if (raw.length !== 1) {
      throw new InvalidQueryParameterError('anchor_segment_id 只能出现一次')
    }
    return parseAnchorValue(raw[0])
  }
  return parseAnchorValue(raw)
}

function parseAnchorValue(raw: unknown): number {
  const text = String(raw).trim()
  if (!/^\d+$/.test(text)) {
    throw new InvalidQueryParameterError('anchor_segment_id 必须是有效正整数')
  }
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidQueryParameterError('anchor_segment_id 必须是有效正整数')
  }
  return value
}

// ── 请求体读取 ──

function bodyString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string') {
    throw new RepositoryValidationError(`${key} 必须是字符串`)
  }
  return value
}

/** 可选字符串：`undefined` / `null` 视为未提供（Go `*string` 语义）。 */
function bodyOptionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new RepositoryValidationError(`${key} 必须是字符串`)
  }
  return value
}

function bodyOptionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') {
    throw new RepositoryValidationError(`${key} 必须是布尔值`)
  }
  return value
}

function bodyOptionalInt(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new RepositoryValidationError(`${key} 必须是整数`)
  }
  return value
}

/** 段落 ID 数组：缺省返回 `undefined`；元素必须是正整数。 */
function bodySegmentIds(body: Record<string, unknown>, key: string): number[] | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    throw new RepositoryValidationError(`${key} 必须是整数数组`)
  }
  const ids: number[] = []
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item <= 0) {
      throw new RepositoryValidationError(`${key} 必须是整数数组`)
    }
    ids.push(item)
  }
  return ids
}

/** 搜索替换请求体 → Repository 选项。 */
function searchReplaceOptions(
  body: Record<string, unknown>,
  withFilters: boolean,
): SearchReplaceOptions {
  const options: SearchReplaceOptions = {
    find: bodyString(body, 'find'),
    replaceWith: bodyOptionalString(body, 'replace_with') ?? '',
    matchMode: bodyOptionalString(body, 'match_mode'),
    caseSensitive: bodyOptionalBoolean(body, 'case_sensitive'),
    wholeWord: bodyOptionalBoolean(body, 'whole_word'),
    segmentIds: bodySegmentIds(body, 'segment_ids'),
  }
  if (withFilters) {
    options.maxResults = bodyOptionalInt(body, 'max_results')
    options.status = bodyOptionalString(body, 'status')
    options.qualityIssues = bodyOptionalString(body, 'quality_issues')
    options.qualitySeverity = bodyOptionalString(body, 'quality_severity')
    options.qualityCode = bodyOptionalString(body, 'quality_code')
    options.groupKey = bodyOptionalString(body, 'group_key')
  }
  return options
}

/** 跳过项 → OpenAPI `SearchReplaceSkippedItem`。 */
function skippedItems(
  skipped: readonly SearchReplaceSkip[],
): { segment_id: number; reason: SearchReplaceSkip['reason'] }[] {
  return skipped.map((item) => ({ segment_id: item.segmentId, reason: item.reason }))
}

// ── 路由 ──

const BASE = '/projects/{projectId}/resources/{resourceId}/segments'

export const segmentRoutes: LocalRoute[] = [
  {
    method: 'GET',
    path: BASE,
    handler: (ctx) =>
      segmentRoute(
        async () => {
          const projectId = pathId(ctx, 'projectId')
          const resourceId = pathId(ctx, 'resourceId')
          const query = ctx.query

          const direction = (queryString(query, 'direction') ?? '').trim() || 'asc'
          if (direction !== 'asc' && direction !== 'desc') {
            throw new InvalidQueryParameterError('direction 只支持 asc 或 desc')
          }
          const matchMode = (queryString(query, 'match_mode') ?? '').trim()
          if (matchMode !== '' && matchMode !== 'substring' && matchMode !== 'regex') {
            throw new InvalidQueryParameterError('不支持的 match_mode')
          }

          const hasCursor = hasQueryKey(query, 'cursor')
          const cursor = parseCursor(queryString(query, 'cursor'), hasCursor)
          const anchorSegmentId = parseAnchorSegmentId(query)
          if (anchorSegmentId !== null) {
            if (hasCursor) {
              throw new InvalidQueryParameterError('anchor_segment_id 不能与 cursor 同时使用')
            }
            if (direction === 'desc') {
              throw new InvalidQueryParameterError(
                'anchor_segment_id 不能与 direction=desc 同时使用',
              )
            }
          }

          const options: SegmentListOptions = {
            status: (queryString(query, 'status') ?? '').trim() || undefined,
            // search 保留原值：前后空白对 substring / regex 都有语义。
            search: queryString(query, 'search'),
            matchMode,
            wholeWord: queryBool(query, 'whole_word'),
            groupKey: (queryString(query, 'group_key') ?? '').trim() || undefined,
            qualityIssues: (queryString(query, 'quality_issues') ?? '').trim() || undefined,
            qualitySeverity: (queryString(query, 'quality_severity') ?? '').trim() || undefined,
            qualityCode: (queryString(query, 'quality_code') ?? '').trim() || undefined,
            searchField: (queryString(query, 'search_field') ?? '').trim() || undefined,
            caseSensitive: queryBool(query, 'case_sensitive'),
            // Go：query.Get("include_total") == "true"（严格字符串比较）。
            includeTotal: query.include_total === true || query.include_total === 'true',
            anchorSegmentId,
            direction,
            cursor,
            hasCursor,
            limit: parseLimit(queryString(query, 'limit')),
          }
          const page: SegmentPage = await listResourceSegments(
            ctx.db,
            projectId,
            resourceId,
            options,
          )
          return json(page)
        },
        { queryParamErrors: true },
      ),
  },
  {
    method: 'GET',
    path: `${BASE}/groups`,
    handler: (ctx) =>
      segmentRoute(async () => {
        const projectId = pathId(ctx, 'projectId')
        const resourceId = pathId(ctx, 'resourceId')
        const items = await listResourceSegmentGroups(ctx.db, projectId, resourceId)
        return json({ items })
      }),
  },
  {
    method: 'PATCH',
    path: `${BASE}/{segmentId}`,
    handler: (ctx) =>
      segmentRoute(async () => {
        const projectId = pathId(ctx, 'projectId')
        const resourceId = pathId(ctx, 'resourceId')
        const segmentId = pathId(ctx, 'segmentId')
        const body = bodyObject(ctx)
        // Go：请求结构体里 source_text 是 RawMessage，只要出现（含 null）即 400。
        if (
          Object.prototype.hasOwnProperty.call(body, 'source_text') &&
          body.source_text !== undefined
        ) {
          throw new SourceReadOnlyError()
        }
        const targetText = bodyOptionalString(body, 'target_text')
        const comment = bodyOptionalString(body, 'comment')
        if (targetText === undefined && comment === undefined) {
          throw new RepositoryValidationError('至少需要提供 target_text 或 comment')
        }
        const row = await updateResourceSegment(ctx.db, projectId, resourceId, segmentId, {
          targetText,
          comment,
          expectedContentVersion: bodyOptionalInt(body, 'expected_content_version'),
        })
        return json(toSegmentDto(row))
      }),
  },
  {
    method: 'POST',
    path: `${BASE}/batch-review`,
    handler: (ctx) =>
      segmentRoute(async () => {
        const projectId = pathId(ctx, 'projectId')
        const resourceId = pathId(ctx, 'resourceId')
        const body = bodyObject(ctx)
        const segmentIds = bodySegmentIds(body, 'segment_ids') ?? []
        const action = bodyString(body, 'action')
        const comment = bodyOptionalString(body, 'comment')
        const rows = await batchReviewSegments(ctx.db, projectId, resourceId, {
          segmentIds,
          action,
          comment,
        })
        return json({ items: rows.map(toSegmentDto) })
      }),
  },
  {
    method: 'POST',
    path: `${BASE}/approve-all`,
    handler: (ctx) =>
      segmentRoute(async () => {
        const projectId = pathId(ctx, 'projectId')
        const resourceId = pathId(ctx, 'resourceId')
        const approvedCount = await approveAllResourceSegments(ctx.db, projectId, resourceId)
        return json({ approved_count: approvedCount })
      }),
  },
  {
    method: 'POST',
    path: `${BASE}/{segmentId}/issues/disposition`,
    handler: (ctx) =>
      segmentRoute(async () => {
        const projectId = pathId(ctx, 'projectId')
        const resourceId = pathId(ctx, 'resourceId')
        const segmentId = pathId(ctx, 'segmentId')
        const body = bodyObject(ctx)
        const row = await setSegmentIssueDisposition(ctx.db, projectId, resourceId, segmentId, {
          code: bodyOptionalString(body, 'code') ?? '',
          matchedText: bodyOptionalString(body, 'matched_text') ?? '',
          disposition: bodyString(body, 'disposition'),
          note: bodyOptionalString(body, 'note'),
        })
        return json(toSegmentDto(row))
      }),
  },
  {
    method: 'POST',
    path: `${BASE}/search-replace/preview`,
    handler: (ctx) =>
      segmentRoute(async () => {
        const projectId = pathId(ctx, 'projectId')
        const resourceId = pathId(ctx, 'resourceId')
        const options = searchReplaceOptions(bodyObject(ctx), true)
        const result = await previewSearchReplace(ctx.db, projectId, resourceId, options)
        return json({
          matched_segment_count: result.matchedSegmentCount,
          total_replacements: result.totalReplacements,
          items: result.items.map((item) => ({
            segment_id: item.segmentId,
            segment_index: item.segmentIndex,
            source_text: item.sourceText,
            before: item.before,
            after: item.after,
            match_count: item.matchCount,
          })),
        })
      }),
  },
  {
    method: 'POST',
    path: `${BASE}/search-replace/apply`,
    handler: (ctx) =>
      segmentRoute(async () => {
        const projectId = pathId(ctx, 'projectId')
        const resourceId = pathId(ctx, 'resourceId')
        const options = searchReplaceOptions(bodyObject(ctx), false)
        const outcome = await applySearchReplace(ctx.db, projectId, resourceId, options)
        const skipped = skippedItems(outcome.skipped)
        return json({
          operation_id: outcome.operationId,
          applied_count: outcome.applied.length,
          skipped_count: skipped.length,
          items: outcome.applied.map(toSegmentDto),
          ...(skipped.length > 0 ? { skipped } : {}),
        })
      }),
  },
  {
    method: 'POST',
    path: `${BASE}/search-replace/{operationId}/undo`,
    handler: (ctx) =>
      segmentRoute(async () => {
        const projectId = pathId(ctx, 'projectId')
        const resourceId = pathId(ctx, 'resourceId')
        const operationId = (ctx.path.operationId ?? '').trim()
        if (operationId === '') {
          throw new RepositoryValidationError('operationId 不能为空')
        }
        const outcome = await undoSearchReplace(ctx.db, projectId, resourceId, operationId)
        const skipped = skippedItems(outcome.skipped)
        return json({
          undo_operation_id: outcome.undoOperationId,
          undone_count: outcome.undone.length,
          skipped_count: skipped.length,
          items: outcome.undone.map(toSegmentDto),
          ...(skipped.length > 0 ? { skipped } : {}),
        })
      }),
  },
]
