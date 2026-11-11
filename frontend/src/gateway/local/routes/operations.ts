/**
 * 「操作」投影路由（对应后端 `api/handler_operation.go`）。
 *
 * 本地模式没有后端账号体系（`/users/me` 见 `routes/users.ts`）；
 * `/operations*` 从本地 `jobs` / `storage_tasks` 表做只读投影。
 */
import { json } from '../responses'
import type { LocalRoute } from '../router'
import {
  OPERATION_TASK_TYPES,
  batchDeleteOperations,
  getOperationsSummary,
  listOperations,
  type OperationTaskType,
} from '../repositories/operations'
import { bodyObject, route } from './support'

/** 读取正整数查询参数（缺省返回 `undefined`）。 */
function optionalNumber(query: Record<string, unknown>, name: string): number | undefined {
  const raw = query[name]
  if (raw === undefined || raw === null || raw === '') return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** 读取枚举查询参数（非法值返回 `undefined`，等价后端的「忽略非法筛选」）。 */
function optionalEnum<T extends string>(
  query: Record<string, unknown>,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const raw = query[name]
  if (typeof raw !== 'string') return undefined
  const value = raw as T
  return allowed.includes(value) ? value : undefined
}

/** 本地操作投影路由。 */
export const operationRoutes: LocalRoute[] = [
  {
    method: 'GET',
    path: '/operations',
    handler: (ctx) =>
      route(async () => {
        const result = await listOperations(ctx.db, {
          projectId: optionalNumber(ctx.query, 'project_id'),
          taskType: optionalEnum(ctx.query, 'task_type', OPERATION_TASK_TYPES) as
            | OperationTaskType
            | undefined,
          state: optionalEnum(ctx.query, 'state', ['active', 'all'] as const),
          limit: optionalNumber(ctx.query, 'limit'),
        })
        return json(result)
      }),
  },
  {
    method: 'GET',
    path: '/operations/summary',
    handler: (ctx) =>
      route(async () => {
        const result = await getOperationsSummary(ctx.db, {
          projectId: optionalNumber(ctx.query, 'project_id'),
          taskType: optionalEnum(ctx.query, 'task_type', OPERATION_TASK_TYPES) as
            | OperationTaskType
            | undefined,
        })
        return json(result)
      }),
  },
  {
    method: 'POST',
    path: '/operations/batch-delete',
    handler: (ctx) =>
      route(async () => {
        const body = bodyObject(ctx)
        const items = (body.items ?? []) as Array<Record<string, unknown>>
        const result = await batchDeleteOperations(
          ctx.db,
          items.map((item) => ({
            kind: String(item.kind ?? ''),
            id: String(item.id ?? ''),
            project_id: Number(item.project_id),
          })),
        )
        return json(result)
      }),
  },
]
