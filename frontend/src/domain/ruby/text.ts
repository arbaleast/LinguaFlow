/**
 * ruby 包内部的文本工具：Go 语义的 TrimSpace 与 HTML 转义。
 */
import { isSpace } from '../shared/unicode'

/** Go `strings.TrimSpace`（unicode.IsSpace；**不**包含 JS `trim()` 的 U+FEFF）。 */
export function trimSpace(s: string): string {
  const runes = Array.from(s)
  let start = 0
  let end = runes.length
  while (start < end && isSpace(runes[start]!.codePointAt(0) ?? 0)) start++
  while (end > start && isSpace(runes[end - 1]!.codePointAt(0) ?? 0)) end--
  return runes.slice(start, end).join('')
}

/**
 * Go `html.EscapeString`：`&`→`&amp;`、`'`→`&#39;`、`<`→`&lt;`、`>`→`&gt;`、
 * `"`→`&#34;`。
 */
export function htmlEscapeString(s: string): string {
  let out = ''
  for (const ch of s) {
    switch (ch) {
      case '&':
        out += '&amp;'
        break
      case "'":
        out += '&#39;'
        break
      case '<':
        out += '&lt;'
        break
      case '>':
        out += '&gt;'
        break
      case '"':
        out += '&#34;'
        break
      default:
        out += ch
    }
  }
  return out
}

/**
 * 判定字符串是否可能包含孤立代理项（等价 Go 的「非法 UTF-8」输入）。
 *
 * JS 字符串本身总是「合法 UTF-16」，但孤立代理项在编码为 UTF-8 时会被 Go 视为
 * 非法字节序列；领域层据此显式拒绝，而不是静默替换为 U+FFFD。
 */
export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true
    }
  }
  return false
}
