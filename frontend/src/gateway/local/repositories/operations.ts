/**
 * 「操作」投影 Repository（对应后端 `service/operation_query.go` + `api/handler_operation.go`）。
 *
 * `/operations` 是**只读投影**：把翻译任务、术语同步、存储任务、退出父任务
 * 四类活动任务统一成一个列表。本地模式没有真实的跨类型调度器，
 * 因此投影来源是：
 *
 * - `translation` ← `jobs` 表（本地写入的任务记录）；
 * - `storage` ← `storage_tasks` 表；
 * - `glossary_sync` / `storage_retirement` ← 本地无对应实体，恒为空。
 *
 * 统计口径与后端一致：`by_type` 固定返回四类，未选类型计零；
 * `recent_failed` 只数当前 `failed` 且 `updated_at` 落在最近七天窗口内的记录。
 */
import type { LinguaFlowDatabase } from '@/infrastructure/indexeddb/db'
import { nowIso } from '@/infrastructure/indexeddb/repo'
import type { JobRow, ProjectRow, StorageTaskRow } from '@/infrastructure/indexeddb/types'

import { RepositoryNotFoundError, RepositoryValidationError } from './errors'

/** 四类任务的类型标识（与后端一致）。 */
export const OPERATION_TASK_TYPES = [
  'translation',
  'glossary_sync',
  'storage',
  'storage_retirement',
] as const

/** 任务类型。 */
export type OperationTaskType = (typeof OPERATION_TASK_TYPES)[number]

/** 活动状态集合（翻译类）。 */
const TRANSLATION_ACTIVE = new Set(['pending', 'running', 'pausing', 'paused'])
/** 活动状态集合（存储类）。 */
const STORAGE_ACTIVE = new Set(['pending', 'running', 'waiting_retry', 'needs_action'])

/** 计数结构（对齐后端 `OperationCounts`）。 */
export interface OperationCounts {
  pending: number
  running: number
  pausing: number
  paused: number
  recent_failed: number
  waiting_retry: number
  needs_action: number
}

/** 空计数。 */
function emptyCounts(): OperationCounts {
  return {
    pending: 0,
    running: 0,
    pausing: 0,
    paused: 0,
    recent_failed: 0,
    waiting_retry: 0,
    needs_action: 0,
  }
}

/** 单条操作投影（与后端 `OperationSummary` 对齐的子集）。 */
export interface OperationSummary {
  task_type: OperationTaskType
  task_id: string
  project_id: number
  project_name: string
  status: string
  created_at: string
  updated_at: string
  started_at: string | null
  finished_at: string | null
  can_delete: boolean
  supported_actions: string[]
  progress?: { total: number; completed: number }
  storage_kind?: string
  phase?: string
  cleanup_status?: string
  error_code?: string
  next_retry_at?: string | null
  trigger_type?: string
}

/** 列表查询参数。 */
export interface ListOperationsOptions {
  projectId?: number
  taskType?: OperationTaskType
  /** `active`（默认）只返回活动任务；`all` 返回全部。 */
  state?: 'active' | 'all'
  limit?: number
}

/** 摘要查询参数。 */
export interface OperationsSummaryOptions {
  projectId?: number
  taskType?: OperationTaskType
}

/** 终态集合（可删除的历史任务）。 */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

/** 项目名索引。 */
async function projectNames(db: LinguaFlowDatabase): Promise<Map<number, string>> {
  const rows = await db.projects.toArray()
  return new Map(rows.map((row: ProjectRow) => [row.localId, row.name]))
}

/** 翻译任务 → 操作投影。 */
function toTranslationOperation(
  row: JobRow,
  projectName: string,
  state: 'active' | 'all',
): OperationSummary {
  const active = TRANSLATION_ACTIVE.has(row.status)
  const terminal = TERMINAL_STATUSES.has(row.status)
  return {
    task_type: 'translation',
    task_id: String(row.localId),
    project_id: row.project_id,
    project_name: projectName,
    status: row.status,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    started_at: row.createdAt,
    finished_at: terminal ? row.updatedAt : null,
    can_delete: terminal,
    supported_actions: supportedActions(row.status, terminal),
    trigger_type: row.trigger_type,
    progress: { total: row.progress_total, completed: row.progress_completed },
    ...(state === 'active' && !active ? {} : {}),
  }
}

/** 存储任务 → 操作投影。 */
function toStorageOperation(
  row: StorageTaskRow,
  projectName: string,
): OperationSummary {
  const terminal = TERMINAL_STATUSES.has(row.status)
  return {
    task_type: 'storage',
    task_id: String(row.localId),
    project_id: row.project_id,
    project_name: projectName,
    status: row.status,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    started_at: row.createdAt,
    finished_at: terminal ? row.updatedAt : null,
    // 存储任务不可删除（与后端一致：can_delete 恒为 false）。
    can_delete: false,
    supported_actions: ['view', 'cancel', 'retry'],
    storage_kind: row.kind,
    phase: row.phase,
    cleanup_status: row.cleanup_status,
    error_code: '',
    next_retry_at: null,
  }
}

/** 任务状态 → 可用动作。 */
function supportedActions(status: string, terminal: boolean): string[] {
  if (terminal) return ['view', 'delete']
  switch (status) {
    case 'pending':
      return ['view', 'cancel']
    case 'running':
      return ['view', 'pause', 'cancel']
    case 'pausing':
    case 'paused':
      return ['view', 'resume', 'cancel']
    default:
      return ['view']
  }
}

/**
 * 列出操作投影。
 *
 * 排序：与后端一致按 `updated_at` 降序（同值时按任务类型与任务 ID 降序）。
 */
export async function listOperations(
  db: LinguaFlowDatabase,
  options: ListOperationsOptions = {},
): Promise<{ items: OperationSummary[]; next_cursor?: string }> {
  const state = options.state ?? 'active'
  const names = await projectNames(db)
  const items: OperationSummary[] = []

  const includeTranslation = !options.taskType || options.taskType === 'translation'
  const includeStorage = !options.taskType || options.taskType === 'storage'

  if (includeTranslation) {
    const jobs = await db.jobs.toArray()
    for (const row of jobs) {
      if (row.deletedAt !== null) continue
      if (options.projectId !== undefined && row.project_id !== options.projectId) continue
      if (state === 'active' && !TRANSLATION_ACTIVE.has(row.status)) continue
      items.push(toTranslationOperation(row, names.get(row.project_id) ?? '', state))
    }
  }

  if (includeStorage) {
    const tasks = await db.storage_tasks.toArray()
    for (const row of tasks) {
      if (row.deletedAt !== null) continue
      if (options.projectId !== undefined && row.project_id !== options.projectId) continue
      if (state === 'active' && !STORAGE_ACTIVE.has(row.status)) continue
      items.push(toStorageOperation(row, names.get(row.project_id) ?? ''))
    }
  }

  items.sort((a, b) => {
    if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1
    if (a.task_type !== b.task_type) return a.task_type < b.task_type ? 1 : -1
    return Number(b.task_id) - Number(a.task_id)
  })

  const limit = options.limit && options.limit > 0 ? options.limit : 50
  const page = items.slice(0, limit)
  const result: { items: OperationSummary[]; next_cursor?: string } = { items: page }
  if (items.length > limit && page.length > 0) {
    result.next_cursor = page[page.length - 1]?.updated_at
  }
  return result
}

/**
 * 获取操作摘要（计数）。
 *
 * `recent_failed` 的窗口是**连续七天**（与后端一致）。
 */
export async function getOperationsSummary(
  db: LinguaFlowDatabase,
  options: OperationsSummaryOptions = {},
): Promise<{
  total: OperationCounts
  by_type: Record<OperationTaskType, OperationCounts>
  recent_failed_since: string
  as_of: string
}> {
  const asOf = nowIso()
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const byType: Record<OperationTaskType, OperationCounts> = {
    translation: emptyCounts(),
    glossary_sync: emptyCounts(),
    storage: emptyCounts(),
    storage_retirement: emptyCounts(),
  }

  const jobs = await db.jobs.toArray()
  for (const row of jobs) {
    if (row.deletedAt !== null) continue
    if (options.projectId !== undefined && row.project_id !== options.projectId) continue
    if (options.taskType && options.taskType !== 'translation') continue
    countInto(byType.translation, row.status, row.updatedAt, since)
  }

  const tasks = await db.storage_tasks.toArray()
  for (const row of tasks) {
    if (row.deletedAt !== null) continue
    if (options.projectId !== undefined && row.project_id !== options.projectId) continue
    if (options.taskType && options.taskType !== 'storage') continue
    countInto(byType.storage, row.status, row.updatedAt, since)
  }

  const total = emptyCounts()
  for (const type of OPERATION_TASK_TYPES) {
    const counts = byType[type]
    total.pending += counts.pending
    total.running += counts.running
    total.pausing += counts.pausing
    total.paused += counts.paused
    total.recent_failed += counts.recent_failed
    total.waiting_retry += counts.waiting_retry
    total.needs_action += counts.needs_action
  }

  return {
    total,
    by_type: byType,
    recent_failed_since: since,
    as_of: asOf,
  }
}

/** 把一条记录计入对应计数桶。 */
function countInto(counts: OperationCounts, status: string, updatedAt: string, since: string): void {
  switch (status) {
    case 'pending':
      counts.pending++
      return
    case 'running':
      counts.running++
      return
    case 'pausing':
      counts.pausing++
      return
    case 'paused':
      counts.paused++
      return
    case 'waiting_retry':
      counts.waiting_retry++
      return
    case 'needs_action':
      counts.needs_action++
      return
    case 'failed':
      if (updatedAt >= since) counts.recent_failed++
      return
    default:
  }
}

/** 批量删除请求项。 */
export interface BatchDeleteTarget {
  kind: string
  id: string
  project_id: number
}

/** 批量删除结果项。 */
export interface BatchDeleteResult extends BatchDeleteTarget {
  status: 'deleted' | 'not_found' | 'forbidden' | 'not_terminal' | 'busy' | 'blocked' | 'deferred' | 'failed'
}

/**
 * 批量删除任务历史。
 *
 * 与后端一致：逐项独立判定，已成功项不因其他项失败而回滚。
 */
export async function batchDeleteOperations(
  db: LinguaFlowDatabase,
  items: BatchDeleteTarget[],
): Promise<{ items: BatchDeleteResult[] }> {
  if (!Array.isArray(items) || items.length === 0) {
    throw new RepositoryValidationError('缺少要删除的任务引用')
  }
  if (items.length > 100) {
    throw new RepositoryValidationError('单次最多删除 100 条任务记录')
  }

  const results: BatchDeleteResult[] = []
  for (const item of items) {
    const kind = String(item?.kind ?? '')
    const id = String(item?.id ?? '')
    const projectId = Number(item?.project_id)
    if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(projectId) || projectId <= 0) {
      throw new RepositoryValidationError('任务引用格式非法')
    }
    if (kind !== 'translation' && kind !== 'glossary_sync') {
      throw new RepositoryValidationError(`不支持的任务类型：${kind}`)
    }
    if (kind === 'glossary_sync') {
      // 本地模式没有术语同步任务实体。
      results.push({ ...item, kind, id, project_id: projectId, status: 'not_found' })
      continue
    }
    const localId = Number(id)
    const row = await db.jobs.where('localId').equals(localId).first()
    if (!row || row.deletedAt !== null) {
      results.push({ ...item, kind, id, project_id: projectId, status: 'not_found' })
      continue
    }
    if (row.project_id !== projectId) {
      results.push({ ...item, kind, id, project_id: projectId, status: 'forbidden' })
      continue
    }
    if (!TERMINAL_STATUSES.has(row.status)) {
      results.push({ ...item, kind, id, project_id: projectId, status: 'not_terminal' })
      continue
    }
    await db.transaction('rw', db.jobs, db.job_events, async () => {
      await db.job_events.where('job_id').equals(localId).delete()
      await db.jobs.delete(row.id)
    })
    results.push({ ...item, kind, id, project_id: projectId, status: 'deleted' })
  }
  return { items: results }
}

/**
 * 本地模式的默认管理员用户。
 *
 * 浏览器本地模式没有账号体系，用一个固定的本地身份占位，
 * 保证 `GET /users/me` 这类「读当前用户」的调用不需要回落远端。
 */
export function localCurrentUser(): {
  id: number
  username: string
  email: string | null
  display_name: string
  role: string
  active: boolean
} {
  return {
    id: 1,
    username: 'local',
    email: null,
    display_name: '本地用户',
    role: 'admin',
    active: true,
  }
}

/** 读取本地默认用户（找不到本地项目时也返回占位用户）。 */
export async function getCurrentUser(
  db: LinguaFlowDatabase,
): Promise<ReturnType<typeof localCurrentUser>> {
  const project = await db.projects.orderBy('localId').first()
  if (!project) return localCurrentUser()
  return localCurrentUser()
}

/** 读取不存在的项目时抛出。 */
export async function requireProject(
  db: LinguaFlowDatabase,
  projectId: number,
): Promise<ProjectRow> {
  const row = await db.projects.where('localId').equals(projectId).first()
  if (!row || row.deletedAt !== null) {
    throw new RepositoryNotFoundError('项目', projectId)
  }
  return row
}
