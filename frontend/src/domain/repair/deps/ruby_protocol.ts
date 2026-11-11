/**
 * 注音协议解析（`backend/internal/ruby` 中 `repair` 依赖的**最小子集** 1:1 移植）。
 *
 * 为什么放在 `domain/repair/deps/` 而不是 `domain/ruby/`：
 * 本任务是 repair 包移植，硬性边界禁止修改 `domain/ruby/**`；这些函数是
 * `repair` 的输入协议解码器（`ParseOutputEntries` / `ParseOutputMap` /
 * `ParseSectionRubyOutput` 等），按 Go 的包依赖方向内聚在 repair 侧。
 * 后续 `domain/ruby` 若移植同名函数，应改为从这里导出、单点维护。
 *
 * 行级畸形隔离是本模块的核心契约：单行字段解码失败只标记该行 `invalid`，
 * 绝不丢行——否则重复 ID 校验会因「另一行坏了」而被绕过。
 */
import { compile } from '../../shared/re2'
import { JsonParseError, isPlainObject, parseJsonWhole, type JsonNode } from '../json_parse'
import { trimSpaceGo } from '../strings'
import type { RubyOutputEntry, RubyOutputMap } from '../types'

/** 合法 kind 值（Go `ruby.ValidKinds`）。 */
export const VALID_KINDS: readonly string[] = ['phonetic', 'semantic', 'creative']

/** 判断 kind 是否为合法值（Go `isValidKind`）。 */
export function isValidKind(kind: string): boolean {
  return VALID_KINDS.includes(kind)
}

/** 构造零值条目。 */
function newOutputEntry(init: Partial<RubyOutputEntry> = {}): RubyOutputEntry {
  return {
    id: init.id ?? '',
    base: init.base ?? '',
    text: init.text ?? '',
    kind: init.kind ?? '',
    occurrence: init.occurrence ?? 0,
    invalid: init.invalid ?? false,
  }
}

/** 把 JSON 值解码为字符串；`null` 不改变零值且不报错（Go unmarshal 语义）。 */
function decodeStringField(node: JsonNode): { ok: boolean; value: string } {
  if (node.kind === 'null') return { ok: true, value: '' }
  if (node.kind !== 'string') return { ok: false, value: '' }
  return { ok: true, value: node.stringValue ?? '' }
}

/** 把 JSON 值解码为 int；`null` 不报错但由调用方判 invalid。 */
function decodeIntField(node: JsonNode): { ok: boolean; value: number } {
  if (node.kind === 'null') return { ok: true, value: 0 }
  if (node.kind !== 'number') return { ok: false, value: 0 }
  const n = node.numberValue ?? 0
  if (!Number.isInteger(n) || n < -2147483648 || n > 2147483647) return { ok: false, value: 0 }
  return { ok: true, value: n }
}

/**
 * 解码单行（Go `decodeOutputEntry`，`requireOccurrence=false` / `strict=false`）。
 *
 * 重复成员、未知字段类型、非对象行都只置 `invalid`，保留可识别的 ID。
 */
function decodeOutputEntry(node: JsonNode): RubyOutputEntry {
  const entry = newOutputEntry()
  if (node.kind !== 'object') {
    entry.invalid = true
    return entry
  }
  const fields = new Map<string, JsonNode>()
  for (const member of node.members ?? []) {
    if (fields.has(member.key)) entry.invalid = true
    fields.set(member.key, member.value)
  }
  for (const [name, value] of fields) {
    switch (name) {
      case 'id': {
        const r = decodeStringField(value)
        if (!r.ok) entry.invalid = true
        else entry.id = r.value
        break
      }
      case 'base': {
        const r = decodeStringField(value)
        if (!r.ok) entry.invalid = true
        else entry.base = r.value
        break
      }
      case 'text': {
        const r = decodeStringField(value)
        if (!r.ok) entry.invalid = true
        else entry.text = r.value
        break
      }
      case 'kind': {
        const r = decodeStringField(value)
        if (!r.ok) entry.invalid = true
        else entry.kind = r.value
        break
      }
      case 'occurrence': {
        const r = decodeIntField(value)
        if (!r.ok) entry.invalid = true
        else entry.occurrence = r.value
        if (value.kind === 'null' || entry.occurrence < 1) entry.invalid = true
        break
      }
      default:
        // strict=false：未知字段忽略。
        break
    }
  }
  return entry
}

/** 解码数组节点为条目列表（Go `parseOutputArray`，`requireOccurrence=false`）。 */
function decodeOutputArrayNode(node: JsonNode): RubyOutputEntry[] {
  if (node.kind === 'null') throw new Error('ruby_output must be an array')
  if (node.kind !== 'array')
    throw new Error('json: cannot unmarshal non-array into []ruby.OutputEntry')
  return (node.items ?? []).map(decodeOutputEntry)
}

/**
 * 解析注音条目数组原始 JSON（Go `ruby.ParseOutputEntries`）。
 *
 * 非数组 / null 抛错；行级畸形通过 `invalid` 保留。
 */
export function parseOutputEntries(raw: string): RubyOutputEntry[] {
  const node = parseJsonWhole(raw)
  return decodeOutputArrayNode(node)
}

/**
 * 解析 segment ID → 条目数组的原始 JSON（Go `ruby.ParseOutputMap`）。
 *
 * 任一层结构错误返回 `null`（Go 的 nil map）；重复 segment key 会删除该键
 * （Go 的 `delete(out,id)` 语义：歧义映射不建立任何事实）。
 */
export function parseOutputMap(raw: string): RubyOutputMap | null {
  let root: JsonNode
  try {
    root = parseJsonWhole(raw)
  } catch (error) {
    if (error instanceof JsonParseError) return null
    return null
  }
  if (root.kind !== 'object') return null
  const out: RubyOutputMap = {}
  const seen = new Set<string>()
  for (const member of root.members ?? []) {
    const id = member.key
    if (seen.has(id)) {
      delete out[id]
      continue
    }
    seen.add(id)
    try {
      out[id] = decodeOutputArrayNode(member.value)
    } catch {
      // 该段失败不影响其他段。
    }
  }
  return out
}

/** trim Base/Text/Kind 并丢弃 Base 为空的条目（Go `ruby.NormalizeOutputEntries`）。 */
export function normalizeOutputEntries(entries: readonly RubyOutputEntry[]): RubyOutputEntry[] {
  const out: RubyOutputEntry[] = []
  for (const item of entries) {
    const entry = newOutputEntry({
      ...item,
      base: trimSpaceGo(item.base),
      text: trimSpaceGo(item.text),
      kind: trimSpaceGo(item.kind),
    })
    if (entry.base === '') continue
    out.push(entry)
  }
  return out
}

/**
 * 裸数组兜底的领域判别器（Go `ruby.ValidBareOutputEntries`）。
 *
 * 真实条目必带非空 text 或合法 kind；只有 base 类字段的对象（prompt 条目清单
 * 的回显）判为诱饵。
 */
export function validBareOutputEntries(entries: readonly unknown[]): boolean {
  for (const item of entries) {
    if (!isPlainObject(item)) return false
    const text = item['text']
    const kind = item['kind']
    const textValue = typeof text === 'string' ? text : ''
    const kindValue = typeof kind === 'string' ? kind : ''
    if (trimSpaceGo(textValue) !== '' || isValidKind(kindValue)) return true
  }
  return false
}

/** 内联标记正则（Go `inlineMarkerRe`）。 */
const inlineMarkerRe = compile('⟦ruby:([^/⟧]+)/([^/⟧]+)(?:/([^⟧]+))?⟧')

/** `[ruby]` 段行首的段号正则（Go `sectionRubyLineRe`）。 */
const sectionRubyLineRe = compile('^(\\d+):\\s*(.+)')

/** 收集全部子匹配（等价 Go `FindAllStringSubmatch`）。 */
function findAllStringSubmatch(re: ReturnType<typeof compile>, src: string): string[][] {
  const matcher = re.matcher(src)
  const out: string[][] = []
  const count = matcher.groupCount()
  while (matcher.find()) {
    const groups: string[] = []
    for (let i = 0; i <= count; i++) {
      const g = matcher.group(i)
      groups.push(g === null || g === undefined ? '' : g)
    }
    out.push(groups)
  }
  return out
}

/** 从译文提取内联标记（Go `ruby.ParseInlineMarkers`）。 */
export function parseInlineMarkers(text: string): RubyOutputEntry[] {
  const matches = findAllStringSubmatch(inlineMarkerRe, text)
  if (matches.length === 0) return []
  const entries: RubyOutputEntry[] = []
  for (const groups of matches) {
    if (groups.length < 3) continue
    entries.push(
      newOutputEntry({
        base: groups[1] as string,
        text: groups[2] as string,
        kind: groups.length > 3 ? (groups[3] as string) : '',
      }),
    )
  }
  return entries
}

/** 去除 item id 的 prompt 展示前缀 `#` 并 trim（Go `trimIDPrefix`）。 */
function trimIDPrefix(id: string): string {
  let value = trimSpaceGo(id)
  if (value.startsWith('#')) value = value.slice(1)
  return trimSpaceGo(value)
}

/** 从右解析 "base | text | kind"（Go `parseBaseTextKind`）。 */
function parseBaseTextKind(content: string): {
  ok: boolean
  base: string
  text: string
  kind: string
} {
  const kindIdx = content.lastIndexOf('|')
  if (kindIdx < 0) return { ok: false, base: '', text: '', kind: '' }
  const kind = trimSpaceGo(content.slice(kindIdx + 1))
  const rest = content.slice(0, kindIdx)
  const textIdx = rest.lastIndexOf('|')
  if (textIdx < 0) return { ok: false, base: '', text: '', kind: '' }
  const base = trimSpaceGo(rest.slice(0, textIdx))
  const text = trimSpaceGo(rest.slice(textIdx + 1))
  if (base === '' || text === '') return { ok: false, base: '', text: '', kind: '' }
  return { ok: true, base, text, kind }
}

/**
 * 解析单行 ruby 标注（Go `ruby.ParseSectionLine`）。
 *
 * 3 字段（最右侧为合法 kind）或 4 字段（最右侧为 id，其左为 kind）。
 */
export function parseSectionLine(content: string): {
  ok: boolean
  base: string
  text: string
  kind: string
  itemId: string
} {
  const itemIdx = content.lastIndexOf('|')
  if (itemIdx < 0) return { ok: false, base: '', text: '', kind: '', itemId: '' }
  const rightmost = trimSpaceGo(content.slice(itemIdx + 1))
  if (rightmost === '') return { ok: false, base: '', text: '', kind: '', itemId: '' }
  if (isValidKind(rightmost)) {
    const parsed = parseBaseTextKind(content)
    return { ...parsed, itemId: '' }
  }
  const four = parseBaseTextKind(content.slice(0, itemIdx))
  if (four.ok) {
    return { ...four, itemId: trimIDPrefix(rightmost) }
  }
  const three = parseBaseTextKind(content)
  return { ...three, itemId: '' }
}

/** 按引号感知切分 `|` 字段（Go `splitQuotedTextFieldsLimit`）。 */
function splitQuotedTextFieldsLimit(text: string, limit: number): string[] {
  const fields: string[] = []
  let start = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i)
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '|') {
      fields.push(text.slice(start, i))
      start = i + 1
      if (fields.length === limit) break
    }
  }
  fields.push(text.slice(start))
  return fields
}

/** 解析引号形态的四字段行（Go `parseQuotedTextEntry`，`requireOccurrence=false`）。 */
function parsePrimaryTextEntry(text: string): RubyOutputEntry {
  const fields = splitQuotedTextFieldsLimit(text, 5)
  const entry = newOutputEntry({ invalid: fields.length !== 4 })
  const targets = ['base', 'text', 'kind', 'id'] as const
  for (let i = 0; i < targets.length; i++) {
    if (i >= fields.length) break
    const literal = trimSpaceGo(fields[i] as string)
    if (literal === '' || !literal.startsWith('"')) {
      entry.invalid = true
      continue
    }
    try {
      const node = parseJsonWhole(literal)
      if (node.kind !== 'string') {
        entry.invalid = true
        continue
      }
      const field = targets[i] as 'base' | 'text' | 'kind' | 'id'
      entry[field] = node.stringValue ?? ''
    } catch {
      entry.invalid = true
    }
  }
  if (entry.id === '' || entry.base === '' || entry.text === '' || !isValidKind(entry.kind)) {
    entry.invalid = true
  }
  return entry
}

/**
 * 解析 section 模式的 `[ruby]` 段落（Go `ruby.ParseSectionRubyOutput`）。
 *
 * 行首编号是段号（map key），不是条目 id；条目 id 仅来自可选的第四字段。
 */
export function parseSectionRubyOutput(lines: readonly string[]): RubyOutputMap {
  const result: RubyOutputMap = {}
  for (const rawLine of lines) {
    const line = trimSpaceGo(rawLine)
    if (line === '') continue
    const match = findAllStringSubmatch(sectionRubyLineRe, line)[0]
    if (!match) continue
    const id = match[1] as string
    const content = match[2] as string
    let entry: RubyOutputEntry
    if (trimSpaceGo(content).startsWith('"')) {
      entry = parsePrimaryTextEntry(content)
    } else {
      const parsed = parseSectionLine(content)
      if (!parsed.ok) continue
      entry = newOutputEntry({
        base: parsed.base,
        text: parsed.text,
        kind: parsed.kind,
        id: parsed.itemId,
      })
    }
    const existing = result[id]
    if (existing) existing.push(entry)
    else result[id] = [entry]
  }
  return result
}

// ---------------------------------------------------------------------------
// 普通 json.Unmarshal 路径（Go `decodeKeyed` 的 []ruby.OutputEntry 语义）
// ---------------------------------------------------------------------------

/**
 * 把普通 JSON 值按 Go `json.Unmarshal` 到 `[]ruby.OutputEntry` 的语义解码。
 *
 * 与 `parseOutputEntries` 的关键差异：普通 Unmarshal **不**标记 `invalid`，
 * 重复成员按「后者覆盖前者」处理，字段类型不匹配会让整个解码失败。
 * `TryRepairRubyAlignment` 走的正是这条路径。
 */
export function decodeOutputEntriesPlain(value: unknown): RubyOutputEntry[] {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) {
    throw new Error('json: cannot unmarshal non-array into Go value of type []ruby.OutputEntry')
  }
  return value.map((item) => decodeOutputEntryPlain(item))
}

/** 普通 Unmarshal 单行。 */
function decodeOutputEntryPlain(value: unknown): RubyOutputEntry {
  const entry = newOutputEntry()
  if (value === null || value === undefined) return entry
  if (isRawJsonValue(value)) {
    const node = parseJsonWhole(value.__rawJson)
    if (node.kind === 'null') return entry
    if (node.kind !== 'object') {
      throw new Error('json: cannot unmarshal non-object into Go value of type ruby.OutputEntry')
    }
    // 重复成员后者覆盖（Go 的 struct 解码语义）。
    const fields = new Map<string, JsonNode>()
    for (const member of node.members ?? []) fields.set(member.key, member.value)
    for (const [name, field] of fields) {
      applyPlainField(entry, name, field)
    }
    return entry
  }
  if (!isPlainObject(value)) {
    throw new Error('json: cannot unmarshal non-object into Go value of type ruby.OutputEntry')
  }
  for (const [name, field] of Object.entries(value)) {
    applyPlainFieldValue(entry, name, field)
  }
  return entry
}

/** 按节点写入普通 Unmarshal 的字段（类型不匹配抛错）。 */
function applyPlainField(entry: RubyOutputEntry, name: string, node: JsonNode): void {
  switch (name) {
    case 'id':
    case 'base':
    case 'text':
    case 'kind': {
      const r = decodeStringField(node)
      if (!r.ok) {
        throw new Error(`json: cannot unmarshal into Go struct field ${name} of type string`)
      }
      entry[name as 'id' | 'base' | 'text' | 'kind'] = r.value
      return
    }
    case 'occurrence': {
      const r = decodeIntField(node)
      if (!r.ok) {
        throw new Error('json: cannot unmarshal into Go struct field occurrence of type int')
      }
      entry.occurrence = r.value
      return
    }
    default:
      return
  }
}

/** 按普通 JS 值写入普通 Unmarshal 的字段（类型不匹配抛错）。 */
function applyPlainFieldValue(entry: RubyOutputEntry, name: string, value: unknown): void {
  switch (name) {
    case 'id':
    case 'base':
    case 'text':
    case 'kind': {
      if (value === null) {
        entry[name as 'id' | 'base' | 'text' | 'kind'] = ''
        return
      }
      if (typeof value !== 'string') {
        throw new Error(`json: cannot unmarshal into Go struct field ${name} of type string`)
      }
      entry[name as 'id' | 'base' | 'text' | 'kind'] = value
      return
    }
    case 'occurrence': {
      if (value === null) {
        entry.occurrence = 0
        return
      }
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new Error('json: cannot unmarshal into Go struct field occurrence of type int')
      }
      entry.occurrence = value
      return
    }
    default:
      return
  }
}

/** 判断是否为原始 JSON 值（避免循环导入）。 */
function isRawJsonValue(value: unknown): value is { __rawJson: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__rawJson' in value &&
    typeof (value as { __rawJson: unknown }).__rawJson === 'string'
  )
}
