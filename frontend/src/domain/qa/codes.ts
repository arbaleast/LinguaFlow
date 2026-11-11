/**
 * issue code 词表与维护清单（对应 Go `backend/internal/qa/qa.go` 前 400 行）。
 *
 * 这里是「哪些 code 存在、各自由谁维护」的单一事实来源：筛选白名单、语义质检
 * code 集合、可裁决集合、守恒类集合全部在此派生，新增 code 只需改一处。
 */

// ---- 全部确定性 checker 名称（与 Checker.name() / issue code 对齐）----

/** 未翻译（源文与译文相同）。 */
export const CHECK_UNTRANSLATED = 'untranslated'
/** 译文长度比异常。 */
export const CHECK_LENGTH_RATIO = 'length_ratio'
/** 同批不同原文命中相同译文。 */
export const CHECK_DUPLICATE = 'duplicate'
/** 译文残留源语片段。 */
export const CHECK_SOURCE_RESIDUAL = 'source_residual'
/** 标点配对异常。 */
export const CHECK_PUNCTUATION_PAIRING = 'punctuation_pairing'
/** 译文缺失源文的整类包裹标点。 */
export const CHECK_PUNCTUATION_MISSING = 'punctuation_missing'
/** 译文多出源文没有的包裹标点。 */
export const CHECK_PUNCTUATION_SURPLUS = 'punctuation_surplus'
/** 源文整体被引号包裹而译文丢失外层包裹。 */
export const CHECK_PUNCTUATION_WRAP_LOSS = 'punctuation_wrap_loss'
/** 异常空白字符。 */
export const CHECK_WHITESPACE_IRREGULAR = 'whitespace_irregular'
/** 连续空格 / CJK 字符间多余空格。 */
export const CHECK_REPEATED_SPACE = 'repeated_space'
/** 全半角混用。 */
export const CHECK_WIDTH_MIX = 'width_mix'
/** 译文文字系统与目标语言不符。 */
export const CHECK_SCRIPT_MISMATCH = 'script_mismatch'
/** 数字不一致。 */
export const CHECK_NUMBER_MISMATCH = 'number_mismatch'
/** URL / 邮箱不一致。 */
export const CHECK_URL_EMAIL_MISMATCH = 'url_email_mismatch'
/** 字幕行数不一致。 */
export const CHECK_SUBTITLE_LINE_COUNT = 'subtitle_line_count'
/** 译文含禁译词。 */
export const CHECK_FORBIDDEN_TERM = 'forbidden_term'
/** 术语未使用推荐译法。 */
export const CHECK_TERM_INCONSISTENCY = 'term_inconsistency'
/** 译文残留占位符。 */
export const CHECK_LEFTOVER_PLACEHOLDER = 'leftover_placeholder'
/** XML 标签不一致 / 结构损坏。 */
export const CHECK_XML_TAG_MISMATCH = 'xml_tag_mismatch'
/** 文档级：相同原文译文不一致。 */
export const CODE_DUPLICATE_SOURCE_DIVERGENCE = 'duplicate_source_divergence'

// ---- 语义质检（semantic QA）维护的 issue code ----

/** 硬译 / 仿译。 */
export const ISSUE_CODE_CALQUE = 'calque'
/** 术语保真度。 */
export const ISSUE_CODE_TERM_FIDELITY = 'term_fidelity'
/** 自然度。 */
export const ISSUE_CODE_NATURALNESS = 'naturalness'
/** 误译。 */
export const ISSUE_CODE_MISTRANSLATION = 'mistranslation'
/** 漏译。 */
export const ISSUE_CODE_OMISSION = 'omission'
/** 增译 / 擅自添加。 */
export const ISSUE_CODE_ADDITION = 'addition'
/** 语法问题。 */
export const ISSUE_CODE_GRAMMAR = 'grammar'
/** 语域 / 风格问题。 */
export const ISSUE_CODE_REGISTER = 'register'

// ---- 守恒类检查（ConservationCodes）产出的 issue code ----

/** 注音还原不完整。 */
export const CODE_RUBY_RESTORE_INCOMPLETE = 'ruby_restore_incomplete'
/** 编辑导致译文注音全丢失。 */
export const CODE_RUBY_TAG_LOSS = 'ruby_tag_loss'

/** 返回语义质检维护的全部 issue code（Go `SemanticQACodes`）。 */
export function semanticQACodes(): string[] {
  return [
    ISSUE_CODE_CALQUE,
    ISSUE_CODE_TERM_FIDELITY,
    ISSUE_CODE_NATURALNESS,
    ISSUE_CODE_MISTRANSLATION,
    ISSUE_CODE_OMISSION,
    ISSUE_CODE_ADDITION,
    ISSUE_CODE_GRAMMAR,
    ISSUE_CODE_REGISTER,
  ]
}

/** 语义 code 的 set 视图，供高频判定复用。 */
const semanticQACodeSet: ReadonlySet<string> = new Set(semanticQACodes())

/** 报告 code 是否由语义质检轮次维护（Go `IsSemanticQACode`）。 */
export function isSemanticQACode(code: string): boolean {
  return semanticQACodeSet.has(code)
}

/**
 * 返回可交由裁决（adjudicate）轮做 LLM 降噪的 issue code（Go `AdjudicableCodes`）。
 *
 * 不可裁决的硬规则 `duplicate` 永不列入：它需同批多段输入，无单段裁决语义。
 */
export function adjudicableCodes(): string[] {
  return [CHECK_UNTRANSLATED, CHECK_SOURCE_RESIDUAL, CHECK_LENGTH_RATIO, CHECK_PUNCTUATION_SURPLUS]
}

/** 可裁决 code 的 set 视图。 */
const adjudicableCodeSet: ReadonlySet<string> = new Set(adjudicableCodes())

/** 报告 code 是否为可裁决 code（Go `IsAdjudicableCode`）。 */
export function isAdjudicableCode(code: string): boolean {
  return adjudicableCodeSet.has(code)
}

/**
 * 返回执行计划未显式配置 `adjudicate_codes` 时的默认裁决集
 * （Go `DefaultAdjudicateCodes`）。必须是 {@link adjudicableCodes} 的子集。
 */
export function defaultAdjudicateCodes(): string[] {
  return [CHECK_SOURCE_RESIDUAL, CHECK_PUNCTUATION_SURPLUS]
}

/** 返回文档级（非 per-batch）检查产出的 issue code（Go `DocumentCheckerCodes`）。 */
export function documentCheckerCodes(): string[] {
  return [CODE_DUPLICATE_SOURCE_DIVERGENCE]
}

/** 返回注音守恒类检查产出的全部 issue code（Go `ConservationCodes`）。 */
export function conservationCodes(): string[] {
  return [CODE_RUBY_RESTORE_INCOMPLETE, CODE_RUBY_TAG_LOSS]
}

/** 守恒 code 的 set 视图。 */
const conservationCodeSet: ReadonlySet<string> = new Set(conservationCodes())

/** 报告 code 是否由守恒类写路径维护（Go `IsConservationCode`）。 */
export function isConservationCode(code: string): boolean {
  return conservationCodeSet.has(code)
}

/** 合并两个字符串列表并去重，保留首次出现的顺序（Go `mergeUnique`）。 */
function mergeUnique(a: readonly string[], b: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of a) {
    if (seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  for (const s of b) {
    if (seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

/**
 * 返回执行计划 `issue_codes` 与段落列表 `quality_code` 接受的全部 issue code
 * （Go `FilterableIssueCodes`）：per-batch checker + 文档级 + 语义 + 守恒。
 */
export function filterableIssueCodes(): string[] {
  return mergeUnique(
    mergeUnique(mergeUnique(allCheckerNames(), documentCheckerCodes()), semanticQACodes()),
    conservationCodes(),
  )
}

/** 可筛 code 的 set 视图。 */
const filterableIssueCodeSet: ReadonlySet<string> = new Set(filterableIssueCodes())

/** 报告 code 是否可作为合法筛选值（Go `IsFilterableIssueCode`）。 */
export function isFilterableIssueCode(code: string): boolean {
  return filterableIssueCodeSet.has(code)
}

/** 返回全部可配置的 per-batch checker 名称（Go `AllCheckerNames`，顺序即注册顺序）。 */
export function allCheckerNames(): string[] {
  return [
    CHECK_UNTRANSLATED,
    CHECK_LENGTH_RATIO,
    CHECK_DUPLICATE,
    CHECK_SOURCE_RESIDUAL,
    CHECK_PUNCTUATION_PAIRING,
    CHECK_PUNCTUATION_MISSING,
    CHECK_PUNCTUATION_SURPLUS,
    CHECK_PUNCTUATION_WRAP_LOSS,
    CHECK_WHITESPACE_IRREGULAR,
    CHECK_REPEATED_SPACE,
    CHECK_WIDTH_MIX,
    CHECK_SCRIPT_MISMATCH,
    CHECK_NUMBER_MISMATCH,
    CHECK_URL_EMAIL_MISMATCH,
    CHECK_SUBTITLE_LINE_COUNT,
    CHECK_FORBIDDEN_TERM,
    CHECK_TERM_INCONSISTENCY,
    CHECK_LEFTOVER_PLACEHOLDER,
    CHECK_XML_TAG_MISMATCH,
  ]
}

/**
 * 返回无需用户额外配置阈值、单段即可判定的确定性 checker 白名单
 * （Go `ZeroConfigDeterministicChecks`）：手动编辑译文等读不到执行计划的即时场景用。
 *
 * 排除：length_ratio（依赖阈值）、forbidden_term / term_inconsistency（依赖术语表）、
 * duplicate（需同批多段）、duplicate_source_divergence（文档级）。
 */
export function zeroConfigDeterministicChecks(): string[] {
  return [
    CHECK_UNTRANSLATED,
    CHECK_SOURCE_RESIDUAL,
    CHECK_PUNCTUATION_PAIRING,
    CHECK_PUNCTUATION_MISSING,
    CHECK_PUNCTUATION_SURPLUS,
    CHECK_PUNCTUATION_WRAP_LOSS,
    CHECK_WHITESPACE_IRREGULAR,
    CHECK_REPEATED_SPACE,
    CHECK_WIDTH_MIX,
    CHECK_SCRIPT_MISMATCH,
    CHECK_NUMBER_MISMATCH,
    CHECK_URL_EMAIL_MISMATCH,
    CHECK_SUBTITLE_LINE_COUNT,
    CHECK_LEFTOVER_PLACEHOLDER,
    CHECK_XML_TAG_MISMATCH,
  ]
}
