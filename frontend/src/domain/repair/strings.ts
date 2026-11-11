/**
 * Go 字符串语义的精确移植（仅本包用到的那部分）。
 *
 * 为什么不能直接用 JS 内建：
 *
 * - `strings.TrimSpace` 使用 `unicode.IsSpace`，**不含** U+FEFF，而 JS `.trim()`
 *   含 U+FEFF；
 * - `strings.EqualFold` 是 Unicode simple-fold，JS `toLowerCase()` 在个别码位
 *   （İ、ß 等）长度会变；
 * - `strings.SplitN(s, sep, 3)` 只切前 N-1 个分隔符；
 * - Go 的 `s[:n]` 是 **UTF-8 字节切片**，可能切断多字节 rune。
 *
 * 本模块为纯函数，零平台依赖。
 */
import { codePoints, isSpace, utf8Encode } from '../shared/unicode'

/** 字节切片结果：可能包含非法 UTF-8。 */
export type ByteSlice = Uint8Array

/** 取首个 rune（码点）字符串；空串返回空串（Go `utf8.DecodeRuneInString` 近似）。 */
export function firstRune(text: string): string {
  const cp = text.codePointAt(0)
  return cp === undefined ? '' : String.fromCodePoint(cp)
}

/**
 * 等价 Go `strings.TrimSpace`：去除首尾 `unicode.IsSpace` 码点。
 *
 * 逐码点判定，不使用 JS `.trim()`（后者多含 U+FEFF，且不区分 Go 的集合）。
 */
export function trimSpaceGo(text: string): string {
  const cps = codePoints(text)
  let start = 0
  let end = cps.length
  while (start < end && isSpace(cps[start] as number)) start++
  while (end > start && isSpace(cps[end - 1] as number)) end--
  return cps
    .slice(start, end)
    .map((cp) => String.fromCodePoint(cp))
    .join('')
}

/** 等价 Go `strings.HasPrefix`。 */
export function hasPrefix(text: string, prefix: string): boolean {
  return text.startsWith(prefix)
}

/** 等价 Go `strings.HasSuffix`。 */
export function hasSuffix(text: string, suffix: string): boolean {
  return text.endsWith(suffix)
}

/** 等价 Go `strings.Contains`。 */
export function contains(text: string, substr: string): boolean {
  return text.includes(substr)
}

/** 等价 Go `strings.IndexByte(s, b)`（b 为 ASCII）。 */
export function indexByte(text: string, byte: string): number {
  return text.indexOf(byte)
}

/** 等价 Go `strings.LastIndex`。 */
export function lastIndex(text: string, substr: string): number {
  return text.lastIndexOf(substr)
}

/**
 * 等价 Go `strings.EqualFold`。
 *
 * 目标字面量全是 ASCII（`[glossary]` / `[ruby]` / `[issues]` / `[revisions]` /
 * `[verdicts]`），因此只需对 ASCII 字母做大小写折叠；非 ASCII 字符一律视为
 * 不相等（Go 的 simple-fold 对 `ſ`→`s` 等等价在本领域不可达）。
 */
export function equalFoldAscii(text: string, target: string): boolean {
  if (text.length !== target.length) return false
  for (let i = 0; i < text.length; i++) {
    const a = text.charCodeAt(i)
    const b = target.charCodeAt(i)
    if (a === b) continue
    const fa = a >= 0x41 && a <= 0x5a ? a + 0x20 : a
    const fb = b >= 0x41 && b <= 0x5a ? b + 0x20 : b
    if (fa !== fb) return false
  }
  return true
}

/**
 * 等价 Go `strings.SplitN(s, sep, n)`。
 *
 * 当 `n <= 1` 时返回 `[s]`；当剩余部分不再含分隔符时原样保留。
 */
export function splitN(text: string, sep: string, n: number): string[] {
  if (n <= 1) return [text]
  const out: string[] = []
  let rest = text
  for (let i = 0; i < n - 1; i++) {
    const idx = rest.indexOf(sep)
    if (idx < 0) break
    out.push(rest.slice(0, idx))
    rest = rest.slice(idx + sep.length)
  }
  out.push(rest)
  return out
}

/** 等价 Go `strings.Split(s, sep)`。 */
export function splitString(text: string, sep: string): string[] {
  return text.split(sep)
}

/** 等价 Go `strings.Join`。 */
export function joinStrings(values: readonly string[], sep: string): string {
  return values.join(sep)
}

/** 等价 Go `strings.Repeat`。 */
export function repeatString(text: string, count: number): string {
  if (count <= 0) return ''
  return text.repeat(count)
}

/**
 * 按 UTF-8 字节切片，等价 Go `s[start:end]`。
 *
 * 返回值可能落在 rune 中间；调用方若需要字符串必须经 `decodeUtf8Lossy`
 * 还原（Go 的 `string` 可以携带非法 UTF-8，JS 字符串不行）。
 */
export function sliceUtf8Bytes(text: string, start: number, end?: number): ByteSlice {
  const bytes = utf8Encode(text)
  const from = Math.max(0, Math.min(start, bytes.length))
  const to = end === undefined ? bytes.length : Math.max(from, Math.min(end, bytes.length))
  return bytes.slice(from, to)
}

/**
 * 把可能含非法 UTF-8 的字节按 Go `string([]byte)` 的语义解码为 JS 字符串。
 *
 * Go 的 `string` 允许非法字节，但 `encoding/json` 在序列化时把它们替换为
 * U+FFFD；因此黄金向量里的可观察输出等价于「按 U+FFFD 替换非法序列」。
 */
export function decodeUtf8Lossy(bytes: ByteSlice): string {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const b0 = bytes[i] as number
    if (b0 < 0x80) {
      out += String.fromCharCode(b0)
      i++
      continue
    }
    let need = 0
    let cp = 0
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      need = 1
      cp = b0 & 0x1f
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      need = 2
      cp = b0 & 0x0f
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      need = 3
      cp = b0 & 0x07
    } else {
      out += '\uFFFD'
      i++
      continue
    }
    if (i + need >= bytes.length) {
      out += '\uFFFD'
      break
    }
    let ok = true
    for (let k = 1; k <= need; k++) {
      const bk = bytes[i + k] as number
      if ((bk & 0xc0) !== 0x80) {
        ok = false
        break
      }
      cp = (cp << 6) | (bk & 0x3f)
    }
    if (!ok) {
      out += '\uFFFD'
      i++
      continue
    }
    out += String.fromCodePoint(cp)
    i += need + 1
  }
  return out
}

/** 等价 Go `fmt.Sprintf("%06d", n)`（仅用于占位符）。 */
export function padZero6(n: number): string {
  return String(n).padStart(6, '0')
}
