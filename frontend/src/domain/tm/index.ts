/**
 * `domain/tm` 聚合出口（对应 Go `backend/internal/tm` 的纯匹配部分）。
 *
 * 零 DOM / 零网络 / 零存储 / 零 Node API：存储通过 `TmStore` 注入，
 * `MemoryTmStore` 是随包提供的纯内存实现。
 */
export * from './memory'
export * from './text'
export * from './tm'
export * from './types'
