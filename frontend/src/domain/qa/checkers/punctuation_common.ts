/**
 * 标点类 checker 的共享原语（对应 Go `checker_punctuation_missing.go` 里的
 * `quoteRunes` / `parenRunes` / `countCategory` / `firstCategoryRune` /
 * `directionalQuotePairs`，以及 `checker_punctuation_wrap_loss.go` 的引号工具）。
 *
 * 全部按 **rune（码点）** 判定：`Set<number>` 存码点，遍历用 `for...of`。
 */

/** 有向开→闭引号映射（Go `directionalQuotePairs`）：不含对称的 ASCII `"`。 */
export const DIRECTIONAL_QUOTE_PAIRS: ReadonlyMap<number, number> = new Map([
  ['「'.codePointAt(0)!, '」'.codePointAt(0)!],
  ['『'.codePointAt(0)!, '』'.codePointAt(0)!],
  ['“'.codePointAt(0)!, '”'.codePointAt(0)!],
  ['‘'.codePointAt(0)!, '’'.codePointAt(0)!],
  ['«'.codePointAt(0)!, '»'.codePointAt(0)!],
])

/**
 * 引号类包裹标点 rune 超集（含 ASCII `"`；Go `quoteRunes`）。
 *
 * 类别内替换不报，故取各类引号并集：`「a」`→`“a”` 视为同类替换，不触发
 * `punctuation_missing`，失衡交给 `punctuation_pairing`。
 */
export const QUOTE_RUNES: ReadonlySet<number> = new Set(
  ['「', '」', '『', '』', '“', '”', '‘', '’', '«', '»', '"'].map((ch) => ch.codePointAt(0)!),
)

/** 括号类包裹标点 rune 超集（中/英/方/花括号与书名号；Go `parenRunes`）。 */
export const PAREN_RUNES: ReadonlySet<number> = new Set(
  ['（', '）', '(', ')', '【', '】', '[', ']', '{', '}', '《', '》', '〈', '〉'].map((ch) =>
    ch.codePointAt(0)!,
  ),
)

/** 统计 `text` 中属于 `set` 的 rune 出现次数（Go `countCategory`）。 */
export function countCategory(text: string, set: ReadonlySet<number>): number {
  let n = 0
  for (const ch of text) {
    if (set.has(ch.codePointAt(0) ?? 0)) {
      n++
    }
  }
  return n
}

/**
 * 返回 `src` 中属于 `set` 的第 `occurrence` 个（0 基）rune 字符串；不足返回空串
 * （Go `firstCategoryRune`）。
 */
export function firstCategoryRune(
  src: string,
  set: ReadonlySet<number>,
  occurrence: number,
): string {
  let seen = 0
  for (const ch of src) {
    if (set.has(ch.codePointAt(0) ?? 0)) {
      if (seen === occurrence) {
        return ch
      }
      seen++
    }
  }
  return ''
}

/** 返回 `s` 的首个 rune；空串返回 `null`（Go `firstRuneOf`）。 */
export function firstRuneOf(s: string): number | null {
  for (const ch of s) {
    return ch.codePointAt(0) ?? 0
  }
  return null
}

/** 返回 `s` 的末 rune；空串返回 `null`（Go `lastRuneOf`）。 */
export function lastRuneOf(s: string): number | null {
  let last: number | null = null
  for (const ch of s) {
    last = ch.codePointAt(0) ?? 0
  }
  return last
}

/** 返回 `s` 的 rune 数（Go `runeLenOf`）。 */
export function runeLenOf(s: string): number {
  let n = 0
  for (const _ch of s) n++
  return n
}

/** 判断 rune 是否引号类（Go `isQuoteRune`）。 */
export function isQuoteRune(r: number): boolean {
  return QUOTE_RUNES.has(r)
}

/**
 * 等价 Go `fmt.Sprintf("%q", s)` 的双引号字符串字面量（仅覆盖本包会用到的形态）。
 *
 * Go 的 `%q` 对可打印字符原样输出（含中文），对 `"` 与 `\` 转义；控制字符用
 * `\n` / `\t` / `\xNN` 等。本函数用于拼接 issue message，必须与 Go 逐字节一致。
 */
export function goQuote(s: string): string {
  let out = '"'
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    switch (cp) {
      case 0x07:
        out += '\\a'
        break
      case 0x08:
        out += '\\b'
        break
      case 0x09:
        out += '\\t'
        break
      case 0x0a:
        out += '\\n'
        break
      case 0x0b:
        out += '\\v'
        break
      case 0x0c:
        out += '\\f'
        break
      case 0x0d:
        out += '\\r'
        break
      case 0x22:
        out += '\\"'
        break
      case 0x5c:
        out += '\\\\'
        break
      default:
        if (cp < 0x20 || cp === 0x7f) {
          out += `\\x${cp.toString(16).padStart(2, '0')}`
        } else {
          out += ch
        }
    }
  }
  return `${out}"`
}

/** 由码点构造单字符字符串。 */
export function runeText(cp: number): string {
  return String.fromCodePoint(cp)
}
