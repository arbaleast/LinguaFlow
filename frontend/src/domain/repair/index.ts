/**
 * `domain/repair` 聚合出口。
 *
 * 对应 Go `backend/internal/repair`：LLM 响应的「主动修复」算子——在解析失败
 * 之前尽力把看似畸形但可救活的内容修成可解析的 JSON/文本 envelope。
 */
export * from './types'
export * from './config'
export * from './json'
export * from './json_parse'
export * from './placeholder'
export * from './prompt'
export * from './repair'
export * from './schema'
export * from './text'
export * from './bootstrap_text'
export * from './envelope'
export * from './ruby_raw'
export * from './ruby_state'
export * from './strings'
export * from './values'
