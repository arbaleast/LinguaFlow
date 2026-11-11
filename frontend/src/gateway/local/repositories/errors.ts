/**
 * 本地 Repository 的错误类型。
 *
 * 与 `infrastructure/indexeddb/repo.ts` 的 `ConflictError`（CAS 版本冲突）互补：
 * 这里覆盖「参数非法 / 实体不存在 / 唯一约束冲突」三类业务错误，由路由层
 * (`routes/support.ts`) 统一映射为 400 / 404 / 409 Problem 响应。
 *
 * 刻意不引入 HTTP 概念：Repository 只表达领域语义，状态码由路由层决定。
 */

/** 请求参数不合法（路由层映射 400）。 */
export class RepositoryValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RepositoryValidationError'
  }
}

/** 目标实体不存在或已软删（路由层映射 404）。 */
export class RepositoryNotFoundError extends Error {
  constructor(
    /** 实体类型（中文，用于错误详情）。 */
    readonly entity: string,
    /** 实体对外数字 ID。 */
    readonly id: number | string,
  ) {
    super(`${entity} ${String(id)} 不存在`)
    this.name = 'RepositoryNotFoundError'
  }
}

/**
 * 唯一约束冲突（路由层映射 409）。
 *
 * 术语表的条件唯一规则与 TM 的历史脏数据（同一 key 多行）都走这里；
 * 它与 `ConflictError` 的区别是：CAS 冲突携带期望/实际 revision，
 * 唯一约束冲突只说明「键已存在」。
 */
export class RepositoryConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RepositoryConflictError'
  }
}
