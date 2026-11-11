/**
 * 单键数组 envelope 修复（对应 Go `backend/internal/repair/envelope.go`）。
 *
 * 覆盖 semantic_qa(`{"issues":[...]}`)、adjudicate(`{"verdicts":[...]}`)、
 * ruby alignment(`{"ruby_output":[...]}`)、revise(`{"revisions":[...]}`) 等响应。
 * 这些响应与 translate envelope 不同：值是数组而非 ID-keyed map，因此不做
 * wantIDs 校验、不做多对象合并。
 */
import {
  closeUnbalancedBraces,
  escapeControlChars,
  escapeUnescapedQuotes,
  extractBareArrayAsEnvelope,
  extractJSONObjectContaining,
  extractValidObject,
  fixTrailingCommas,
  stripBOMAndZeroWidth,
} from './json'
import { marshalGo } from './json_parse'
import { closeBracesFallback, prependSalvageOp, salvageCut } from './repair'
import { collectSectionLines } from './text'
import {
  decodeAdjudicationVerdicts,
  decodeReviseRevisions,
  decodeSemanticQAIssues,
  normalizeAdjudicationVerdicts,
  normalizeReviseRevisions,
  normalizeSemanticQAIssues,
  parseAdjudicationTextVerdicts,
  parseReviseTextRevisions,
  parseSemanticQATextIssues,
  validBareVerdictEntries,
} from './deps/prompt_protocol'
import {
  decodeOutputEntriesPlain,
  normalizeOutputEntries,
  parseOutputMap,
  parseSectionRubyOutput,
  validBareOutputEntries,
} from './deps/ruby_protocol'
import {
  enterSalvage,
  withoutSalvage,
  type AdjudicationVerdict,
  type EnvelopeRepairResult,
  type KeyedRepairResult,
  type RepairOptions,
  type ReviseRevision,
  type RubyOutputEntry,
  type RubyOutputMap,
  type SemanticQAIssue,
} from './types'
import { unmarshalGeneric } from './values'

/** 把错误归一为消息字符串。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 要求 key 的值为 JSON 数组（Go `arrayValueAccept`）。 */
export function arrayValueAccept(key: string): (raw: Record<string, unknown>) => boolean {
  return (raw) => Array.isArray(raw[key])
}

/**
 * 修复单键数组 JSON envelope `{"<key>": [...]}`（Go `TryRepairEnvelope`）。
 *
 * 修复链与 `tryRepair` 的 L1 结构修复一致，但 key 无关，且要求 key 的值为
 * JSON 数组——用于在「补齐括号后得到同名外层包装」时跳过错误候选。
 */
export function tryRepairEnvelope(
  text: string,
  key: string,
  opt: RepairOptions,
): EnvelopeRepairResult {
  let repaired: string[] = []
  const accept = arrayValueAccept(key)

  if (opt.jsonStructural) {
    const cleaned = stripBOMAndZeroWidth(text)
    if (cleaned.did) repaired = [...repaired, 'json.strip-bom-zw']
    text = cleaned.text
  }

  let body = extractJSONObjectContaining(text, key)
  if (body === '' && opt.jsonStructural && opt.salvageDeclined !== true) {
    const fallback = closeBracesFallback(text, repaired, (fixed) =>
      extractJSONObjectContaining(fixed, key),
    )
    body = fallback.body
    repaired = fallback.repaired
  }

  let raw: Record<string, unknown> | null = null
  let parseError: string | null = null
  try {
    raw = unmarshalGeneric(body)
  } catch (error) {
    parseError = errorMessage(error)
  }

  if (raw === null && opt.jsonStructural) {
    let fixed = body
    let value = fixTrailingCommas(fixed)
    if (value !== fixed) {
      fixed = value
      repaired = [...repaired, 'json.trailing-comma']
    }
    value = escapeControlChars(fixed)
    if (value !== fixed) {
      fixed = value
      repaired = [...repaired, 'json.escape-control']
    }
    value = escapeUnescapedQuotes(fixed)
    if (value !== fixed) {
      fixed = value
      repaired = [...repaired, 'json.escape-quotes']
    }
    value = closeUnbalancedBraces(fixed)
    if (value !== fixed) {
      fixed = value
      repaired = [...repaired, 'json.close-braces']
    }
    if (fixed !== body) {
      try {
        raw = unmarshalGeneric(fixed)
        parseError = null
      } catch (error) {
        parseError = errorMessage(error)
      }
    }
  }

  // 主链路解析成功但 key 值非数组：视为失败以触发鲁棒兜底。
  if (raw !== null && !accept(raw)) {
    parseError = `"${key}" field is not an array`
    raw = null
  }

  // 鲁棒兜底：结巴/重复前缀或括号相位错乱。
  if (raw === null && opt.jsonStructural) {
    const robust = extractValidObject(text, key, accept, opt.salvageDeclined !== true)
    if (robust !== null) {
      return { raw: robust, repaired: ['json.robust-extract'], error: null }
    }
  }

  // 裸数组兜底：LLM 丢掉外层信封，直接返回条目数组。
  if (raw === null && opt.jsonStructural) {
    const wrapped = extractBareArrayAsEnvelope(
      text,
      key,
      opt.bareArrayAccept ?? null,
      opt.salvageDeclined !== true,
    )
    if (wrapped.ok) {
      return { raw: wrapped.value, repaired: ['json.bare-array'], error: null }
    }
  }

  // 截断抢救（末环）。
  if (raw === null) {
    const cut = salvageCut(text, opt)
    if (cut.ok) {
      const inner = tryRepairEnvelope(cut.cut, key, enterSalvage(opt))
      if (inner.error === null) {
        return { raw: inner.raw, repaired: prependSalvageOp(repaired, inner.repaired), error: null }
      }
    }
  }

  if (raw === null) {
    if (body === '') return { raw: null, repaired, error: 'no JSON object found' }
    return { raw: null, repaired, error: `unmarshal: ${parseError ?? 'unknown error'}` }
  }
  return { raw, repaired, error: null }
}

/**
 * 从已解析 envelope 取出 key 的数组值并解码、归一（Go `decodeKeyed`）。
 */
function decodeKeyed<T>(
  raw: Record<string, unknown>,
  key: string,
  decode: (value: unknown) => T[],
  normalize: (entries: T[]) => T[],
): { entries: T[]; error: string | null } {
  if (!Object.prototype.hasOwnProperty.call(raw, key)) {
    return { entries: [], error: `response missing ${key} field` }
  }
  let typed: T[]
  try {
    typed = decode(raw[key])
  } catch (error) {
    return { entries: [], error: `unmarshal ${key}: ${errorMessage(error)}` }
  }
  return { entries: normalize(typed), error: null }
}

/**
 * 裸数组兜底命中但 normalize 后零条目（Go `bareArrayNoEntriesError`）。
 */
function bareArrayNoEntriesError<T>(
  entries: readonly T[],
  repaired: readonly string[],
  key: string,
): string | null {
  if (entries.length > 0 || !repaired.includes('json.bare-array')) return null
  return `bare array adopted as "${key}" but no entries survived normalize`
}

/** semantic QA / adjudication / ruby alignment 的共享骨架（Go `tryRepairKeyed`）。 */
function tryRepairKeyed<T>(
  text: string,
  key: string,
  opt: RepairOptions,
  decode: (value: unknown) => T[],
  normalize: (entries: T[]) => T[],
): KeyedRepairResult<T> {
  const envelope = tryRepairEnvelope(text, key, opt)
  if (envelope.error !== null) {
    return { entries: [], repaired: envelope.repaired, error: envelope.error }
  }
  const decoded = decodeKeyed(envelope.raw ?? {}, key, decode, normalize)
  if (decoded.error !== null) {
    return { entries: [], repaired: envelope.repaired, error: decoded.error }
  }
  const noEntries = bareArrayNoEntriesError(decoded.entries, envelope.repaired, key)
  if (noEntries !== null) {
    return { entries: [], repaired: envelope.repaired, error: noEntries }
  }
  return { entries: decoded.entries, repaired: envelope.repaired, error: null }
}

/**
 * 解析 `{"issues":[...]}` 并应用完整修复链（Go `TryRepairSemanticQA`）。
 *
 * 截断抢救对本入口固有危险（partial 会被解释为「缺失段=已扫描无问题」），
 * 故无条件弃用（WithoutSalvage，连同 close-braces 截断恢复）。
 */
export function tryRepairSemanticQA(
  text: string,
  opt: RepairOptions,
): KeyedRepairResult<SemanticQAIssue> {
  const options = withoutSalvage(opt)
  return tryRepairKeyed(text, 'issues', options, decodeSemanticQAIssues, normalizeSemanticQAIssues)
}

/** 按 response mode 解析语义质检响应（Go `ParseSemanticQAByMode`）。 */
export function parseSemanticQAByMode(
  text: string,
  isTextMode: boolean,
  opt: RepairOptions,
): KeyedRepairResult<SemanticQAIssue> {
  if (!isTextMode) return tryRepairSemanticQA(text, opt)
  const parsed = parseSemanticQATextIssues(text)
  if (parsed.recognized) {
    return { entries: parsed.issues, repaired: [], error: null }
  }
  return tryRepairSemanticQA(text, opt)
}

/** 解析 `{"revisions":[...]}` 并提取可选的顶层 ruby_output（Go `tryRepairReviseWithRuby`）。 */
export function tryRepairReviseWithRuby(
  text: string,
  opt: RepairOptions,
): {
  revisions: ReviseRevision[]
  rubyOutput: RubyOutputMap | null
  repaired: string[]
  error: string | null
} {
  const envelope = tryRepairEnvelope(text, 'revisions', opt)
  if (envelope.error !== null) {
    return { revisions: [], rubyOutput: null, repaired: envelope.repaired, error: envelope.error }
  }
  const raw = envelope.raw ?? {}
  const decoded = decodeKeyed(raw, 'revisions', decodeReviseRevisions, normalizeReviseRevisions)
  if (decoded.error !== null) {
    return { revisions: [], rubyOutput: null, repaired: envelope.repaired, error: decoded.error }
  }
  const noEntries = bareArrayNoEntriesError(decoded.entries, envelope.repaired, 'revisions')
  if (noEntries !== null) {
    return { revisions: [], rubyOutput: null, repaired: envelope.repaired, error: noEntries }
  }
  let rubyOutput: RubyOutputMap | null = null
  if (Object.prototype.hasOwnProperty.call(raw, 'ruby_output')) {
    rubyOutput = parseOutputMap(marshalGo(raw['ruby_output']))
  }
  return { revisions: decoded.entries, rubyOutput, repaired: envelope.repaired, error: null }
}

/** 解析 text 协议修订输出（Go `parseReviseTextWithRuby`）。 */
export function parseReviseTextWithRuby(text: string): {
  revisions: ReviseRevision[]
  rubyOutput: RubyOutputMap | null
  recognized: boolean
} {
  const parsed = parseReviseTextRevisions(text)
  if (!parsed.recognized) {
    return { revisions: [], rubyOutput: null, recognized: false }
  }
  let rubyOutput: RubyOutputMap | null = null
  const rubyLines = collectSectionLines(text, 'ruby')
  if (rubyLines.length > 0) {
    rubyOutput = parseSectionRubyOutput(rubyLines)
  }
  return { revisions: parsed.revisions, rubyOutput, recognized: true }
}

/** 按 response mode 解析修订响应（Go `ParseReviseByMode`）。 */
export function parseReviseByMode(
  text: string,
  isTextMode: boolean,
  opt: RepairOptions,
): {
  revisions: ReviseRevision[]
  rubyOutput: RubyOutputMap | null
  repaired: string[]
  error: string | null
} {
  if (!isTextMode) return tryRepairReviseWithRuby(text, opt)
  const parsed = parseReviseTextWithRuby(text)
  if (parsed.recognized) {
    return { revisions: parsed.revisions, rubyOutput: parsed.rubyOutput, repaired: [], error: null }
  }
  return tryRepairReviseWithRuby(text, opt)
}

/**
 * 解析 `{"verdicts":[...]}` 并应用完整修复链（Go `TryRepairAdjudication`）。
 *
 * 与 semantic QA 同口径无条件弃用截断抢救。
 */
export function tryRepairAdjudication(
  text: string,
  opt: RepairOptions,
): KeyedRepairResult<AdjudicationVerdict> {
  const options = withoutSalvage({ ...opt, bareArrayAccept: validBareVerdictEntries })
  return tryRepairKeyed(
    text,
    'verdicts',
    options,
    decodeAdjudicationVerdicts,
    normalizeAdjudicationVerdicts,
  )
}

/** 按 response mode 解析裁决响应（Go `ParseAdjudicationByMode`）。 */
export function parseAdjudicationByMode(
  text: string,
  isTextMode: boolean,
  opt: RepairOptions,
): KeyedRepairResult<AdjudicationVerdict> {
  if (!isTextMode) return tryRepairAdjudication(text, opt)
  const parsed = parseAdjudicationTextVerdicts(text)
  if (parsed.recognized) {
    return { entries: parsed.verdicts, repaired: [], error: null }
  }
  return tryRepairAdjudication(text, opt)
}

/**
 * 解析 `{"ruby_output":[...]}` 并应用完整修复链（Go `TryRepairRubyAlignment`）。
 * 失败时 entries 为空数组（Go nil slice 归一）。
 */
export function tryRepairRubyAlignment(
  text: string,
  opt: RepairOptions,
): KeyedRepairResult<RubyOutputEntry> {
  const options: RepairOptions = { ...opt, bareArrayAccept: validBareOutputEntries }
  return tryRepairKeyed(
    text,
    'ruby_output',
    options,
    decodeOutputEntriesPlain,
    normalizeOutputEntries,
  )
}
