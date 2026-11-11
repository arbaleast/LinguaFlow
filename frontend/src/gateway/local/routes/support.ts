/**
 * 路由层公共工具：路径参数解析、请求体校验与 Repository 错误 → HTTP Problem 映射。
 *
 * 状态码语义与后端 handler 对齐：
 *
 * | 错误 | 状态 |
 * |---|---|
 * | `RepositoryValidationError` | 400 |
 * | `RepositoryNotFoundError` | 404 |
 * | `RepositoryConflictError` / `ConflictError`（CAS） | 409 |
 * | 其他 | 500 |
 */
import type { GatewayResult } from '@/gateway/contracts'
import { ConflictError } from '@/infrastructure/indexeddb/repo'

import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  RepositoryValidationError,
} from '../repositories/errors'
import { badRequest, conflict, notFound, problem } from '../responses'
import type { LocalRequestContext } from '../router'

/** 读取必填的正整数路径参数（`projectId` / `resourceId` / `entryId`）。 */
export function pathId(ctx: LocalRequestContext, name: string): number {
  const raw = ctx.path[name]
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new RepositoryValidationError(`路径参数 ${name} 不合法`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RepositoryValidationError(`路径参数 ${name} 不合法`)
  }
  return value
}

/** 读取 JSON 对象请求体（非对象一律 400）。 */
export function bodyObject(ctx: LocalRequestContext): Record<string, unknown> {
  const body = ctx.body
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new RepositoryValidationError('请求体必须是 JSON 对象')
  }
  return body as Record<string, unknown>
}

/** 捕获 Repository 错误并转为 Problem 响应，供每个 handler 复用。 */
export async function route(
  handler: () => Promise<GatewayResult<unknown>> | GatewayResult<unknown>,
): Promise<GatewayResult<unknown>> {
  try {
    return await handler()
  } catch (error) {
    return errorResult(error)
  }
}

/** 错误 → Problem 响应（未知错误兜底 500）。 */
export function errorResult(error: unknown): GatewayResult<never> {
  if (error instanceof RepositoryValidationError) {
    return badRequest(error.message)
  }
  if (error instanceof RepositoryNotFoundError) {
    return notFound(error.message)
  }
  if (error instanceof RepositoryConflictError || error instanceof ConflictError) {
    return conflict(error.message)
  }
  return problem(500, '本地处理失败', error instanceof Error ? error.message : String(error))
}
