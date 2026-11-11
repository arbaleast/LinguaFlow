/**
 * QA 重检端点（对齐 OpenAPI `POST /projects/{projectId}/qa-recheck`）。
 *
 * | 方法 | 路径 | 响应 |
 * |---|---|---|
 * POST | `/projects/{projectId}/qa-recheck` | `QaRecheckResult` |
 *
 * 本地实现用 Phase 1 移植的 `domain/qa` 引擎复刻后端行为：
 * 策略未启用 QA → 400；执行策略不存在 → 404；段落问题按指纹对账后写回。
 */
import type { ApiSchemas, GatewayResult } from '@/gateway/contracts'

import { qaRecheck, type QaRecheckRequest } from '../repositories/qa_recheck'
import { RepositoryValidationError } from '../repositories/errors'
import { json } from '../responses'
import type { LocalRoute } from '../router'
import { bodyObject, pathId, route } from './support'

/** 从请求体里读取可选的 ID 数组（非法元素整体忽略，缺省为 `undefined`）。 */
function optionalIdArray(
  body: Record<string, unknown>,
  key: string,
): number[] | undefined {
  const raw = body[key]
  if (!Array.isArray(raw)) return undefined
  const out: number[] = []
  for (const item of raw) {
    if (typeof item === 'number' && Number.isSafeInteger(item) && item > 0) {
      out.push(item)
    }
  }
  return out.length > 0 ? out : undefined
}

/** 从请求体里读取可选的字符串数组。 */
function optionalStringArray(
  body: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const raw = body[key]
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  for (const item of raw) {
    if (typeof item === 'string' && item !== '') out.push(item)
  }
  return out.length > 0 ? out : undefined
}

export const qaRecheckRoutes: LocalRoute[] = [
  {
    method: 'POST',
    path: '/projects/{projectId}/qa-recheck',
    handler: (ctx): Promise<GatewayResult<unknown>> =>
      route(async () => {
        const projectId = pathId(ctx, 'projectId')
        const body = bodyObject(ctx)
        const profileId = Number(body.profile_id)
        if (!Number.isSafeInteger(profileId) || profileId <= 0) {
          throw new RepositoryValidationError('profile_id 不合法')
        }
        const request: QaRecheckRequest = {
          profile_id: profileId,
          resource_ids: optionalIdArray(body, 'resource_ids'),
          segment_ids: optionalIdArray(body, 'segment_ids'),
          segment_group_keys: optionalStringArray(body, 'segment_group_keys'),
        }
        const result = await qaRecheck(ctx.db, projectId, request)
        return json(result as unknown as ApiSchemas['QaRecheckResult'])
      }),
  },
]
