/**
 * `domain/script` 聚合出口（对应 Go `backend/internal/script`）。
 *
 * 提供「同一语言、多种文字系统」检测的单一事实来源：
 * - {@link resolveProfile}：目标语言 tag → 期望文字系统 + 兄弟文字系统；
 * - {@link scanProfile}：扫描兄弟文字系统的专属字符证据；
 * - {@link runeScript}：单个 rune 的简繁/文字系统归属；
 * - {@link HANS_SPECIFIC_CHARS} / {@link HANT_SPECIFIC_CHARS}：生成字表静态数据。
 */
export * from './han'
export * from './resolve'
export * from './scan'
export * from './tables'
export * from './types'
