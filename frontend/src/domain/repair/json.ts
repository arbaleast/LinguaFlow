/**
 * JSON 字节/字符级修复算子（对应 Go `backend/internal/repair/json.go`）。
 *
 * ## byte vs rune
 *
 * Go 侧所有这些扫描器都按 **UTF-8 字节**迭代，但只在 **ASCII 结构字符**
 * （`{ } [ ] " \ , :`、空白、`t/f/n` 字面量）处做判定与切片。UTF-8 多字节序列
 * 的每个字节都 ≥ 0x80，绝不可能等于这些 ASCII 字节；同理 JS 的 UTF-16 代理对
 * 由两个 ≥ 0xD800 的 code unit 组成，也不会等于 ASCII。因此在 JS 里按
 * **code unit** 扫描并切片，与 Go 的字节扫描在「ASCII 边界」上完全等价，
 * 截取出的子串逐字符相同。唯一需要字节语义的是 `len(tail) <= 4096`
 * （鲁棒扫描窗口）——那里显式使用 `utf8Length()`。
 *
 * 本模块为纯函数，零 DOM / 网络 / 存储 / Node API。
 */
import { compile, replaceAllStringFunc } from '../shared/re2'
import { utf8Length } from '../shared/unicode'
import {
  deepEqualJson,
  isPlainObject,
  marshalGo,
  nodeToValue,
  parseJsonPrefix,
  rawJson,
} from './json_parse'
import { trimSpaceGo } from './strings'
import { unmarshalGeneric } from './values'

const CH_QUOTE = 0x22
const CH_BACKSLASH = 0x5c
const CH_OPEN_BRACE = 0x7b
const CH_CLOSE_BRACE = 0x7d
const CH_OPEN_BRACKET = 0x5b
const CH_CLOSE_BRACKET = 0x5d
const CH_COMMA = 0x2c
const CH_COLON = 0x3a

/** BOM 与零宽字符（Go `stripBOMAndZeroWidth` 的字符集合）。 */
const BOM_AND_ZERO_WIDTH_RE = compile('\uFEFF|\u200B|\u200C|\u200D')

/**
 * 去掉文本中常见的 BOM 与零宽字符（U+FEFF / U+200B-U+200D）。
 *
 * 返回 `{text, did}`：`did` 表示是否做过修改。
 */
export function stripBOMAndZeroWidth(text: string): { text: string; did: boolean } {
  const cleaned = replaceAllStringFunc(BOM_AND_ZERO_WIDTH_RE, text, () => '')
  return { text: cleaned, did: cleaned !== text }
}

/**
 * 从 `text[start]`（假定是 `{`）扫描到配对的 `}`，返回其下标；未匹配返回 -1。
 * 期间正确跳过字符串内的转义与大括号。
 */
export function matchBracePair(text: string, start: number): number {
  if (start >= text.length || text.charCodeAt(start) !== CH_OPEN_BRACE) return -1
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (inStr) {
      if (esc) {
        esc = false
        continue
      }
      if (c === CH_BACKSLASH) {
        esc = true
      } else if (c === CH_QUOTE) {
        inStr = false
      }
      continue
    }
    if (c === CH_QUOTE) {
      inStr = true
    } else if (c === CH_OPEN_BRACE) {
      depth++
    } else if (c === CH_CLOSE_BRACE) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** 从 text 中截取首个 `{` 到配对 `}` 之间的子串（Go `jsonObjectSlice`）。 */
export function jsonObjectSlice(text: string): string {
  const start = text.indexOf('{')
  if (start < 0) return ''
  const end = matchBracePair(text, start)
  if (end < 0) return ''
  return text.slice(start, end + 1)
}

/**
 * 扫描所有 balanced `{...}` 区间，返回首个含 `"requiredKey"` 字面的对象。
 * 找不到返回空串（Go `extractJSONObjectContaining`）。
 */
export function extractJSONObjectContaining(text: string, requiredKey: string): string {
  const needle = `"${requiredKey}"`
  let pos = 0
  while (pos < text.length) {
    const off = text.slice(pos).indexOf('{')
    if (off < 0) return ''
    const start = pos + off
    const end = matchBracePair(text, start)
    if (end < 0) return ''
    const body = text.slice(start, end + 1)
    if (body.includes(needle)) return body
    pos = end + 1
  }
  return ''
}

/** 移除字符串外的尾随逗号（`,}` / `,]`，允许夹空白）；Go `fixTrailingCommas`。 */
export function fixTrailingCommas(s: string): string {
  let out = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (inStr) {
      out += s.charAt(i)
      if (esc) {
        esc = false
      } else if (c === CH_BACKSLASH) {
        esc = true
      } else if (c === CH_QUOTE) {
        inStr = false
      }
      continue
    }
    if (c === CH_QUOTE) {
      inStr = true
      out += s.charAt(i)
      continue
    }
    if (c === CH_COMMA) {
      let j = i + 1
      while (j < s.length) {
        const n = s.charCodeAt(j)
        if (n === 0x20 || n === 0x09 || n === 0x0a || n === 0x0d) j++
        else break
      }
      if (j < s.length) {
        const n = s.charCodeAt(j)
        if (n === CH_CLOSE_BRACE || n === CH_CLOSE_BRACKET) continue
      }
    }
    out += s.charAt(i)
  }
  return out
}

/**
 * 把字符串值内未转义的控制字符（< 0x20）转为 `\uXXXX`；字符串外不动。
 * Go `escapeControlChars`。
 */
export function escapeControlChars(s: string): string {
  let out = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (inStr) {
      if (esc) {
        out += s.charAt(i)
        esc = false
        continue
      }
      if (c === CH_BACKSLASH) {
        out += s.charAt(i)
        esc = true
        continue
      }
      if (c === CH_QUOTE) {
        out += s.charAt(i)
        inStr = false
        continue
      }
      if (c < 0x20) {
        out += `\\u${c.toString(16).toUpperCase().padStart(4, '0')}`
        continue
      }
      out += s.charAt(i)
      continue
    }
    if (c === CH_QUOTE) inStr = true
    out += s.charAt(i)
  }
  return out
}

/**
 * 判断 `s[at:]` 起首个非空白字符是否为合法字符串终止上下文：
 * `,` `}` `]` `:` 之一（Go `isLegalStringTerminator`）。
 */
function isLegalStringTerminator(s: string, at: number): boolean {
  for (let j = at; j < s.length; j++) {
    switch (s.charCodeAt(j)) {
      case 0x20:
      case 0x09:
      case 0x0a:
      case 0x0d:
        continue
      case CH_COMMA:
      case CH_CLOSE_BRACE:
      case CH_CLOSE_BRACKET:
      case CH_COLON:
        return true
      default:
        return false
    }
  }
  return true
}

/**
 * 判断 `s[at:]` 起首个非空白字符是否为值位置引号闭合的合法后继：
 * `,` `}` `]` 或 EOF（Go `isValueTerminator`）。
 */
function isValueTerminator(s: string, at: number): boolean {
  for (let j = at; j < s.length; j++) {
    switch (s.charCodeAt(j)) {
      case 0x20:
      case 0x09:
      case 0x0a:
      case 0x0d:
        continue
      case CH_COMMA:
      case CH_CLOSE_BRACE:
      case CH_CLOSE_BRACKET:
        return true
      default:
        return false
    }
  }
  return true
}

/**
 * 修复字符串值内未转义的双引号（Go `escapeUnescapedQuotes`）。
 *
 * 扫描整段：字符串内遇到非转义 `"` 时，若其后首个非空白字符不是合法终止
 * 上下文（`,` `}` `]` `:`），判定为值内引号并转义为 `\"`。
 */
export function escapeUnescapedQuotes(s: string): string {
  let out = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (inStr) {
      if (esc) {
        out += s.charAt(i)
        esc = false
        continue
      }
      if (c === CH_BACKSLASH) {
        out += s.charAt(i)
        esc = true
        continue
      }
      if (c === CH_QUOTE) {
        if (isLegalStringTerminator(s, i + 1)) {
          out += s.charAt(i)
          inStr = false
        } else {
          out += '\\"'
        }
        continue
      }
      out += s.charAt(i)
      continue
    }
    if (c === CH_QUOTE) inStr = true
    out += s.charAt(i)
  }
  return out
}

/**
 * 返回截至最后一个「值闭合点」的前缀（Go `truncateToLastCompleteValue`）。
 *
 * 值闭合点：值位置引号闭合且后继为 `,` `}` `]` / EOF；或 `}` `]` 容器闭合。
 * 无闭合点或闭合点恰在末尾时返回 `(原文, false)`。
 */
export function truncateToLastCompleteValue(s: string): { cut: string; ok: boolean } {
  let cut = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (inStr) {
      if (esc) {
        esc = false
        continue
      }
      if (c === CH_BACKSLASH) {
        esc = true
      } else if (c === CH_QUOTE) {
        if (isValueTerminator(s, i + 1)) cut = i + 1
        inStr = false
      }
      continue
    }
    if (c === CH_QUOTE) {
      inStr = true
    } else if (c === CH_CLOSE_BRACE || c === CH_CLOSE_BRACKET) {
      cut = i + 1
    }
  }
  if (cut <= 0 || cut >= s.length) return { cut: s, ok: false }
  return { cut: s.slice(0, cut), ok: true }
}

/**
 * 补齐未平衡的括号（Go `closeUnbalancedBraces`）。
 *
 * 用栈追踪 `{`/`[`：数组型 envelope 被截断时只补 `}` 会导致 `]` 缺失。
 * 字符串未闭合时不补——补 `"` 容易把后续噪声纳入字符串值。
 */
export function closeUnbalancedBraces(s: string): string {
  const stack: string[] = []
  let inStr = false
  let esc = false
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (inStr) {
      if (esc) {
        esc = false
        continue
      }
      if (c === CH_BACKSLASH) {
        esc = true
      } else if (c === CH_QUOTE) {
        inStr = false
      }
      continue
    }
    if (c === CH_QUOTE) {
      inStr = true
    } else if (c === CH_OPEN_BRACE) {
      stack.push('{')
    } else if (c === CH_OPEN_BRACKET) {
      stack.push('[')
    } else if (c === CH_CLOSE_BRACE || c === CH_CLOSE_BRACKET) {
      const top = stack[stack.length - 1]
      if (top !== undefined) {
        if ((c === CH_CLOSE_BRACE && top === '{') || (c === CH_CLOSE_BRACKET && top === '[')) {
          stack.pop()
        }
      }
    }
  }
  if (inStr || stack.length === 0) return s
  let out = s
  for (let i = stack.length - 1; i >= 0; i--) {
    out += stack[i] === '{' ? '}' : ']'
  }
  return out
}

/** 鲁棒扫描的尝试偏移上限（Go `robustScanMaxAttempts`）。 */
export const ROBUST_SCAN_MAX_ATTEMPTS = 256
/** 鲁棒扫描的 close-braces 截断修补窗口（Go `robustScanTruncationWindow`，单位字节）。 */
export const ROBUST_SCAN_TRUNCATION_WINDOW = 4096

/**
 * 从每个 `{` 偏移用「解码首个 JSON 值」的方式恢复对象（Go `decodeKeyedEnvelope`）。
 * 仅当对象含 `requiredKey` 时返回。
 */
export function decodeKeyedEnvelope(
  s: string,
  requiredKey: string,
): Record<string, unknown> | null {
  const node = parseJsonPrefix(s)
  if (node === null) return null
  const rawText = s.slice(node.start, node.end)
  let raw: Record<string, unknown>
  try {
    raw = unmarshalGeneric(rawText)
  } catch {
    return null
  }
  if (!Object.prototype.hasOwnProperty.call(raw, requiredKey)) return null
  return raw
}

/**
 * 鲁棒扫描骨架（Go `scanKeyedObjectsPatch`）。
 *
 * `handle` 返回 false 表示停止扫描，true 表示继续找下一个候选。
 */
export function scanKeyedObjectsPatch(
  text: string,
  requiredKey: string,
  closeBracesPatch: boolean,
  handle: (raw: Record<string, unknown>) => boolean,
): void {
  let attempts = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== CH_OPEN_BRACE) continue
    attempts++
    if (attempts > ROBUST_SCAN_MAX_ATTEMPTS) break
    const tail = text.slice(i)
    let raw = decodeKeyedEnvelope(tail, requiredKey)
    if (raw === null && closeBracesPatch && utf8Length(tail) <= ROBUST_SCAN_TRUNCATION_WINDOW) {
      const fixed = closeUnbalancedBraces(tail)
      if (fixed !== tail) {
        raw = decodeKeyedEnvelope(fixed, requiredKey)
      }
    }
    if (raw === null) continue
    if (!handle(raw)) return
  }
}

/** Go `scanKeyedObjects`（close-braces 修补默认开启）。 */
export function scanKeyedObjects(
  text: string,
  requiredKey: string,
  handle: (raw: Record<string, unknown>) => boolean,
): void {
  scanKeyedObjectsPatch(text, requiredKey, true, handle)
}

/**
 * 鲁棒兜底：恢复含 canonical `translations`（值为 map）的对象（Go
 * `extractValidEnvelope`）。
 *
 * 多个候选的 translations 会合并（首键优先）；同一 ID 出现冲突值时放弃。
 */
export function extractValidEnvelope(text: string): {
  ok: boolean
  value: Record<string, unknown>
} {
  let first: Record<string, unknown> | null = null
  const merged: Record<string, unknown> = {}
  let aborted = false
  scanKeyedObjects(text, 'translations', (raw) => {
    const translations = raw['translations']
    if (!isPlainObject(translations)) return true
    if (first === null) first = raw
    for (const [key, value] of Object.entries(translations)) {
      if (Object.prototype.hasOwnProperty.call(merged, key)) {
        if (!deepEqualJson(merged[key], value)) {
          aborted = true
          return false
        }
        continue
      }
      merged[key] = value
    }
    return true
  })
  if (aborted || first === null) return { ok: false, value: {} }
  const out: Record<string, unknown> = { ...(first as Record<string, unknown>) }
  out['translations'] = merged
  return { ok: true, value: out }
}

/**
 * 通用鲁棒兜底：面向非 translations 的单键数组 envelope（Go
 * `extractValidObject`）。首个满足 `accept` 的候选即返回。
 */
export function extractValidObject(
  text: string,
  requiredKey: string,
  accept: ((raw: Record<string, unknown>) => boolean) | null,
  closeBracesPatch: boolean,
): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null
  scanKeyedObjectsPatch(text, requiredKey, closeBracesPatch, (raw) => {
    if (accept !== null && !accept(raw)) return true
    found = raw
    return false
  })
  return found
}

/** 裸数组兜底门控：非空且全部元素为 JSON 对象（Go `allObjectEntries`）。 */
export function allObjectEntries(arr: readonly unknown[]): boolean {
  if (arr.length === 0) return false
  for (const entry of arr) {
    if (!isPlainObject(entry)) return false
  }
  return true
}

/**
 * 单键数组 envelope 的裸数组兜底（Go `extractBareArrayAsEnvelope`）。
 *
 * 从每个 `[` 偏移解码首个 JSON 数组，仅当「非空且全对象」并通过 accept 时
 * 重新包装为 `{key: [...]}`。`closeBracesPatch=false` 时不做截断残尾修补。
 */
export function extractBareArrayAsEnvelope(
  text: string,
  key: string,
  accept: ((entries: unknown[]) => boolean) | null,
  closeBracesPatch: boolean,
): { ok: boolean; value: Record<string, unknown> } {
  let attempts = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== CH_OPEN_BRACKET) continue
    attempts++
    if (attempts > ROBUST_SCAN_MAX_ATTEMPTS) break
    let tail = text.slice(i)
    let node = parseJsonPrefix(tail)
    let arr: unknown[] | null =
      node !== null && node.kind === 'array'
        ? (node.items ?? []).map((item) => nodeToValue(item))
        : null
    if (arr === null && closeBracesPatch && utf8Length(tail) <= ROBUST_SCAN_TRUNCATION_WINDOW) {
      const fixed = closeUnbalancedBraces(tail)
      if (fixed !== tail) {
        tail = fixed
        node = parseJsonPrefix(tail)
        arr =
          node !== null && node.kind === 'array'
            ? (node.items ?? []).map((item) => nodeToValue(item))
            : null
      }
    }
    if (arr === null || !allObjectEntries(arr)) continue
    if (accept !== null && !accept(arr)) continue
    const end = node === null ? tail.length : node.end
    if (key === 'ruby_output') {
      return { ok: true, value: { [key]: rawRubyRows(tail, end) } }
    }
    return { ok: true, value: { [key]: arr } }
  }
  return { ok: false, value: {} }
}

/** 把数组前缀的每一行包装为原始 JSON（Go `rawRubyValue` 的数组分支）。 */
function rawRubyRows(tail: string, end: number): unknown[] {
  const trimmed = trimSpaceGo(tail.slice(0, end))
  const node = parseJsonPrefix(trimmed)
  if (node === null || node.kind !== 'array') return []
  return (node.items ?? []).map((item) => rawJson(trimmed.slice(item.start, item.end)))
}

/**
 * 合并多个含 `translations` 的对象（Go `mergeTranslationObjects`）。
 *
 * 仅 0/1 个对象时返回空串（无需合并）。输出为 Go `json.Marshal` 形态。
 */
export function mergeTranslationObjects(text: string): string {
  const merged: Record<string, string> = {}
  let firstObj: Record<string, unknown> | null = null
  let pos = 0
  let count = 0
  while (pos < text.length) {
    const off = text.slice(pos).indexOf('{')
    if (off < 0) break
    const start = pos + off
    const end = matchBracePair(text, start)
    if (end < 0) break
    const body = text.slice(start, end + 1)
    pos = end + 1
    if (!body.includes('"translations"')) continue
    let raw: Record<string, unknown>
    try {
      raw = unmarshalGeneric(body)
    } catch {
      continue
    }
    const translations = raw['translations']
    if (!isPlainObject(translations)) continue
    count++
    for (const [key, value] of Object.entries(translations)) {
      if (typeof value !== 'string') continue
      if (!Object.prototype.hasOwnProperty.call(merged, key)) {
        merged[key] = value
      }
    }
    if (firstObj === null) firstObj = raw
  }
  if (count < 2 || firstObj === null) return ''
  const out: Record<string, unknown> = { ...firstObj }
  const transMap: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(merged)) {
    transMap[key] = value
  }
  out['translations'] = transMap
  return marshalGo(out)
}
