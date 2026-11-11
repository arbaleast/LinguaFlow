/**
 * 严格 JSON 解析/序列化的领域层实现（等价 Go `encoding/json` 的所需子集）。
 *
 * 为什么不能直接用 `JSON.parse`：
 *
 * 1. **重复成员**：`backend/internal/repair/ruby_raw.go` 依赖「原始 JSON 保留重复
 *    成员」来标记畸形注音行（`{"id":"other","id":"6",...}` 必须被识别为 invalid）。
 *    `JSON.parse` 会静默丢弃重复成员，导致重复 ID 校验被绕过。
 * 2. **原始切片**：`preserveRawRubyFields` / `extractBareArrayAsEnvelope` 需要
 *    值的原始文本区间（Go `json.RawMessage`）。
 * 3. **Go 的 `null`→nil map**：`json.Unmarshal("null", &map)` 不报错，而
 *    `JSON.parse` 返回 `null`；顶层非对象必须报错。
 *
 * 本模块只解析 JSON 语法本身（零平台依赖），不做 schema 校验。
 */

/** JSON 语法错误（对应 Go `json.SyntaxError`）。 */
export class JsonParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JsonParseError'
  }
}

/** 解析后的 JSON 节点（保留原始文本区间与全部成员，含重复 key）。 */
export interface JsonNode {
  kind: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'
  /** 值在源文本中的起始下标（UTF-16 code unit）。 */
  start: number
  /** 值在源文本中的结束下标（不含）。 */
  end: number
  /** 对象成员（按出现顺序，保留重复 key）。 */
  members?: JsonMember[]
  /** 数组元素。 */
  items?: JsonNode[]
  stringValue?: string
  numberValue?: number
  booleanValue?: boolean
}

/** 对象成员。 */
export interface JsonMember {
  key: string
  value: JsonNode
}

/** 原始 JSON 值（Go `json.RawMessage` 的语义等价物）。 */
export interface RawJson {
  readonly __rawJson: string
}

/** 构造原始 JSON 值。 */
export function rawJson(raw: string): RawJson {
  return { __rawJson: raw }
}

/** 判断是否为原始 JSON 值。 */
export function isRawJson(value: unknown): value is RawJson {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__rawJson' in value &&
    typeof (value as { __rawJson: unknown }).__rawJson === 'string'
  )
}

/** 判断是否为普通 JSON 对象（排除数组、null、RawJson）。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isRawJson(value)
}

const CH_QUOTE = 0x22
const CH_BACKSLASH = 0x5c
const CH_SLASH = 0x2f
const CH_OPEN_BRACE = 0x7b
const CH_CLOSE_BRACE = 0x7d
const CH_OPEN_BRACKET = 0x5b
const CH_CLOSE_BRACKET = 0x5d
const CH_COLON = 0x3a
const CH_COMMA = 0x2c

function isJsonWhitespace(code: number): boolean {
  // JSON 只允许 0x20 / 0x09 / 0x0A / 0x0D（与 Go encoding/json 一致）。
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d
}

function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10
  return -1
}

class JsonParser {
  private pos: number

  constructor(
    private readonly text: string,
    start = 0,
  ) {
    this.pos = start
  }

  get position(): number {
    return this.pos
  }

  skipWhitespace(): void {
    while (this.pos < this.text.length && isJsonWhitespace(this.text.charCodeAt(this.pos))) {
      this.pos++
    }
  }

  parseValue(): JsonNode {
    this.skipWhitespace()
    if (this.pos >= this.text.length) {
      throw new JsonParseError('unexpected end of JSON input')
    }
    const code = this.text.charCodeAt(this.pos)
    if (code === CH_OPEN_BRACE) return this.parseObject()
    if (code === CH_OPEN_BRACKET) return this.parseArray()
    if (code === CH_QUOTE) return this.parseString()
    if (code === 0x74) return this.parseLiteral('true', 'boolean', true)
    if (code === 0x66) return this.parseLiteral('false', 'boolean', false)
    if (code === 0x6e) return this.parseLiteral('null', 'null', undefined)
    if (code === 0x2d || (code >= 0x30 && code <= 0x39)) return this.parseNumber()
    throw new JsonParseError(
      `invalid character '${this.text.charAt(this.pos)}' looking for beginning of value`,
    )
  }

  private parseObject(): JsonNode {
    const start = this.pos
    this.pos++ // '{'
    const members: JsonMember[] = []
    this.skipWhitespace()
    if (this.pos < this.text.length && this.text.charCodeAt(this.pos) === CH_CLOSE_BRACE) {
      this.pos++
      return { kind: 'object', start, end: this.pos, members }
    }
    for (;;) {
      this.skipWhitespace()
      if (this.pos >= this.text.length || this.text.charCodeAt(this.pos) !== CH_QUOTE) {
        throw new JsonParseError('invalid character looking for beginning of object key string')
      }
      const keyNode = this.parseString()
      this.skipWhitespace()
      if (this.pos >= this.text.length || this.text.charCodeAt(this.pos) !== CH_COLON) {
        throw new JsonParseError('invalid character after object key')
      }
      this.pos++ // ':'
      const value = this.parseValue()
      members.push({ key: keyNode.stringValue ?? '', value })
      this.skipWhitespace()
      if (this.pos >= this.text.length) {
        throw new JsonParseError('unexpected end of JSON input')
      }
      const code = this.text.charCodeAt(this.pos)
      if (code === CH_COMMA) {
        this.pos++
        continue
      }
      if (code === CH_CLOSE_BRACE) {
        this.pos++
        return { kind: 'object', start, end: this.pos, members }
      }
      throw new JsonParseError('invalid character after object key:value pair')
    }
  }

  private parseArray(): JsonNode {
    const start = this.pos
    this.pos++ // '['
    const items: JsonNode[] = []
    this.skipWhitespace()
    if (this.pos < this.text.length && this.text.charCodeAt(this.pos) === CH_CLOSE_BRACKET) {
      this.pos++
      return { kind: 'array', start, end: this.pos, items }
    }
    for (;;) {
      items.push(this.parseValue())
      this.skipWhitespace()
      if (this.pos >= this.text.length) {
        throw new JsonParseError('unexpected end of JSON input')
      }
      const code = this.text.charCodeAt(this.pos)
      if (code === CH_COMMA) {
        this.pos++
        continue
      }
      if (code === CH_CLOSE_BRACKET) {
        this.pos++
        return { kind: 'array', start, end: this.pos, items }
      }
      throw new JsonParseError('invalid character after array element')
    }
  }

  private parseString(): JsonNode {
    const start = this.pos
    this.pos++ // '"'
    let out = ''
    for (;;) {
      if (this.pos >= this.text.length) {
        throw new JsonParseError('unexpected end of JSON input')
      }
      const code = this.text.charCodeAt(this.pos)
      if (code === CH_QUOTE) {
        this.pos++
        return { kind: 'string', start, end: this.pos, stringValue: out }
      }
      if (code === CH_BACKSLASH) {
        this.pos++
        if (this.pos >= this.text.length) {
          throw new JsonParseError('unexpected end of JSON input')
        }
        const esc = this.text.charCodeAt(this.pos)
        this.pos++
        switch (esc) {
          case CH_QUOTE:
            out += '"'
            break
          case CH_BACKSLASH:
            out += '\\'
            break
          case CH_SLASH:
            out += '/'
            break
          case 0x62:
            out += '\b'
            break
          case 0x66:
            out += '\f'
            break
          case 0x6e:
            out += '\n'
            break
          case 0x72:
            out += '\r'
            break
          case 0x74:
            out += '\t'
            break
          case 0x75: {
            out += this.parseUnicodeEscape()
            break
          }
          default:
            throw new JsonParseError('invalid character in string escape code')
        }
        continue
      }
      if (code < 0x20) {
        throw new JsonParseError('invalid character in string literal')
      }
      out += this.text.charAt(this.pos)
      this.pos++
    }
  }

  /** 解析 `\uXXXX`（不含前导 `\u`，pos 已越过 `u`）；非法代理按 U+FFFD 归一。 */
  private parseUnicodeEscape(): string {
    const readUnit = (): number => {
      if (this.pos + 4 > this.text.length) {
        throw new JsonParseError('unexpected end of JSON input')
      }
      let unit = 0
      for (let i = 0; i < 4; i++) {
        const h = hexValue(this.text.charCodeAt(this.pos + i))
        if (h < 0) throw new JsonParseError('invalid character in \\u hexadecimal character escape')
        unit = (unit << 4) | h
      }
      this.pos += 4
      return unit
    }
    const hi = readUnit()
    if (hi >= 0xd800 && hi <= 0xdbff) {
      // 尝试与紧随其后的低代理组合（Go encoding/json 的 unquoteBytes 行为）。
      if (
        this.pos + 6 <= this.text.length &&
        this.text.charCodeAt(this.pos) === CH_BACKSLASH &&
        this.text.charCodeAt(this.pos + 1) === 0x75
      ) {
        const saved = this.pos
        this.pos += 2
        const lo = readUnit()
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          const cp = 0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00)
          return String.fromCodePoint(cp)
        }
        this.pos = saved
      }
      return '\uFFFD'
    }
    if (hi >= 0xdc00 && hi <= 0xdfff) return '\uFFFD'
    return String.fromCharCode(hi)
  }

  private parseLiteral(
    literal: string,
    kind: 'boolean' | 'null',
    value: boolean | undefined,
  ): JsonNode {
    const start = this.pos
    if (!this.text.startsWith(literal, this.pos)) {
      throw new JsonParseError(
        `invalid character '${this.text.charAt(this.pos)}' looking for beginning of value`,
      )
    }
    this.pos += literal.length
    if (kind === 'boolean') {
      return { kind, start, end: this.pos, booleanValue: value }
    }
    return { kind, start, end: this.pos }
  }

  private parseNumber(): JsonNode {
    const start = this.pos
    const rest = this.text.slice(this.pos)
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest)
    if (!match) {
      throw new JsonParseError('invalid number literal')
    }
    const literal = match[0]
    this.pos += literal.length
    const value = Number(literal)
    if (!Number.isFinite(value)) {
      throw new JsonParseError(`number ${literal} is out of range`)
    }
    return { kind: 'number', start, end: this.pos, numberValue: value }
  }

  /** 当前下标之后是否还有非空白字符。 */
  hasTrailingNonWhitespace(): boolean {
    let i = this.pos
    while (i < this.text.length && isJsonWhitespace(this.text.charCodeAt(i))) i++
    return i < this.text.length
  }
}

/**
 * 解析整段文本为一个 JSON 值（等价 `json.Unmarshal` 的语法阶段）。
 *
 * 尾部存在非空白数据时报错。
 */
export function parseJsonWhole(text: string): JsonNode {
  const parser = new JsonParser(text)
  parser.skipWhitespace()
  if (parser.position >= text.length) {
    throw new JsonParseError('unexpected end of JSON input')
  }
  const node = parser.parseValue()
  if (parser.hasTrailingNonWhitespace()) {
    throw new JsonParseError('invalid character after top-level value')
  }
  return node
}

/**
 * 解析一个值前缀，忽略其后多余的尾部数据（等价 `json.Decoder.Decode` 的语义）。
 *
 * 失败返回 `null`（调用方按 Go 的 `err != nil` 处理）。
 */
export function parseJsonPrefix(text: string): JsonNode | null {
  try {
    const parser = new JsonParser(text)
    return parser.parseValue()
  } catch {
    return null
  }
}

/** 节点的原始文本（`text[node.start..node.end)`）。 */
export function nodeRaw(text: string, node: JsonNode): string {
  return text.slice(node.start, node.end)
}

/** 节点 → Go `any` 值（对象重复 key 取最后一个，与 Go map 一致）。 */
export function nodeToValue(node: JsonNode): unknown {
  switch (node.kind) {
    case 'null':
      return null
    case 'boolean':
      return node.booleanValue ?? false
    case 'number':
      return node.numberValue ?? 0
    case 'string':
      return node.stringValue ?? ''
    case 'array':
      return (node.items ?? []).map(nodeToValue)
    case 'object': {
      const out: Record<string, unknown> = {}
      for (const member of node.members ?? []) {
        out[member.key] = nodeToValue(member.value)
      }
      return out
    }
  }
}

/**
 * 深相等，等价 Go `reflect.DeepEqual` 在本包所需子集上的语义。
 *
 * `RawJson` 按原始文本逐字节比较（Go 的 `json.RawMessage` 是 `[]byte`）。
 */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (isRawJson(a) || isRawJson(b)) {
    return isRawJson(a) && isRawJson(b) && a.__rawJson === b.__rawJson
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualJson(a[i], b[i])) return false
    }
    return true
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false
    const ak = Object.keys(a)
    const bk = Object.keys(b)
    if (ak.length !== bk.length) return false
    for (const key of ak) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false
      if (!deepEqualJson(a[key], b[key])) return false
    }
    return true
  }
  return false
}

/** Go `%q` 的字符串转义（text/template 的 `printf "%q"`）。 */
export function goQuote(text: string): string {
  let out = '"'
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    switch (code) {
      case 0x07:
        out += '\\a'
        continue
      case 0x08:
        out += '\\b'
        continue
      case 0x0c:
        out += '\\f'
        continue
      case 0x0a:
        out += '\\n'
        continue
      case 0x0d:
        out += '\\r'
        continue
      case 0x09:
        out += '\\t'
        continue
      case 0x0b:
        out += '\\v'
        continue
      case 0x5c:
        out += '\\\\'
        continue
      case 0x22:
        out += '\\"'
        continue
    }
    if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, '0')}`
      continue
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text.charAt(i) + text.charAt(i + 1)
        i++
      } else {
        out += '\\ufffd'
      }
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += '\\ufffd'
      continue
    }
    if (code === 0x2028 || code === 0x2029) {
      out += `\\u${code.toString(16).padStart(4, '0')}`
      continue
    }
    out += text.charAt(i)
  }
  return out + '"'
}

/**
 * Go `%q` 的字符串转义（**字节级**版本）。
 *
 * 与 `goQuote` 的区别：输入是原始字节，可包含**非法 UTF-8 字节序列**
 * （Go 的 `s[:200]` 按字节切片，可能切开多字节 rune）。
 * Go 的 `strconv.Quote` 对非法字节输出 `\xNN`，对合法 rune 走标准转义表。
 */
export function goQuoteBytes(bytes: Uint8Array): string {
  let out = '"'
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i] as number
    if (b < 0x80) {
      switch (b) {
        case 0x07:
          out += '\\a'
          break
        case 0x08:
          out += '\\b'
          break
        case 0x0c:
          out += '\\f'
          break
        case 0x0a:
          out += '\\n'
          break
        case 0x0d:
          out += '\\r'
          break
        case 0x09:
          out += '\\t'
          break
        case 0x0b:
          out += '\\v'
          break
        case 0x5c:
          out += '\\\\'
          break
        case 0x22:
          out += '\\"'
          break
        default:
          if (b < 0x20 || b === 0x7f) {
            out += `\\x${b.toString(16).padStart(2, '0')}`
          } else {
            out += String.fromCharCode(b)
          }
          break
      }
      i++
      continue
    }
    const decoded = decodeUtf8One(bytes, i)
    if (decoded === null) {
      out += `\\x${b.toString(16).padStart(2, '0')}`
      i++
      continue
    }
    out += decoded.text
    i += decoded.size
  }
  return out + '"'
}

/**
 * 解码一个 UTF-8 字符（严格：拒绝过长编码、代理区与越界码位）。
 *
 * @returns 成功时返回字符与字节长度；非法序列返回 `null`。
 */
function decodeUtf8One(bytes: Uint8Array, start: number): { text: string; size: number } | null {
  const b0 = bytes[start] as number
  let size = 0
  let cp = 0
  if (b0 >= 0xc2 && b0 <= 0xdf) {
    size = 2
    cp = b0 & 0x1f
  } else if (b0 >= 0xe0 && b0 <= 0xef) {
    size = 3
    cp = b0 & 0x0f
  } else if (b0 >= 0xf0 && b0 <= 0xf4) {
    size = 4
    cp = b0 & 0x07
  } else {
    return null
  }
  if (start + size > bytes.length) return null
  for (let k = 1; k < size; k++) {
    const cont = bytes[start + k] as number
    if ((cont & 0xc0) !== 0x80) return null
    cp = (cp << 6) | (cont & 0x3f)
  }
  // 过长编码、代理区、越界码位一律非法（与 Go 的 utf8 解码规则一致）。
  if (size === 3 && cp < 0x800) return null
  if (size === 4 && cp < 0x10000) return null
  if (cp >= 0xd800 && cp <= 0xdfff) return null
  if (cp > 0x10ffff) return null
  return { text: String.fromCodePoint(cp), size }
}

/** Go `json.Marshal` 的字符串转义（含 HTML 安全转义）。 */
export function goJSONString(text: string): string {
  let out = '"'
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    switch (code) {
      case 0x22:
        out += '\\"'
        continue
      case 0x5c:
        out += '\\\\'
        continue
      case 0x0a:
        out += '\\n'
        continue
      case 0x0d:
        out += '\\r'
        continue
      case 0x09:
        out += '\\t'
        continue
      case 0x3c:
        out += '\\u003c'
        continue
      case 0x3e:
        out += '\\u003e'
        continue
      case 0x26:
        out += '\\u0026'
        continue
      case 0x2028:
        out += '\\u2028'
        continue
      case 0x2029:
        out += '\\u2029'
        continue
    }
    if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, '0')}`
      continue
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text.charAt(i) + text.charAt(i + 1)
        i++
      } else {
        out += '\\ufffd'
      }
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += '\\ufffd'
      continue
    }
    out += text.charAt(i)
  }
  return out + '"'
}

function marshalNumber(value: number): string {
  if (!Number.isFinite(value)) return 'null'
  if (Number.isInteger(value) && Math.abs(value) < 1e21) return String(value)
  return String(value)
}

/**
 * 序列化为紧凑 JSON（等价 Go `json.Marshal` 在本包所需子集上的语义）。
 *
 * - 对象 key 按字典序输出（Go 对 `map` 的排序）；
 * - `RawJson` 原样输出（Go `json.RawMessage` 的 Marshaler 行为，语义上已 compact）；
 * - 字符串按 Go 的 HTML 安全转义（`<` `>` `&` 与 U+2028/2029）。
 */
export function marshalGo(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (isRawJson(value)) return value.__rawJson
  if (typeof value === 'string') return goJSONString(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return marshalNumber(value)
  if (Array.isArray(value)) {
    return `[${value.map((item) => marshalGo(item)).join(',')}]`
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort()
    const parts: string[] = []
    for (const key of keys) {
      parts.push(`${goJSONString(key)}:${marshalGo(value[key])}`)
    }
    return `{${parts.join(',')}}`
  }
  return 'null'
}
