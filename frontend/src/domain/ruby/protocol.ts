/**
 * 注音协议的文本 / JSON 解析（对应 Go `backend/internal/ruby/alignment_protocol.go`
 * 与 `alignment_legacy.go`）。
 *
 * 设计要点：
 * - 逐行解析，坏行不会丢弃其它行；
 * - 失败行保留可识别的 ID（`invalid=true`），让重复 ID 的检查完整；
 * - v2 文本协议用 5 字段、v1 文本协议保留 3 字段不关联语义。
 *
 * 边界说明：Go 的 `utf8.ValidString` 校验无法在 JS 字符串上复现（JS 字符串是
 * UTF-16，非法 UTF-8 字节序列在进入 JS 前已被替换）；本移植用
 * {@link hasLoneSurrogate} 覆盖「孤立代理项」这一可表达形态。
 */
import { newOutputEntry, isValidKind, type OutputEntry } from './item'
import { hasLoneSurrogate, trimSpace } from './text'

/** 从右侧解析单行 `base | text | kind [| id]` 的结果。 */
export interface SectionLine {
  base: string
  text: string
  kind: string
  /** 条目 id（3 字段行时为空串）。 */
  itemId: string
  ok: boolean
}

/**
 * 按未转义竖线切分字段，最多切出 `limit` 段（Go `splitQuotedTextFieldsLimit`）。
 *
 * JSON 字符串内的 `|` 是普通文本；多出的字段已足以证明该行非法，故在此封顶，
 * 避免恶意超长响应把内存打爆。
 */
export function splitQuotedTextFieldsLimit(text: string, limit: number): string[] {
  const fields: string[] = []
  let start = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (c === '\\') {
        escaped = true
      } else if (c === '"') {
        inString = false
      }
      continue
    }
    if (c === '"') {
      inString = true
    } else if (c === '|') {
      fields.push(text.slice(start, i))
      start = i + 1
      if (fields.length === limit) break
    }
  }
  fields.push(text.slice(start))
  return fields
}

/** 切分 5 字段文本行（Go `splitQuotedTextFields`）。 */
export function splitQuotedTextFields(text: string): string[] {
  return splitQuotedTextFieldsLimit(text, 5)
}

/** 判断字符串是否为一个合法的 JSON 字符串字面量，并返回解码结果。 */
function decodeJSONStringLiteral(literal: string): string | null {
  try {
    const v = JSON.parse(literal) as unknown
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

/**
 * 解码一行带引号的文本条目（Go `parseQuotedTextEntry`）。
 *
 * `requireOccurrence=true` 时需要 5 字段（第 5 字段为 1 基 occurrence）。
 */
export function parseQuotedTextEntry(text: string, requireOccurrence: boolean): OutputEntry {
  const fields = splitQuotedTextFields(text)
  const want = requireOccurrence ? 5 : 4
  const entry = newOutputEntry({ invalid: fields.length !== want || hasLoneSurrogate(text) })
  const targets: Array<'base' | 'text' | 'kind' | 'id'> = ['base', 'text', 'kind', 'id']
  for (let i = 0; i < targets.length; i++) {
    if (i >= fields.length) break
    const literal = (fields[i] as string).trim()
    const decoded = literal.startsWith('"') ? decodeJSONStringLiteral(literal) : null
    if (decoded === null) {
      entry.invalid = true
    } else {
      entry[targets[i] as 'base' | 'text' | 'kind' | 'id'] = decoded
    }
  }
  if (requireOccurrence && fields.length >= 5) {
    const number = (fields[4] as string).trim()
    if (!/^[0-9]+$/.test(number)) {
      // 与 Go `strconv.Atoi` 一致：非纯数字时 Occurrence 保持零值。
      entry.invalid = true
    } else {
      const parsed = Number.parseInt(number, 10)
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        entry.invalid = true
      } else {
        entry.occurrence = parsed
      }
    }
  }
  entry.invalid =
    entry.invalid ||
    entry.id === '' ||
    entry.base === '' ||
    entry.text === '' ||
    !isValidKind(entry.kind)
  return entry
}

/** 主响应文本形态（4 字段，Go `parsePrimaryTextEntry`）。 */
export function parsePrimaryTextEntry(text: string): OutputEntry {
  return parseQuotedTextEntry(text, false)
}

/** 解析 v2 文本协议：每行 5 字段（Go `ParseAlignmentTextV2`）。 */
export function parseAlignmentTextV2(text: string): OutputEntry[] {
  const entries: OutputEntry[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    entries.push(parseQuotedTextEntry(line, true))
  }
  return entries
}

/**
 * 去除 item id 的 prompt 展示前缀（`#`）并 trim（Go `trimIDPrefix`）。
 *
 * item ID 由 `AssignIDs` 分配为裸数字，prompt 以 `基底/标注#id` 展示，LLM 常
 * 原样回显 `#1`；解析阶段统一回裸数字，保证 `mergeByOutput` 命中。
 */
export function trimIdPrefix(id: string): string {
  let out = id.trim()
  if (out.startsWith('#')) out = out.slice(1)
  return out.trim()
}

/** 从右解析恰好 3 个字段 `base | text | kind`（Go `parseBaseTextKind`）。 */
function parseBaseTextKind(content: string): SectionLine {
  const kindIdx = content.lastIndexOf('|')
  if (kindIdx < 0) {
    return { base: '', text: '', kind: '', itemId: '', ok: false }
  }
  const kind = content.slice(kindIdx + 1).trim()
  const rest = content.slice(0, kindIdx)
  const textIdx = rest.lastIndexOf('|')
  if (textIdx < 0) {
    return { base: '', text: '', kind: '', itemId: '', ok: false }
  }
  const base = rest.slice(0, textIdx).trim()
  const text = rest.slice(textIdx + 1).trim()
  if (base === '' || text === '') {
    return { base: '', text: '', kind: '', itemId: '', ok: false }
  }
  return { base, text, kind, itemId: '', ok: true }
}

/**
 * 从右解析单行 ruby 标注 `base | text | kind [| id]`（Go `ParseSectionLine`）。
 *
 * 3 字段（最右侧为合法 kind）或 4 字段（最右侧为 id，其左为 kind）。返回
 * base/text/kind/id；text 为空、字段不足或无法判定时 ok=false。
 */
export function parseSectionLine(content: string): SectionLine {
  const itemIdx = content.lastIndexOf('|')
  if (itemIdx < 0) {
    return { base: '', text: '', kind: '', itemId: '', ok: false }
  }
  const rightmost = content.slice(itemIdx + 1).trim()
  if (rightmost === '') {
    return { base: '', text: '', kind: '', itemId: '', ok: false }
  }
  // 最右侧是合法 kind → 3 字段行（无 item_id）
  if (isValidKind(rightmost)) {
    return parseBaseTextKind(content)
  }
  // 否则优先按 4 字段解析：最右侧为 item_id，其余按 3 字段解析。
  const four = parseBaseTextKind(content.slice(0, itemIdx))
  if (four.ok) {
    return { ...four, itemId: trimIdPrefix(rightmost) }
  }
  // 4 字段解析失败 → 回退 3 字段整体解析（兼容自定义 kind）
  return parseBaseTextKind(content)
}

/**
 * 解析 v1 文本协议（Go `ParseAlignmentTextLegacy`）。
 *
 * 保留显式 legacy ID（含畸形重复行）；3 字段行不建立关联（ID 为空且
 * `invalid=true` 由字段校验决定）。
 */
export function parseAlignmentTextLegacy(text: string): OutputEntry[] {
  const entries: OutputEntry[] = []
  for (const rawLine of text.split('\n')) {
    const line0 = rawLine.trim()
    if (line0 === '') continue
    const entry = newOutputEntry({ invalid: true })
    let line = line0
    let last = line.lastIndexOf('|')
    if (last < 0) {
      entries.push(entry)
      continue
    }
    const lastField = line.slice(last + 1).trim()
    if (isValidKind(lastField)) {
      const parsed = parseSectionLine(line)
      entry.base = parsed.base
      entry.text = parsed.text
      entry.kind = parsed.kind
      entries.push(entry)
      continue
    }
    entry.id = trimIdPrefix(lastField)
    line = line.slice(0, last)
    last = line.lastIndexOf('|')
    if (last >= 0) {
      entry.kind = line.slice(last + 1).trim()
      line = line.slice(0, last)
      last = line.lastIndexOf('|')
      if (last >= 0) {
        entry.text = line.slice(last + 1).trim()
        entry.base = line.slice(0, last).trim()
        entry.invalid =
          entry.id === '' || entry.base === '' || entry.text === '' || !isValidKind(entry.kind)
      }
    }
    entries.push(entry)
  }
  return entries
}

/** JSON 解码结果（`ok=false` 等价 Go 的 error）。 */
export interface JSONParseResult {
  entries: OutputEntry[]
  ok: boolean
}

/**
 * 读取顶层 JSON 对象的成员名序列（含重复项）。
 *
 * `JSON.parse` 会静默保留重复键的最后一次出现，无法发现 `{"a":1,"a":2}`；
 * 而 Go 的流式解码器会显式拒绝重复的 envelope 字段。此处用轻量扫描补足该判定。
 * 解析失败返回 `null`。
 */
function topLevelObjectKeys(text: string): string[] | null {
  let i = 0
  const skipWs = (): void => {
    while (i < text.length && /[ \t\r\n]/.test(text[i] as string)) i++
  }
  const skipString = (): boolean => {
    if (text[i] !== '"') return false
    i++
    while (i < text.length) {
      const c = text[i] as string
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === '"') {
        i++
        return true
      }
      i++
    }
    return false
  }
  const skipValue = (): boolean => {
    skipWs()
    const c = text[i]
    if (c === '"') return skipString()
    if (c === '{' || c === '[') {
      let depth = 0
      while (i < text.length) {
        const ch = text[i] as string
        if (ch === '"') {
          if (!skipString()) return false
          continue
        }
        if (ch === '{' || ch === '[') depth++
        else if (ch === '}' || ch === ']') {
          depth--
          i++
          if (depth === 0) return true
          continue
        }
        i++
      }
      return false
    }
    while (i < text.length && !/[,\]}]/.test(text[i] as string)) i++
    return true
  }
  skipWs()
  if (text[i] !== '{') return null
  i++
  const keys: string[] = []
  for (;;) {
    skipWs()
    if (text[i] === '}') return keys
    if (text[i] !== '"') return null
    const keyStart = i
    if (!skipString()) return null
    keys.push(JSON.parse(text.slice(keyStart, i)) as string)
    skipWs()
    if (text[i] !== ':') return null
    i++
    if (!skipValue()) return null
    skipWs()
    if (text[i] === ',') {
      i++
      continue
    }
    if (text[i] === '}') return keys
    return null
  }
}

/** 判断 JSON 值是否为普通对象（非 null / 非数组）。 */
function isJSONObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 严格解码单条 v2 JSON 行（Go `decodeOutputEntry`）。
 *
 * 与 Go 一致：未知字段、类型错误、`occurrence` 非正整数、空 id/base/text、
 * 非法 kind 一律标 `invalid`，但保留可识别的 id 供重复检查。
 */
function decodeJSONOutputEntry(
  raw: unknown,
  requireOccurrence: boolean,
  strict: boolean,
): OutputEntry {
  const entry = newOutputEntry()
  if (!isJSONObject(raw)) {
    entry.invalid = true
    return entry
  }
  for (const [name, value] of Object.entries(raw)) {
    switch (name) {
      case 'id':
        if (typeof value !== 'string') entry.invalid = true
        else entry.id = value
        break
      case 'base':
        if (typeof value !== 'string') entry.invalid = true
        else entry.base = value
        break
      case 'text':
        if (typeof value !== 'string') entry.invalid = true
        else entry.text = value
        break
      case 'kind':
        if (typeof value !== 'string') entry.invalid = true
        else entry.kind = value
        break
      case 'occurrence': {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
          entry.invalid = true
        } else {
          entry.occurrence = value
        }
        break
      }
      default:
        if (strict) entry.invalid = true
        break
    }
  }
  if (
    strict &&
    (entry.id === '' || entry.base === '' || entry.text === '' || !isValidKind(entry.kind))
  ) {
    entry.invalid = true
  }
  if (requireOccurrence && entry.occurrence < 1) {
    entry.invalid = true
  }
  return entry
}

/**
 * 解析 `ruby_output` 数组（Go `parseOutputArray`）。
 *
 * Go 侧入口接收 `json.RawMessage`（原始字节）；因此这里同样接受**原始 JSON
 * 文本**（`json.Unmarshal` 语义：`null`、畸形、非数组一律失败）与已解析值。
 */
function parseOutputArray(
  raw: unknown,
  requireOccurrence: boolean,
  strict: boolean,
): JSONParseResult {
  if (typeof raw === 'string') {
    if (trimSpace(raw) === 'null') return { entries: [], ok: false }
    try {
      raw = JSON.parse(raw)
    } catch {
      return { entries: [], ok: false }
    }
  }
  if (raw === null) return { entries: [], ok: false }
  if (!Array.isArray(raw)) return { entries: [], ok: false }
  const entries = raw.map((item) => decodeJSONOutputEntry(item, requireOccurrence, strict))
  return { entries, ok: true }
}

/**
 * 解析 v2 JSON 协议（Go `ParseAlignmentJSONV2`）。
 *
 * 只接受**仅含** `ruby_output` 一个字段的对象；重复/额外字段、尾随数据、
 * 非数组值一律失败。行级错误不丢行（`entries[i].invalid`）。
 */
export function parseAlignmentJsonV2(text: string): JSONParseResult {
  if (hasLoneSurrogate(text)) return { entries: [], ok: false }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { entries: [], ok: false }
  }
  if (!isJSONObject(value)) return { entries: [], ok: false }
  const keys = topLevelObjectKeys(text)
  if (keys === null || keys.length !== 1 || keys[0] !== 'ruby_output') {
    return { entries: [], ok: false }
  }
  return parseOutputArray(value['ruby_output'], true, true)
}

/** 解析可选的 main-response / legacy 映射（Go `ParseOutputEntries`）。 */
export function parseOutputEntries(raw: unknown): JSONParseResult {
  return parseOutputArray(raw, false, false)
}

/**
 * 解析 segment ID → 条目数组的映射（Go `ParseOutputMap`）。
 *
 * 接受原始 JSON 文本（`json.RawMessage` 语义）或已解析对象。坏段被隔离
 * （跳过），不影响其它段；顶层非对象返回 `null`（Go nil map）。
 * 与 Go 的流式解码一致：重复 segment id → 整段删除（`JSON.parse` 只保留
 * 最后一个，故原始文本路径用成员名序列重建该语义）。
 */
export function parseOutputMap(raw: unknown): Record<string, OutputEntry[]> | null {
  let keys: string[] | null = null
  if (typeof raw === 'string') {
    keys = topLevelObjectKeys(raw)
    if (keys === null) return null
    try {
      raw = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!isJSONObject(raw)) return null
  const out: Record<string, OutputEntry[]> = {}
  const seen = new Set<string>()
  const order = keys ?? Object.keys(raw)
  for (const id of order) {
    if (seen.has(id)) {
      delete out[id]
      continue
    }
    seen.add(id)
    const parsed = parseOutputEntries((raw as Record<string, unknown>)[id])
    if (parsed.ok) out[id] = parsed.entries
  }
  return out
}
