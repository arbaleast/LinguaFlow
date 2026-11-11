/**
 * 全部 per-batch checker 的聚合出口（对应 Go `internal/qa/checker_*.go`）。
 *
 * 共 19 个独立 checker，每个都有独立的 issue code。执行顺序由
 * `engine.ts` 的 `buildAllCheckers` 决定（与 Go 的注册表顺序一致），
 * 与这里的导出顺序无关。
 */
export * from './untranslated'
export * from './length'
export * from './duplicate'
export * from './source_residual'
export * from './punctuation_pairing'
export * from './punctuation_missing'
export * from './punctuation_surplus'
export * from './punctuation_wrap_loss'
export * from './whitespace'
export * from './width_mix'
export * from './script_mismatch'
export * from './number'
export * from './url_email'
export * from './subtitle_line'
export * from './terminology'
export * from './placeholder_leak'
export * from './xml_tag'
export * from './punctuation_common'
