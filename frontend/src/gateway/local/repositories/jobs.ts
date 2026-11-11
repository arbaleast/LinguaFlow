/**
 * 任务 / 统计 / 活动日志 Repository（对应后端 `service/job.go`、`service/stats.go`、
 * `service/activity.go`）。
 *
 * 本地模式没有真实的翻译执行引擎，任务状态由本地写入的 `jobs` 表驱动；
 * 查询语义（排序、分页、聚合计数）与后端保持一致，UI 零改动。
 */
import type { LinguaFlowDatabase } from '@/infrastructure/indexeddb/db'
import { getDeviceId, newRow, nowIso, softDelete } from '@/infrastructure/indexeddb/repo'
import type { ActivityLogRow, BaseRow, JobRow, UsageRecordRow } from '@/infrastructure/indexeddb/types'

import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  RepositoryValidationError,
} from './errors'

// ── 任务 ──

/** 任务 DTO（与后端 `service.Job` 对齐的子集）。 */
export interface JobDto {
  id: number
  project_id: number
  status: JobRow['status']
  trigger_type: string
  execution_plan_id: number
  error_message?: string
  progress: { total: number; completed: number }
  job_resources: Array<{
    id: number
    resource_id: number
    segment_ids: number[]
    status: string
  }>
  started_at?: string
  created_at: string
  updated_at: string
}

/** 任务事件 DTO（与后端 `service.JobEvent` 对齐）。 */
export interface JobEventDto {
  type: string
  job_id: number
  level: string
  stage?: string
  message: string
  metadata?: Record<string, unknown>
  created_at: string
  seq: number
}

/** 列出项目下的任务（按 `localId` 降序，对齐后端 `Order(Desc(FieldID))`）。 */
export async function listJobs(
  db: LinguaFlowDatabase,
  projectId: number,
): Promise<JobRow[]> {
  const rows = await db.jobs
    .where('project_id')
    .equals(projectId)
    .filter((row) => row.deletedAt === null)
    .toArray()
  return rows.sort((a, b) => b.localId - a.localId)
}

/** 读取未删除任务。 */
export async function getJob(
  db: LinguaFlowDatabase,
  jobId: number,
): Promise<JobRow | undefined> {
  const row = await db.jobs.where('localId').equals(jobId).first()
  return row && row.deletedAt === null ? row : undefined
}

/** 任务行 → DTO。 */
export function toJobDto(row: JobRow): JobDto {
  return {
    id: row.localId,
    project_id: row.project_id,
    status: row.status,
    trigger_type: row.trigger_type,
    execution_plan_id: row.execution_plan_id ?? 0,
    ...(row.error_message ? { error_message: row.error_message } : {}),
    progress: { total: row.progress_total, completed: row.progress_completed },
    job_resources: [],
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

/** 列出任务事件（按 `seq` 升序，对齐后端 `Order(Asc(FieldSeq))`）。 */
export async function listJobEvents(
  db: LinguaFlowDatabase,
  jobId: number,
): Promise<JobEventDto[]> {
  const rows = await db.job_events.where('job_id').equals(jobId).toArray()
  return rows
    .sort((a, b) => a.seq - b.seq)
    .map((row) => ({
      type: row.type,
      job_id: row.job_id,
      level: row.level,
      ...(row.stage ? { stage: row.stage } : {}),
      message: row.message,
      ...(row.metadata ? { metadata: row.metadata } : {}),
      created_at: row.created_at,
      seq: row.seq,
    }))
}

/** 追加一条任务事件。 */
export async function appendJobEvent(
  db: LinguaFlowDatabase,
  event: {
    job_id: number
    type: string
    level?: string
    stage?: string
    message: string
    metadata?: Record<string, unknown> | null
  },
): Promise<JobEventDto> {
  const existing = await db.job_events.where('job_id').equals(event.job_id).toArray()
  const seq = existing.reduce((max, row) => Math.max(max, row.seq), 0) + 1
  const row = {
    id: `${String(event.job_id)}:${String(seq)}`,
    job_id: event.job_id,
    seq,
    type: event.type,
    level: (event.level ?? 'info') as 'info' | 'warn' | 'warning' | 'error',
    stage: event.stage ?? null,
    message: event.message,
    metadata: event.metadata ?? null,
    created_at: nowIso(),
  }
  await db.job_events.put(row)
  return {
    type: row.type,
    job_id: row.job_id,
    level: row.level,
    ...(row.stage ? { stage: row.stage } : {}),
    message: row.message,
    ...(row.metadata ? { metadata: row.metadata } : {}),
    created_at: row.created_at,
    seq: row.seq,
  }
}

/** 更新任务状态（本地模式下用于取消 / 暂停 / 恢复 / 重试）。 */
export async function setJobStatus(
  db: LinguaFlowDatabase,
  jobId: number,
  status: JobRow['status'],
  errorMessage?: string | null,
): Promise<JobRow> {
  const deviceId = await getDeviceId(db)
  return db.transaction('rw', db.jobs, async () => {
    const row = await db.jobs.where('localId').equals(jobId).first()
    if (!row || row.deletedAt !== null) {
      throw new RepositoryNotFoundError('任务', jobId)
    }
    const updated: JobRow = {
      ...row,
      status,
      error_message: errorMessage === undefined ? row.error_message : errorMessage,
      revision: row.revision + 1,
      updatedAt: nowIso(),
      deviceId,
      dirty: true,
    }
    await db.jobs.put(updated)
    return updated
  })
}

/** 删除任务（软删 + 级联删除事件与资源行）。 */
export async function deleteJob(db: LinguaFlowDatabase, jobId: number): Promise<void> {
  const deviceId = await getDeviceId(db)
  await db.transaction('rw', db.jobs, db.job_events, db.job_resources, async () => {
    const row = await db.jobs.where('localId').equals(jobId).first()
    if (!row || row.deletedAt !== null) {
      throw new RepositoryNotFoundError('任务', jobId)
    }
    // 仅终态任务可删除（对齐后端 `DELETE /jobs/{jobId}`）。
    const terminal =
      row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled'
    if (!terminal) {
      throw new RepositoryConflictError(`任务处于 ${row.status} 状态，不能删除`)
    }
    await db.jobs.put(softDelete(row, deviceId))
    const resources = await db.job_resources.where('job_id').equals(jobId).toArray()
    for (const resource of resources) {
      await db.job_resources.put(softDelete(resource, deviceId))
    }
    const events = await db.job_events.where('job_id').equals(jobId).toArray()
    await db.job_events.bulkDelete(events.map((e) => e.id))
  })
}

// ── 统计 ──

/** 用量统计 DTO（对齐后端 `service.UsageStats`）。 */
export interface UsageStatsDto {
  api_calls: number
  input_tokens: number
  output_tokens: number
  segment_count: number
  usage_records: number
  completed_jobs: number
  failed_jobs: number
}

/** 项目用量统计。 */
export async function usageStats(
  db: LinguaFlowDatabase,
  projectId: number | null,
): Promise<UsageStatsDto> {
  const records: UsageRecordRow[] = await db.usage_records
    .filter((row) => row.deletedAt === null && (projectId === null || row.project_id === projectId))
    .toArray()
  const jobs: JobRow[] = await db.jobs
    .filter((row) => row.deletedAt === null && (projectId === null || row.project_id === projectId))
    .toArray()
  return {
    api_calls: records.reduce((sum, row) => sum + row.api_calls, 0),
    input_tokens: records.reduce((sum, row) => sum + row.input_tokens, 0),
    output_tokens: records.reduce((sum, row) => sum + row.output_tokens, 0),
    segment_count: records.reduce((sum, row) => sum + row.segment_count, 0),
    usage_records: records.length,
    completed_jobs: jobs.filter((row) => row.status === 'completed').length,
    failed_jobs: jobs.filter((row) => row.status === 'failed').length,
  }
}

/** 系统统计 DTO（对齐后端 `service.SystemStats`）。 */
export interface SystemStatsDto {
  total_users: number
  active_users: number
  total_projects: number
  total_organizations: number
  total_jobs: number
  total_resources: number
}

/** 系统统计。 */
export async function systemStats(db: LinguaFlowDatabase): Promise<SystemStatsDto> {
  const projects = await db.projects.filter((row) => row.deletedAt === null).count()
  const resources = await db.resources.filter((row) => row.deletedAt === null).count()
  const jobs = await db.jobs.filter((row) => row.deletedAt === null).count()
  return {
    // 浏览器本地模式是**单用户**的：恒为 1 个本地用户、0 个组织。
    total_users: 1,
    active_users: 1,
    total_projects: projects,
    total_organizations: 0,
    total_jobs: jobs,
    total_resources: resources,
  }
}

// ── 活动日志 ──

/** 活动 DTO（对齐后端 `service.Activity`）。 */
export interface ActivityDto {
  id: number
  action: string
  resource_type: string
  resource_id?: number
  message?: string
  metadata?: Record<string, unknown>
  created_at: string
  updated_at: string
}

/** 活动日志行。 */
type ActivityFields = Omit<ActivityLogRow, keyof BaseRow>

/** 列出活动日志（按 `localId` 降序）。 */
export async function listActivity(
  db: LinguaFlowDatabase,
  limit: number,
  projectId?: number,
): Promise<ActivityLogRow[]> {
  const rows = await db.activity_logs
    .filter((row) => row.deletedAt === null)
    .toArray()
  const filtered =
    projectId === undefined
      ? rows
      : rows.filter((row) => row.metadata?.project_id === projectId)
  return filtered.sort((a, b) => b.localId - a.localId).slice(0, limit)
}

/** 活动行 → DTO。 */
export function toActivityDto(row: ActivityLogRow): ActivityDto {
  const resourceId = row.resource_id === null ? undefined : Number(row.resource_id)
  return {
    id: row.localId,
    action: row.action,
    resource_type: row.resource_type,
    ...(resourceId !== undefined && Number.isFinite(resourceId) ? { resource_id: resourceId } : {}),
    ...(row.message ? { message: row.message } : {}),
    ...(row.metadata ? { metadata: row.metadata } : {}),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

/** 写入一条活动日志。 */
export async function appendActivity(
  db: LinguaFlowDatabase,
  entry: {
    action: string
    resource_type: string
    resource_id?: string | null
    message?: string
    metadata?: Record<string, unknown> | null
  },
): Promise<ActivityLogRow> {
  const deviceId = await getDeviceId(db)
  return db.transaction('rw', db.activity_logs, db.sequences, async () => {
    const row = await newRow<ActivityFields>(db, {
      sequence: 'activity',
      deviceId,
      fields: {
        action: entry.action,
        resource_type: entry.resource_type,
        resource_id: entry.resource_id ?? null,
        message: entry.message ?? '',
        metadata: entry.metadata ?? null,
        visibility_scope: 'user',
      },
    })
    await db.activity_logs.put(row)
    return row
  })
}

/** 读取分页上限（后端默认 50，上限 200）。 */
export function readLimit(value: unknown, fallback = 50): number {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RepositoryValidationError('limit 不合法')
  }
  return Math.min(Math.trunc(parsed), 200)
}
