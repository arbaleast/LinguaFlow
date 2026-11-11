/**
 * 保护链的类型契约（对应 Go `backend/internal/protect`）。
 *
 * Go 侧的 `Protector` 接口操作 `*model.Segment`；本移植只保留保护链真正读写的字段
 * （`Source` / `Target` / `Protected` / `Meta`），避免领域层耦合到完整文档模型。
 */

/** 可被保护链处理的段落。 */
export interface ProtectableSegment {
  /** 原文；protect 之后变为含占位符的版本。 */
  source: string
  /** 译文；unprotect 还原占位符。 */
  target: string
  /** 占位符 → 原片段。 */
  protected: Record<string, string>
  /** 段级元信息（保护链副作用的落点，例如 ruby_items）。 */
  meta?: Record<string, unknown>
}

/** 保护器接口。 */
export interface Protector {
  /** 保护器名称（Go `Protector.Name`）。 */
  readonly name: string
  /** 把不应翻译的片段替换为占位符。 */
  protect(seg: ProtectableSegment): void
  /** 把占位符还原为原片段。 */
  unprotect(seg: ProtectableSegment): void
}

/** 占位符格式：固定 6 位数字、总长 14，纯 ASCII，主流 BPE 不易拆分。 */
export const PLACEHOLDER_FMT = '__LF_%06d__'

/** 占位符字面量的匹配形态（`__LF_` + 数字 + `__`）。 */
export const PLACEHOLDER_PATTERN = '__LF_\\d{6}__'
