/**
 * 任务 / 统计 / 活动日志端点（对齐 OpenAPI `/jobs...`、`/stats/summary`、`/activity`）。
 *
 * | 方法 | 路径 | 响应 |
 * |---|---|---|
 * | GET | `/projects/{projectId}/jobs` | `Job[]` |
 * | GET | `/jobs/{jobId}` | `Job` |
 * | GET | `/jobs/{jobId}/events` | `JobEvent[]` |
 * | POST | `/jobs/{jobId}/cancel` | 204 |
 * | POST | `/jobs/{jobId}/pause` | 204 |
 * | POST | `/jobs/{jobId}/resume` | 204 |
 * | POST | `/jobs/{jobId}/retry` | 204 |
 * | GET | `/stats/summary` | `SystemStats` |
 * | GET | `/activity` | `Activity[]` |
 */
import { json, noContent } from '../responses'
import type { LocalRoute } from '../router'
import { RepositoryNotFoundError } from '../repositories/errors'
import {
  deleteJob,
  getJob,
  listActivity,
  listJobEvents,
  listJobs,
  readLimit,
  setJobStatus,
  systemStats,
  toActivityDto,
  toJobDto,
} from '../repositories/jobs'
import { bodyObject, pathId, route } from './support'

/** 读取任务（或抛 404）。 */
async function requireJob(
  ctx: Parameters<NonNullable<LocalRoute['handler']>>[0],
  jobId: number,
) {
  const row = await getJob(ctx.db, jobId)
  if (!row) throw new RepositoryNotFoundError('任务', jobId)
  return row
}

export const jobRoutes: LocalRoute[] = [
  {
    method: 'GET',
    path: '/projects/{projectId}/jobs',
    handler: (ctx) =>
      route(async () => {
        const projectId = pathId(ctx, 'projectId')
        const rows = await listJobs(ctx.db, projectId)
        // 与 OpenAPI 契约对齐：列表统一 { items: [...] } 包装
        return json({ items: rows.map(toJobDto) })
      }),
  },
  {
    method: 'GET',
    path: '/jobs/{jobId}',
    handler: (ctx) =>
      route(async () => {
        const jobId = pathId(ctx, 'jobId')
        return json(toJobDto(await requireJob(ctx, jobId)))
      }),
  },
  {
    method: 'DELETE',
    path: '/jobs/{jobId}',
    handler: (ctx) =>
      route(async () => {
        const jobId = pathId(ctx, 'jobId')
        await deleteJob(ctx.db, jobId)
        return noContent()
      }),
  },
  {
    method: 'GET',
    path: '/jobs/{jobId}/events',
    handler: (ctx) =>
      route(async () => {
        const jobId = pathId(ctx, 'jobId')
        await requireJob(ctx, jobId)
        return json(await listJobEvents(ctx.db, jobId))
      }),
  },
  {
    method: 'POST',
    path: '/jobs/{jobId}/cancel',
    handler: (ctx) =>
      route(async () => {
        const jobId = pathId(ctx, 'jobId')
        await setJobStatus(ctx.db, jobId, 'cancelled')
        return noContent()
      }),
  },
  {
    method: 'POST',
    path: '/jobs/{jobId}/pause',
    handler: (ctx) =>
      route(async () => {
        const jobId = pathId(ctx, 'jobId')
        await setJobStatus(ctx.db, jobId, 'paused')
        return noContent()
      }),
  },
  {
    method: 'POST',
    path: '/jobs/{jobId}/resume',
    handler: (ctx) =>
      route(async () => {
        const jobId = pathId(ctx, 'jobId')
        await setJobStatus(ctx.db, jobId, 'running')
        return noContent()
      }),
  },
  {
    method: 'POST',
    path: '/jobs/{jobId}/retry',
    handler: (ctx) =>
      route(async () => {
        const jobId = pathId(ctx, 'jobId')
        await setJobStatus(ctx.db, jobId, 'pending')
        return noContent()
      }),
  },
]

export const statsRoutes: LocalRoute[] = [
  {
    method: 'GET',
    path: '/stats/summary',
    handler: (ctx) =>
      route(async () => json(await systemStats(ctx.db))),
  },
]

export const activityRoutes: LocalRoute[] = [
  {
    method: 'GET',
    path: '/activity',
    handler: (ctx) =>
      route(async () => {
        const limit = readLimit(ctx.query.limit)
        const projectIdRaw = ctx.query.project_id
        const projectId =
          projectIdRaw === undefined || projectIdRaw === ''
            ? undefined
            : Number(projectIdRaw)
        const rows = await listActivity(ctx.db, limit, projectId)
        return json(rows.map(toActivityDto))
      }),
  },
]
