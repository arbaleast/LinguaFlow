/**
 * 修复链主入口（对应 Go `backend/internal/repair/repair.go`）。
 *
 * 修复链（每步独立可关）：
 *
 * 1. 去 BOM/零宽（JSONStructural）
 * 2. 抽取含 `translations` 的对象（SchemaAliases 时退而求其次找 alias 字段）
 * 3. 解析失败 → trailing-comma / escape-control / escape-quotes / close-braces / merge-objects
 * 4. SchemaAliases 时把 translation/result/output/data.translations 归一为 translations
 * 5. 校验 wantIDs：缺失记入 missing；多余 ID **不**视为错误
 */
import { marshalGo } from './json_parse'
import {
  closeUnbalancedBraces,
  escapeControlChars,
  escapeUnescapedQuotes,
  extractJSONObjectContaining,
  extractValidEnvelope,
  fixTrailingCommas,
  jsonObjectSlice,
  mergeTranslationObjects,
  stripBOMAndZeroWidth,
  truncateToLastCompleteValue,
} from './json'
import { normalizeEnvelopeKeys } from './schema'
import {
  enterSalvage,
  type BootstrapRepairResult,
  type BootstrapEntry,
  type RepairOptions,
  type RepairResult,
  type RubyOutputMap,
} from './types'
import { decodeBootstrapEntries, dedupeBootstrapEntries } from './deps/prompt_protocol'
import { parseOutputEntries, parseOutputMap } from './deps/ruby_protocol'
import { isPlainObject } from './json_parse'
import { TranslationShapeError, firstStringKey, toStringMap, unmarshalGeneric } from './values'

/** 把错误归一为消息字符串。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 构造 fatal 结果。 */
function fatalResult(repaired: string[], message: string): RepairResult {
  return {
    trans: {},
    glos: [],
    rubyOutput: null,
    missing: [],
    repaired,
    fatal: true,
    parseErr: message,
  }
}

/**
 * 把已解析的 raw envelope 转成最终 Result（Go `finalizeResult`）。
 *
 * 含 SchemaAliases、translations 抽取、glossary 抽取、ruby 抽取与 wantIDs 完整性比对。
 */
export function finalizeResult(
  raw: Record<string, unknown>,
  wantIDs: readonly string[],
  repaired: readonly string[],
  opt: RepairOptions,
): RepairResult {
  let current = raw
  let repairs = [...repaired]

  if (opt.schemaAliases) {
    const normalized = normalizeEnvelopeKeys(current)
    if (normalized.did) {
      current = normalized.raw
      repairs = [...repairs, 'schema.alias']
    }
  }

  const transRaw = current['translations']
  if (!Object.prototype.hasOwnProperty.call(current, 'translations')) {
    return fatalResult(repairs, 'response missing translations field')
  }
  let trans: Record<string, string>
  try {
    trans = toStringMap(transRaw)
  } catch (error) {
    if (error instanceof TranslationShapeError) {
      return fatalResult(repairs, `translations field shape: ${error.message}`)
    }
    return fatalResult(repairs, `translations field shape: ${errorMessage(error)}`)
  }

  let glos: BootstrapEntry[] = []
  if (Object.prototype.hasOwnProperty.call(current, 'glossary')) {
    try {
      glos = decodeBootstrapEntries(current['glossary'])
    } catch {
      // Go 忽略该错误（`_ = json.Unmarshal`），保留零值。
      glos = []
    }
  }

  let rubyOutput: RubyOutputMap | null = null
  if (Object.prototype.hasOwnProperty.call(current, 'ruby_output')) {
    rubyOutput = parseOutputMap(marshalGo(current['ruby_output']))
  }
  if (rubyOutput === null) {
    const nested = extractNestedRubyOutput(transRaw)
    if (nested.did) {
      rubyOutput = nested.value
      repairs = [...repairs, 'schema.ruby-nested-extract']
    }
  }

  const missing: string[] = []
  for (const id of wantIDs) {
    if (!Object.prototype.hasOwnProperty.call(trans, id)) missing.push(id)
  }

  return {
    trans,
    glos,
    rubyOutput,
    missing,
    repaired: repairs,
    fatal: false,
    parseErr: null,
  }
}

/** envelope 候选字段：始终含 translations，SchemaAliases 时追加同义字段。 */
function envelopeKeys(opt: RepairOptions): string[] {
  const keys = ['translations']
  if (opt.schemaAliases) keys.push('translation', 'result', 'output', 'results')
  return keys
}

/** 从 text 中挑出最可能含 translations 的 JSON 对象（Go `pickEnvelopeBody`）。 */
export function pickEnvelopeBody(text: string, opt: RepairOptions): string {
  for (const key of envelopeKeys(opt)) {
    const body = extractJSONObjectContaining(text, key)
    if (body !== '') return body
  }
  return jsonObjectSlice(text)
}

/**
 * body 抽取失败时的共享兜底：补齐括号后按 `extract` 重新抽取（Go
 * `closeBracesFallback`）。
 */
export function closeBracesFallback(
  text: string,
  repaired: readonly string[],
  extract: (fixed: string) => string,
): { body: string; repaired: string[] } {
  const fixed = closeUnbalancedBraces(text)
  if (fixed === text) return { body: '', repaired: [...repaired] }
  const body = extract(fixed)
  if (body !== '') return { body, repaired: [...repaired, 'json.close-braces'] }
  return { body: '', repaired: [...repaired] }
}

/**
 * 截断抢救的共享守卫（Go `salvageCut`）：集中判定 JSONStructural 开启、
 * 抢救未弃用、不在抢救递归层内，再回退到最后一个完整值闭合点。
 */
export function salvageCut(text: string, opt: RepairOptions): { cut: string; ok: boolean } {
  if (!opt.jsonStructural || opt.salvageDeclined === true || opt.inSalvage === true) {
    return { cut: '', ok: false }
  }
  return truncateToLastCompleteValue(text)
}

/** 把 json.truncation-salvage 前插进外层算子链（Go `prependSalvageOp`）。 */
export function prependSalvageOp(outer: readonly string[], inner: readonly string[]): string[] {
  return [...outer, 'json.truncation-salvage', ...inner]
}

/**
 * 尝试解析 LLM 响应 text 为 envelope
 * `{"translations":{...}, "glossary":[...]}`（Go `TryRepair`）。
 *
 * 永不抛错——失败语义通过 `fatal` + `parseErr` 表达。
 */
export function tryRepair(
  text: string,
  wantIDs: readonly string[],
  opt: RepairOptions,
): RepairResult {
  let repaired: string[] = []

  if (opt.jsonStructural) {
    const cleaned = stripBOMAndZeroWidth(text)
    if (cleaned.did) repaired = [...repaired, 'json.strip-bom-zw']
    text = cleaned.text
  }

  // 若文本中存在 ≥2 个 translations 对象，先尝试 merge——否则
  // extractJSONObjectContaining 只会拿到第一个，丢掉其他对象里的 ID。
  if (opt.jsonStructural) {
    const merged = mergeTranslationObjects(text)
    if (merged !== '') {
      try {
        const r2 = unmarshalGeneric(merged)
        return finalizeResult(r2, wantIDs, [...repaired, 'json.merge-objects'], opt)
      } catch {
        // 合并结果仍不可解析：继续主链路。
      }
    }
  }

  let body = pickEnvelopeBody(text, opt)
  if (body === '' && opt.jsonStructural) {
    // 兜底：text 可能整体未闭合，尝试补齐括号再抽。
    const fallback = closeBracesFallback(text, repaired, (fixed) => pickEnvelopeBody(fixed, opt))
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

  // 鲁棒兜底：结巴/重复前缀或引号/括号相位错乱噪声。
  if (raw === null && opt.jsonStructural) {
    const robust = extractValidEnvelope(text)
    if (robust.ok) {
      return finalizeResult(robust.value, wantIDs, [...repaired, 'json.robust-extract'], opt)
    }
  }

  // 截断抢救（末环）。
  if (raw === null) {
    const cut = salvageCut(text, opt)
    if (cut.ok) {
      const inner = tryRepair(cut.cut, wantIDs, enterSalvage(opt))
      if (!inner.fatal) {
        inner.repaired = prependSalvageOp(repaired, inner.repaired)
        return inner
      }
    }
  }

  if (raw === null) {
    if (body === '') return fatalResult(repaired, 'no JSON object found')
    return fatalResult(repaired, `unmarshal: ${parseError ?? 'unknown error'}`)
  }

  return finalizeResult(raw, wantIDs, repaired, opt)
}

/**
 * 解析 bootstrap 响应 `{"glossary":[...]}`（Go `TryRepairBootstrap`）。
 *
 * 复用 L1 修复链与 L2 字段同义化（terms/entries → glossary）；语义与
 * `prompt.ParseBootstrapResponse` 一致：过滤空 source/target、按 source 去重保留首次。
 */
export function tryRepairBootstrap(text: string, opt: RepairOptions): BootstrapRepairResult {
  let repaired: string[] = []
  if (opt.jsonStructural) {
    const cleaned = stripBOMAndZeroWidth(text)
    if (cleaned.did) repaired = [...repaired, 'json.strip-bom-zw']
    text = cleaned.text
  }

  let body = ''
  const keys = ['glossary']
  if (opt.schemaAliases) keys.push('terms', 'entries')
  for (const key of keys) {
    body = extractJSONObjectContaining(text, key)
    if (body !== '') break
  }
  if (body === '') body = jsonObjectSlice(text)
  if (body === '' && opt.jsonStructural && opt.salvageDeclined !== true) {
    // 兜底：text 可能整体未闭合（截断），尝试补齐括号再抽。
    const fallback = closeBracesFallback(text, repaired, (fixed) => {
      for (const key of keys) {
        const candidate = extractJSONObjectContaining(fixed, key)
        if (candidate !== '') return candidate
      }
      return jsonObjectSlice(fixed)
    })
    body = fallback.body
    repaired = fallback.repaired
  }
  if (body === '') {
    // 截断抢救（末环）。
    const salvaged = salvageBootstrapPrefix(text, repaired, opt)
    if (salvaged.ok) return { entries: salvaged.entries, repaired: salvaged.repaired, error: null }
    return { entries: [], repaired, error: 'no JSON object found in bootstrap response' }
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
  if (raw === null) {
    // 命中第二处抢救末环（body 已抽出但连同修复链仍无法解析）。
    const salvaged = salvageBootstrapPrefix(text, repaired, opt)
    if (salvaged.ok) return { entries: salvaged.entries, repaired: salvaged.repaired, error: null }
    return { entries: [], repaired, error: `unmarshal: ${parseError ?? 'unknown error'}` }
  }

  if (opt.schemaAliases && !Object.prototype.hasOwnProperty.call(raw, 'glossary')) {
    for (const alias of ['terms', 'entries']) {
      if (Object.prototype.hasOwnProperty.call(raw, alias)) {
        raw['glossary'] = raw[alias]
        delete raw[alias]
        repaired = [...repaired, 'schema.alias']
        break
      }
    }
  }

  if (!Object.prototype.hasOwnProperty.call(raw, 'glossary')) {
    return { entries: [], repaired, error: 'response missing glossary field' }
  }
  let entries: BootstrapEntry[]
  try {
    entries = decodeBootstrapEntries(raw['glossary'])
  } catch (error) {
    return { entries: [], repaired, error: `unmarshal glossary: ${errorMessage(error)}` }
  }
  return { entries: dedupeBootstrapEntries(entries), repaired, error: null }
}

/**
 * bootstrap 两处截断抢救末环的共享实现（Go `salvageBootstrapPrefix`）。
 */
function salvageBootstrapPrefix(
  text: string,
  repaired: readonly string[],
  opt: RepairOptions,
): { ok: boolean; entries: BootstrapEntry[]; repaired: string[] } {
  const cut = salvageCut(text, opt)
  if (cut.ok) {
    const inner = tryRepairBootstrap(cut.cut, enterSalvage(opt))
    if (inner.error === null) {
      return {
        ok: true,
        entries: inner.entries,
        repaired: prependSalvageOp(repaired, inner.repaired),
      }
    }
  }
  return { ok: false, entries: [], repaired: [] }
}

/**
 * 处理 LLM 将 ruby_output 嵌套在 translations 条目中的情况：
 *
 * `{"translations":{"1":{"translation":"...","ruby_output":[...]}}}`
 *
 * 提取为顶层 ruby_output map；无需修复时返回 `{did:false}`。
 */
export function extractNestedRubyOutput(transRaw: unknown): {
  did: boolean
  value: RubyOutputMap | null
} {
  if (!isPlainObject(transRaw)) return { did: false, value: null }
  const extracted: RubyOutputMap = {}
  for (const [id, value] of Object.entries(transRaw)) {
    if (!isPlainObject(value)) continue
    if (!Object.prototype.hasOwnProperty.call(value, 'ruby_output')) continue
    const rubyRaw = value['ruby_output']
    if (!Array.isArray(rubyRaw)) continue
    try {
      const entries = parseOutputEntries(marshalGo(rubyRaw))
      if (entries.length > 0) extracted[id] = entries
    } catch {
      continue
    }
  }
  if (Object.keys(extracted).length === 0) return { did: false, value: null }
  return { did: true, value: extracted }
}

/** 重新导出 `firstStringKey`，保持与 Go `repair.go` 的模块对应关系。 */
export { firstStringKey }
