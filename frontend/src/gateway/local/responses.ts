/**
 * LocalGateway 的响应构造与错误映射。
 *
 * 形状与 openapi-fetch 的返回值完全一致（`{ data, error, response }`），
 * 使 `src/api/*.ts` 的既有调用代码**一行都不用改**。
 */
import type { GatewayResult } from '@/gateway/contracts'

/** 构造成功响应。 */
export function json<T>(data: T, status = 200): GatewayResult<T> {
  return {
    data,
    error: undefined,
    response: new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  }
}

/** 构造无内容响应（204）。 */
export function noContent(): GatewayResult<undefined> {
  return {
    data: undefined,
    error: undefined,
    response: new Response(null, { status: 204 }),
  }
}

/** RFC 7807 Problem 形态的错误体。 */
export interface LocalProblem {
  type?: string
  title: string
  detail?: string
  status: number
  [key: string]: unknown
}

/** 构造错误响应。 */
export function problem(
  status: number,
  title: string,
  detail?: string,
  extra?: Record<string, unknown>,
): GatewayResult<never> {
  const body: LocalProblem = { title, status, ...(detail ? { detail } : {}), ...extra }
  return {
    data: undefined,
    error: body,
    response: new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/problem+json' },
    }),
  }
}

/** 404。 */
export function notFound(detail: string): GatewayResult<never> {
  return problem(404, '资源不存在', detail)
}

/** 400（参数非法）。 */
export function badRequest(detail: string): GatewayResult<never> {
  return problem(400, '请求参数不合法', detail, { error_code: 'invalid_request' })
}

/** 409（版本冲突 / 唯一约束冲突）。 */
export function conflict(detail: string): GatewayResult<never> {
  return problem(409, '状态冲突', detail, { error_code: 'conflict' })
}

/** 403（无权限）。 */
export function forbidden(detail: string): GatewayResult<never> {
  return problem(403, '无权访问', detail, { error_code: 'forbidden' })
}

/** 507（配额不足）。 */
export function quotaExceeded(detail: string): GatewayResult<never> {
  return problem(507, '本地存储配额不足', detail, { error_code: 'quota_exceeded' })
}
