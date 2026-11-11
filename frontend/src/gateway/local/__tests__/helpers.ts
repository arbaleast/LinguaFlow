/**
 * 本地网关测试的公共工具。
 *
 * `invoke` 直接按「方法 + schema path 模板」定位路由并调用处理器，
 * 不经过 HTTP 层（与 `LocalGateway.handle` 的分发语义一致）。
 */
import type { GatewayResult } from '@/gateway/contracts'

import type { LocalRequestContext, LocalRoute } from '../router'

/** 构造请求上下文（`blobs` / `vault` 在纯 Repository 测试中不需要真实实现）。 */
export function context(
  path: Record<string, string> = {},
  body: unknown = undefined,
  query: Record<string, unknown> = {},
  db?: LocalRequestContext['db'],
): LocalRequestContext {
  return {
    db: (db ?? ({} as LocalRequestContext['db'])) as LocalRequestContext['db'],
    blobs: {} as LocalRequestContext['blobs'],
    vault: {} as LocalRequestContext['vault'],
    path,
    query,
    body,
  }
}

/** 调用指定路由的处理器。 */
export async function invoke(
  routes: readonly LocalRoute[],
  method: LocalRoute['method'],
  path: string,
  requestContext: LocalRequestContext,
): Promise<GatewayResult<unknown>> {
  const matched = routes.find((route) => route.method === method && route.path === path)
  if (!matched) throw new Error(`未注册路由：${method} ${path}`)
  return matched.handler(requestContext)
}
