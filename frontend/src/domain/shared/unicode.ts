/**
 * Unicode 语义对齐工具集。
 *
 * Go 与 JS 的字符串语义差异集中在此文件处理：
 *
 * - Go 的 `for _, r := range s` 迭代的是 **Unicode 码点（rune）**，不是 UTF-8 字节，
 *   也不是 JS 的 UTF-16 code unit。本文件提供 `codePoints()` 作为唯一码点迭代入口。
 * - Go 的 `len(s)` 是 UTF-8 **字节数**，`utf8.RuneCountInString(s)` 才是码点数。
 *   本文件同时提供 `utf8Length()` 与 `runeCount()`，避免移植时混用。
 * - Go `unicode.IsLetter` / `IsDigit` / `IsSpace` 的判定集合与 JS 的
 *   `\p{L}` / `\p{Nd}` / `\s` **并不完全相同**（见各函数注释），必须显式实现。
 *
 * 本模块为纯函数，零 DOM / 零网络 / 零 IO 依赖。
 */

/** Go `unicode.IsLetter` 对应的 Unicode 类别：General_Category = L（Lu/Ll/Lt/Lm/Lo）。 */
const LETTER_RE = /\p{L}/u

/** Go `unicode.IsDigit` 对应的 Unicode 类别：General_Category = Nd（十进制数字）。 */
const DIGIT_RE = /\p{Nd}/u

/**
 * Go `unicode.Han` —— CJK 统一表意文字（含扩展 A/B/C… 与兼容区）。
 * 与 JS `\p{Script=Han}` 的差异仅在极冷门码位，测试向量已覆盖常用区段。
 */
const HAN_RE = /\p{Script=Han}/u

/** Go `unicode.Hiragana`。 */
const HIRAGANA_RE = /\p{Script=Hiragana}/u

/** Go `unicode.Katakana`。 */
const KATAKANA_RE = /\p{Script=Katakana}/u

/** Go `unicode.Hangul`。 */
const HANGUL_RE = /\p{Script=Hangul}/u

/**
 * Go `unicode.IsSpace` 的精确集合。
 *
 * Go 的定义是「Latin-1 快速路径 + White_Space 属性」：
 *
 *   - U+0009..U+000D（\t \n \v \f \r）
 *   - U+0020（空格）
 *   - U+0085（NEL）
 *   - U+00A0（NBSP）
 *   - U+1680、U+2000..U+200A、U+2028、U+2029、U+202F、U+205F、U+3000
 *
 * **与 JS `\s` 的差异**：JS 的 `\s` 额外包含 U+FEFF（BOM），且包含 U+000B；
 * Go 同样包含 U+000B，但 **不** 包含 U+FEFF。移植时不得直接用 `\s`。
 */
function isGoSpace(cp: number): boolean {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0b || cp === 0x0c || cp === 0x0d) return true
  if (cp === 0x20 || cp === 0x85 || cp === 0xa0) return true
  if (cp === 0x1680) return true
  if (cp >= 0x2000 && cp <= 0x200a) return true
  if (cp === 0x2028 || cp === 0x2029 || cp === 0x202f || cp === 0x205f || cp === 0x3000) return true
  return false
}

/** 判断码点是否为 Go `unicode.IsLetter`（General_Category = L）。 */
export function isLetter(cp: number): boolean {
  return LETTER_RE.test(String.fromCodePoint(cp))
}

/** 判断码点是否为 Go `unicode.IsDigit`（General_Category = Nd）。 */
export function isDigit(cp: number): boolean {
  return DIGIT_RE.test(String.fromCodePoint(cp))
}

/** 判断码点是否为 Go `unicode.IsSpace`（White_Space 属性，见 isGoSpace 注释）。 */
export function isSpace(cp: number): boolean {
  return isGoSpace(cp)
}

/** 判断码点是否为 CJK（Go `unicode.Han` / `Hiragana` / `Katakana` / `Hangul`）。 */
export function isCJK(cp: number): boolean {
  const ch = String.fromCodePoint(cp)
  return HAN_RE.test(ch) || HIRAGANA_RE.test(ch) || KATAKANA_RE.test(ch) || HANGUL_RE.test(ch)
}

/**
 * 迭代字符串的 Unicode 码点，语义等同 Go 的 `for _, r := range s`。
 *
 * 注意：JS 的 `for...of` 字符串迭代本身就按码点迭代（代理对合并为单个码点），
 * 故 `Array.from(text)` 即等价于 Go 的 `[]rune(text)`。此处显式封装以固定契约，
 * 避免调用方误用 `text.split('')`（会拆散代理对）或 `text.length`（UTF-16 长度）。
 */
export function codePoints(text: string): number[] {
  return Array.from(text, (ch) => ch.codePointAt(0) ?? 0)
}

/** 码点数量，等价 Go `utf8.RuneCountInString(s)`。 */
export function runeCount(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i) ?? 0
    if (cp > 0xffff) i++
    n++
  }
  return n
}

/** UTF-8 字节长度，等价 Go `len(s)`。 */
export function utf8Length(text: string): number {
  return utf8Encode(text).length
}

/**
 * 按码点切片，等价 Go `string([]rune(s)[:n])`。
 *
 * `end` 缺省时切到末尾；超出范围时按 Go 的切片语义截断。
 */
export function sliceRunes(text: string, start: number, end?: number): string {
  const cps = codePoints(text)
  const from = Math.max(0, Math.min(start, cps.length))
  const to = end === undefined ? cps.length : Math.max(from, Math.min(end, cps.length))
  return cps
    .slice(from, to)
    .map((cp) => String.fromCodePoint(cp))
    .join('')
}

/**
 * 纯 TypeScript 的 UTF-8 编码器（等价 Go `[]byte(s)`）。
 *
 * 刻意不依赖 `TextEncoder`：领域层要求零平台依赖，且本函数需要被
 * `hash.ts` 的字节级一致性测试直接验证。
 *
 * 行为与 Go 一致：非法代理项按 Go 的 WTF-8 规则编码为 U+FFFD。
 */
export function utf8Encode(text: string): Uint8Array {
  const out: number[] = []
  for (const ch of text) {
    let cp = ch.codePointAt(0) ?? 0
    // 孤立代理项在 Go 侧经 JSON 往返后会被替换为 U+FFFD，此处保持一致。
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd
    if (cp < 0x80) {
      out.push(cp)
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      )
    }
  }
  return Uint8Array.from(out)
}
