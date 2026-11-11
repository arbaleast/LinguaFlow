/**
 * LocalGateway 的路由表与请求上下文。
 *
 * ## 路由匹配
 *
 * 匹配的是 **openapi-fetch 的 schema path 模板**（如
 * `/projects/{projectId}/resources/{resourceId}/segments`），
 * 而不是展开后的真实 URL —— 因为 `src/api/*.ts` 调用 `client.GET(path, options)`
 * 时传入的就是模板，路径参数在 `options.params.path` 里。
 *
 * 这样路由表与后端的 OpenAPI 定义**逐字对应**，新增端点时不会出现两套 URL 约定。
 */
import type { GatewayResult, HttpMethod } from '@/gateway/contracts'
import type { CredentialVault } from '@/infrastructure/crypto/vault'
import type { LinguaFlowDatabase } from '@/infrastructure/indexeddb/db'
import type { BlobStore } from '@/infrastructure/opfs/types'

/** 本地请求上下文。 */
export interface LocalRequestContext {
  /** 本地数据库。 */
  db: LinguaFlowDatabase
  /** 二进制对象存储。 */
  blobs: BlobStore
  /** 凭据密文保险库。 */
  vault: CredentialVault
  /** 已绑定的路径参数（键为 `{param}` 去掉花括号后的名字）。 */
  path: Record<string, string>
  /** 查询参数。 */
  query: Record<string, unknown>
  /** 请求体。 */
  body: unknown
  /** 取消信号。 */
  signal?: AbortSignal
}

/** 本地处理器。 */
export type LocalHandler = (
  ctx: LocalRequestContext,
) => Promise<GatewayResult<unknown>> | GatewayResult<unknown>

/** 本地路由。 */
export interface LocalRoute {
  /** HTTP 方法。 */
  method: HttpMethod
  /** openapi-fetch 的 schema path 模板。 */
  path: string
  /** 处理器。 */
  handler: LocalHandler
}

/** 路由匹配结果。 */
export interface RouteMatch {
  /** 命中的处理器。 */
  handler: LocalHandler
  /** 绑定后的路径参数。 */
  path: Record<string, string>
}

/**
 * 把 schema path 模板与实际路径参数绑定。
 *
 * 模板形如 `/projects/{projectId}/resources/{resourceId}/segments`；
 * `params` 是 `options.params.path`（键名与占位符同名）。
 */
export function bindPathParams(
  template: string,
  params: Record<string, unknown> | undefined,
): Record<string, string> {
  const bound: Record<string, string> = {}
  if (!params) return bound
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    bound[key] = String(value)
  }
  return bound
}

/** 路由表。 */
export class LocalRouter {
  private readonly routes = new Map<string, LocalRoute>()

  /** 注册一条路由。 */
  add(method: HttpMethod, path: string, handler: LocalHandler): this {
    this.routes.set(routeKey(method, path), { method, path, handler })
    return this
  }

  /** 批量注册路由。 */
  addAll(routes: readonly LocalRoute[]): this {
    for (const route of routes) {
      this.routes.set(routeKey(route.method, route.path), route)
    }
    return this
  }

  /** 查找匹配的路由。 */
  match(method: HttpMethod, path: string): RouteMatch | null {
    const route = this.routes.get(routeKey(method, path))
    if (!route) return null
    return { handler: route.handler, path: {} }
  }

  /** 已注册的路由数量（测试用）。 */
  get size(): number {
    return this.routes.size
  }

  /** 已注册的 schema path 清单（测试用）。 */
  list(): string[] {
    return [...this.routes.values()].map((r) => `${r.method} ${r.path}`).sort()
  }
}

/** 路由键。 */
function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`
}
