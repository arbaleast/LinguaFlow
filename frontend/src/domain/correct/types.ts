/**
 * 纠错规则引擎的公共类型（对应 Go `backend/internal/correct` 与 `model.Segment` 的
 * 最小投影，以及 `qa.QualityIssue` 的只读投影）。
 */

/** 规则名白名单（与 Go 常量逐字一致，亦是 OpenAPI enum 的单一来源）。 */
export const RULE_PUNCTUATION_MISSING_WRAP = 'punctuation_missing_wrap'
export const RULE_PUNCTUATION_WRAP_LOSS_WRAP = 'punctuation_wrap_loss_wrap'
export const RULE_WIDTH_MIX_NORMALIZE = 'width_mix_normalize'

/** QA issue code（规则触发条件；与 Go `qa.Check*` 常量一致）。 */
export const CHECK_PUNCTUATION_MISSING = 'punctuation_missing'
export const CHECK_PUNCTUATION_WRAP_LOSS = 'punctuation_wrap_loss'
export const CHECK_WIDTH_MIX = 'width_mix'

/** 裁决值：dismissed 的 issue 对规则不可见。 */
export const DISPOSITION_DISMISSED = 'dismissed'

/** 质量问题在目标文本中的跨度（只保留规则真正读取的字段）。 */
export interface QualitySpan {
  /** 触发问题的精确文本。 */
  matchedText: string
  targetStart?: number | null
  targetEnd?: number | null
}

/** 质量问题（只保留规则真正读取的字段）。 */
export interface QualityIssue {
  code: string
  severity?: string
  message?: string
  span?: QualitySpan | null
  /** 裁决信息：空串 / `pending` 视为未决，`dismissed` 对规则不可见。 */
  disposition?: string
}

/** 待纠错段落（Go `model.Segment` 的最小投影）。 */
export interface CorrectableSegment {
  /** 原文（protect 之后含占位符的版本）。 */
  source: string
  /** 译文；纠错规则只读不写，改写结果经 {@link CorrectionResult.newTarget} 返回。 */
  target: string
  /** 占位符 → 原片段。 */
  protected: Record<string, string>
  /** 质量问题（只有 pending issue 能触发机械修复）。 */
  issues: QualityIssue[]
}

/** 单条规则应用结果（Go `CorrectionResult`）。 */
export interface CorrectionResult {
  changed: boolean
  newTarget: string
  /** 审计 op，如 `"punctuation_missing.wrap"`。 */
  op: string
  /** 本规则声称解决的 issue code。 */
  resolvedCodes: string[]
  /** `changed=false` 时解释 no-op 原因。 */
  reason: string
}

/** 构造零值结果（Go `CorrectionResult{}`）。 */
export function emptyCorrectionResult(): CorrectionResult {
  return { changed: false, newTarget: '', op: '', resolvedCodes: [], reason: '' }
}

/** 单条规则配置（Go `correct.RuleConfig`）。 */
export interface CorrectRuleConfig {
  name: string
  enabled: boolean
}

/** 引擎配置（Go `correct.Config`）。 */
export interface CorrectConfig {
  rules: CorrectRuleConfig[]
  concurrency?: number
}

/** 单条机械修正规则（Go `correct.Rule` 接口）。 */
export interface CorrectRule {
  /** 规则名（白名单常量）。 */
  name(): string
  /** 对段落应用规则；不得修改入参。 */
  apply(seg: CorrectableSegment): CorrectionResult
  /** 规则生效时解决的 issue code。 */
  resolvedCodes(): string[]
}
