/**
 * 本地「QA 重检」Repository（对应后端 `POST /projects/{projectId}/qa-recheck`）。
 *
 * 重检语义与后端一致：
 *
 * 1. 读取执行策略里的 QA 配置（开关 / checks 名单 / 长度阈值）；
 *    策略未启用 QA → 400。
 * 2. 按 `segment_group_keys` > `segment_ids` > `resource_ids` > 全项目 的优先级选段；
 * 3. 用 Phase 1 移植的 `domain/qa` 引擎跑全部启用的 checker；
 * 4. 与段落上已有问题做**指纹对账**（`reconcileIssues`）：
 *    新指纹 → 新增问题；消失的指纹 → 清除；既有裁决（dismissed）按指纹继承；
 * 5. 写回段落的问题列表（沿用后端的 wire 形态）。
 */
import {
  Engine,
  defaultConfig,
  fingerprint,
  reconcileIssues,
  qualityIssueFromWire,
  qualityIssueToWire,
  type Config,
  type QualityIssue,
  type QualityIssueWire,
} from '@/domain/qa'
import type { CheckInput } from '@/domain/qa/types'
import type { LinguaFlowDatabase } from '@/infrastructure/indexeddb/db'
import type { SegmentRow } from '@/infrastructure/indexeddb/types'

import { RepositoryNotFoundError, RepositoryValidationError } from './errors'

/** QA 配置（来自执行策略的 `config.qa`，键名与 Go `ProfileQAConfig` 一致）。 */
interface ProfileQaConfig {
  enabled: boolean
  auto_reject: boolean
  checks: string[] | null
  length_method: string
  length_ratio_min: number
  length_ratio_max: number
}

/** 重检请求体。 */
export interface QaRecheckRequest {
  profile_id: number
  resource_ids?: number[]
  segment_ids?: number[]
  segment_group_keys?: string[]
}

/** 单个资源的重检结果。 */
export interface QaRecheckResourceResult {
  resource_id: number
  segments_checked: number
  segments_skipped_no_target: number
  segments_skipped_concurrent: number
  issues_new: number
  issues_cleared: number
  dispositions_inherited: number
}

/** 重检结果。 */
export interface QaRecheckResult {
  profile_id: number
  profile_name: string
  resources_checked: number
  segments_checked: number
  segments_skipped_no_target: number
  segments_skipped_concurrent: number
  issues_new: number
  issues_cleared: number
  dispositions_inherited: number
  resources: QaRecheckResourceResult[]
}

/** 读取执行策略的 QA 配置。 */
function readQaConfig(config: Record<string, unknown> | null): ProfileQaConfig {
  const qa = (config?.qa ?? {}) as Record<string, unknown>
  const checks = qa.checks
  return {
    enabled: qa.enabled === true,
    auto_reject: qa.auto_reject === true,
    checks: Array.isArray(checks) ? (checks as string[]) : null,
    length_method: typeof qa.length_method === 'string' ? qa.length_method : 'char_weight',
    length_ratio_min: typeof qa.length_ratio_min === 'number' ? qa.length_ratio_min : 0.2,
    length_ratio_max: typeof qa.length_ratio_max === 'number' ? qa.length_ratio_max : 3,
  }
}

/** 组装 `domain/qa` 的引擎配置。 */
function toEngineConfig(qa: ProfileQaConfig, sourceLang: string, targetLang: string): Config {
  const base = defaultConfig()
  return {
    ...base,
    enabled: qa.enabled,
    autoReject: qa.auto_reject,
    checks: qa.checks,
    sourceLang,
    targetLang,
    lengthRatioMin: qa.length_ratio_min,
    lengthRatioMax: qa.length_ratio_max,
    lengthMethod: qa.length_method,
  }
}

/** 段落行 → 引擎输入。 */
function toCheckInput(row: SegmentRow): CheckInput {
  return {
    index: row.segment_index,
    sourceText: row.source_text,
    targetText: row.target_text,
    meta: row.meta,
    protected: null,
  }
}

/** 读出段落上已有的问题（wire → 内存态）。 */
function readExisting(row: SegmentRow): QualityIssue[] {
  const raw = row.quality_issues
  if (!Array.isArray(raw)) return []
  const out: QualityIssue[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    try {
      out.push(qualityIssueFromWire(item))
    } catch {
      // 旧数据或非法数据：跳过该条，不让整段重检失败。
    }
  }
  return out
}

/** 内存态问题 → wire（落库形态）。 */
function toWire(issue: QualityIssue): QualityIssueWire {
  return qualityIssueToWire(issue)
}

/**
 * 执行本地 QA 重检。
 */
export async function qaRecheck(
  db: LinguaFlowDatabase,
  projectId: number,
  request: QaRecheckRequest,
): Promise<QaRecheckResult> {
  const profileId = Number(request.profile_id)
  if (!Number.isSafeInteger(profileId) || profileId <= 0) {
    throw new RepositoryValidationError('profile_id 不合法')
  }
  const profile = await db.execution_profiles.where('localId').equals(profileId).first()
  if (!profile || profile.deletedAt !== null) {
    throw new RepositoryNotFoundError('执行策略', profileId)
  }
  const qa = readQaConfig(profile.config)
  if (!qa.enabled) {
    throw new RepositoryValidationError('执行策略未启用 QA 检查')
  }

  const project = await db.projects.where('localId').equals(projectId).first()
  if (!project || project.deletedAt !== null) {
    throw new RepositoryNotFoundError('项目', projectId)
  }

  const allSegments = await db.segments
    .where('project_id')
    .equals(projectId)
    .filter((row) => row.deletedAt === null)
    .sortBy('segment_index')

  const selected = selectSegments(allSegments, request)
  const resources = new Map<number, SegmentRow[]>()
  for (const row of selected) {
    const list = resources.get(row.resource_id) ?? []
    list.push(row)
    resources.set(row.resource_id, list)
  }

  const engine = new Engine(toEngineConfig(qa, project.source_lang, project.target_lang))

  const resourceResults: QaRecheckResourceResult[] = []
  let segmentsChecked = 0
  let skippedNoTarget = 0
  let skippedConcurrent = 0
  let issuesNew = 0
  let issuesCleared = 0
  let dispositionsInherited = 0

  for (const [resourceId, rows] of [...resources.entries()].sort((a, b) => a[0] - b[0])) {
    const withTarget = rows.filter((row) => row.target_text.trim() !== '')
    skippedNoTarget += rows.length - withTarget.length

    const fresh = engine.run(withTarget.map(toCheckInput))
    const freshBySegment = new Map<number, QualityIssue[]>()
    for (const issue of fresh) {
      const list = freshBySegment.get(issue.segmentIndex) ?? []
      list.push(issue)
      freshBySegment.set(issue.segmentIndex, list)
    }

    let resourceIssuesNew = 0
    let resourceIssuesCleared = 0
    let resourceDispositions = 0

    for (const row of withTarget) {
      const existing = readExisting(row)
      const produced = freshBySegment.get(row.segment_index) ?? []
      const reconciled = reconcileIssues(produced, existing)

      const inherited = reconciled.filter(
        (issue) => issue.disposition !== '' && issue.disposition !== 'pending',
      ).length

      const before = new Set(existing.map((issue) => fingerprint(issue)))
      const after = new Set(reconciled.map((issue) => fingerprint(issue)))
      let added = 0
      for (const key of after) if (!before.has(key)) added++
      let cleared = 0
      for (const key of before) if (!after.has(key)) cleared++

      resourceIssuesNew += added
      resourceIssuesCleared += cleared
      resourceDispositions += inherited

      await db.segments.update(row.id, {
        quality_issues: reconciled.map(toWire) as unknown as SegmentRow['quality_issues'],
        updatedAt: new Date().toISOString(),
        revision: row.revision + 1,
        dirty: true,
      })
    }

    segmentsChecked += withTarget.length
    issuesNew += resourceIssuesNew
    issuesCleared += resourceIssuesCleared
    dispositionsInherited += resourceDispositions

    resourceResults.push({
      resource_id: resourceId,
      segments_checked: withTarget.length,
      segments_skipped_no_target: rows.length - withTarget.length,
      segments_skipped_concurrent: skippedConcurrent,
      issues_new: resourceIssuesNew,
      issues_cleared: resourceIssuesCleared,
      dispositions_inherited: resourceDispositions,
    })
  }

  return {
    profile_id: profileId,
    profile_name: profile.name,
    resources_checked: resourceResults.length,
    segments_checked: segmentsChecked,
    segments_skipped_no_target: skippedNoTarget,
    segments_skipped_concurrent: skippedConcurrent,
    issues_new: issuesNew,
    issues_cleared: issuesCleared,
    dispositions_inherited: dispositionsInherited,
    resources: resourceResults,
  }
}

/**
 * 按 `segment_group_keys` > `segment_ids` > `resource_ids` > 全项目 的优先级选段。
 */
function selectSegments(rows: SegmentRow[], request: QaRecheckRequest): SegmentRow[] {
  const groupKeys = request.segment_group_keys
  if (Array.isArray(groupKeys) && groupKeys.length > 0) {
    const set = new Set(groupKeys)
    return rows.filter((row) => row.group_key !== null && set.has(row.group_key))
  }
  const segmentIds = request.segment_ids
  if (Array.isArray(segmentIds) && segmentIds.length > 0) {
    const set = new Set(segmentIds.map(Number))
    return rows.filter((row) => set.has(row.localId))
  }
  const resourceIds = request.resource_ids
  if (Array.isArray(resourceIds) && resourceIds.length > 0) {
    const set = new Set(resourceIds.map(Number))
    return rows.filter((row) => set.has(row.resource_id))
  }
  return rows
}
