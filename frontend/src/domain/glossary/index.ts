/**
 * `domain/glossary` 聚合出口（对应 Go `backend/internal/glossary`）。
 *
 * 纯函数 + 纯内存状态：零 DOM、零网络、零存储、零 Node API。
 * CSV 内容以字符串进出，落盘通过注入的 `GlossarySink`。
 */
export * from './csv'
export * from './file'
export * from './replace'
export * from './text'
export * from './types'
