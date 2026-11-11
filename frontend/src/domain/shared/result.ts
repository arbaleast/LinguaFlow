/**
 * 领域层统一返回值类型。
 *
 * Go 侧的错误处理惯用法是 `(value, error)` 二元返回；浏览器优先架构把领域层
 * 移到 TypeScript 后，需要一个等价的显式错误载体。`Result<T, E>` 采用
 * 「成功/失败」判别联合（discriminated union），强制调用方在类型层面处理失败分支。
 */

/** 领域层通用错误。 */
export interface DomainError {
  /** 机器可读的错误码，例如 `repair.json.trailing_comma`。 */
  readonly code: string
  /** 人类可读的描述。 */
  readonly message: string
  /** 原始错误对象（可选）。 */
  readonly cause?: unknown
}

/** 成功分支。 */
export interface Ok<T> {
  readonly ok: true
  readonly value: T
}

/** 失败分支。 */
export interface Err<E = DomainError> {
  readonly ok: false
  readonly error: E
}

/** 领域层返回值：`ok` 为真表示 `value` 有效，否则 `error` 有效。 */
export type Result<T, E = DomainError> = Ok<T> | Err<E>

/** 构造成功结果。 */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value }
}

/** 构造失败结果。 */
export function err<E = DomainError>(error: E): Err<E> {
  return { ok: false, error }
}

/** 构造带错误码的领域错误。 */
export function domainError(code: string, message: string, cause?: unknown): DomainError {
  return cause === undefined ? { code, message } : { code, message, cause }
}

/** 判断是否为成功结果。 */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok
}

/** 判断是否为失败结果。 */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok
}

/** 取出成功值；失败时抛出携带错误码的异常。 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value
  const e = result.error as unknown
  const message =
    e && typeof e === 'object' && 'message' in e
      ? String((e as { message: unknown }).message)
      : String(e)
  throw new Error(message)
}

/** 取出成功值；失败时返回缺省值。 */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback
}

/** 把 `Result` 映射为另一类型（保持成功/失败结构）。 */
export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result
}
