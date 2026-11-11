/**
 * `domain/qa` 聚合出口（对应 Go `backend/internal/qa`）。
 *
 * 分层：
 * - `types.ts`：内存态类型契约（Span / QualityIssue / CheckInput / Checker / Config）；
 * - `issue.ts`：持久化 JSON 契约（snake_case 字段名，复刻 Go 的自定义序列化）；
 * - `span.ts`：rune 偏移精度的 Span 定位；
 * - `protect_region.ts`：内联标记保护区；
 * - `scripts.ts`：语言 → Unicode Script 集合；
 * - `codes.ts`：issue code 词表与维护清单；
 * - `qa.ts`：指纹、裁决对账、配置开关；
 * - `engine.ts`：引擎编排；
 * - `checkers/`：19 个独立 checker；
 * - `consistency.ts` / `conservation.ts`：文档级与守恒类检查。
 */
export * from './checkers'
export * from './codes'
export * from './conservation'
export * from './consistency'
export * from './engine'
export * from './glossary'
export * from './issue'
export * from './protect_region'
export * from './qa'
export * from './scripts'
export * from './span'
export * from './types'
