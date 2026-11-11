/**
 * Span 定位原语（对应 Go `qa.go` 的 `LocateSpan` / `equalFoldSpan` / `utf8RuneOffset`）。
 *
 * **偏移口径（关键）**：Go 的 `strings.Index` 返回 **UTF-8 字节**下标，而 `Span`
 * 对外暴露的 `TargetStart` / `TargetEnd` 是 **rune（码点）偏移**——由
 * `utf8RuneOffset` + `utf8.RuneCountInString` 当场换算。因此：
 *
 * - `strings.Index`        → `String.prototype.indexOf`（UTF-16 code unit，边界等价）
 * - `utf8RuneOffset(s, b)` → `runeCount(s.slice(0, b))`
 * - `utf8.RuneCountInString(s[a:b])` → `runeCount(s.slice(a, b))`
 *
 * 三种坐标系在**码点边界**上互相等价，故换算结果与 Go 逐字节一致；
 * Emoji 代理对与增补平面汉字（如 U+2003E）都不会被拆开。
 */
import { trimSpace } from '../ruby'
import { codePoints, runeCount } from '../shared/unicode'
import type { Span } from './types'

/**
 * Unicode 简单大小写折叠（Go `unicode.SimpleFold`）的等价轨道。
 *
 * 为什么不能只用 `toLowerCase()`：Go 的 `strings.EqualFold` 走 SimpleFold 轨道，
 * 与「单字符小写映射」并不等价——例如长 s（ſ）的小写仍是自身，但在 Go 里与 `s`/`S`
 * 同轨；微符号（µ）的小写仍是自身，但轨道包含希腊字母 Μ/μ。这里显式固化这些轨道，
 * 其余字符退回逐码点单字符小写。
 */
const FOLD_GROUPS: readonly string[] = [
  'Kk\u212a', // K k KELVIN SIGN
  'Ss\u017f', // S s LATIN SMALL LETTER LONG S
  '\u00c5\u00e5\u212b', // Å å ANGSTROM SIGN
  '\u03a9\u03c9\u2126', // Ω ω OHM SIGN
  '\u039c\u03bc\u00b5', // Μ μ MICRO SIGN
  '\u03a3\u03c3\u03c2', // Σ σ ς
  '\u0392\u03b2\u03d0', // Β β GREEK BETA SYMBOL
  '\u0395\u03b5\u03f5', // Ε ε GREEK LUNATE EPSILON SYMBOL
  '\u0398\u03b8\u03d1', // Θ θ GREEK THETA SYMBOL
  '\u03a6\u03c6\u03d5', // Φ φ GREEK PHI SYMBOL
  '\u03a0\u03c0\u03d6', // Π π GREEK PI SYMBOL
  '\u03a1\u03c1\u03f1', // Ρ ρ GREEK RHO SYMBOL
  '\u03a5\u03c5\u03d2', // Υ υ GREEK UPSILON WITH HOOK SYMBOL
  '\u00df\u1e9e', // ß ẞ
]

/** 码点 → 折叠轨道代表码点。 */
const FOLD_ORBIT = new Map<number, number>()
for (const group of FOLD_GROUPS) {
  const cps = codePoints(group)
  const rep = cps[0] ?? 0
  for (const cp of cps) {
    FOLD_ORBIT.set(cp, rep)
  }
}

/** 单个码点的折叠键：轨道代表码点，否则取其单字符小写（已是 1:1 时）。 */
function foldKey(cp: number): number {
  const orbit = FOLD_ORBIT.get(cp)
  if (orbit !== undefined) return orbit
  const lower = String.fromCodePoint(cp).toLowerCase()
  if (runeCount(lower) === 1) {
    const lcp = lower.codePointAt(0) ?? cp
    if (lcp !== cp) {
      return FOLD_ORBIT.get(lcp) ?? lcp
    }
  }
  return cp
}

/**
 * 等价 Go `strings.EqualFold`（Unicode 简单大小写折叠）。
 *
 * 注意刻意**不**用 `toLowerCase()` 整体比较：`'ß'.toUpperCase()` 之类的全量映射
 * 会把 `ß` 与 `SS` 误判为相等，而 Go 的 SimpleFold 是逐码点 1:1 的。
 */
export function equalFold(a: string, b: string): boolean {
  const ra = codePoints(a)
  const rb = codePoints(b)
  if (ra.length !== rb.length) return false
  for (let i = 0; i < ra.length; i++) {
    if (foldKey(ra[i]!) !== foldKey(rb[i]!)) return false
  }
  return true
}

/**
 * 把 UTF-16 / 字节下标（码点边界上）换算为 rune 偏移（Go `utf8RuneOffset`）。
 *
 * `idx <= 0` 返回 0；`idx >= s.length` 返回全文 rune 数（Go 的两个短路分支）。
 */
export function runeOffset(s: string, idx: number): number {
  if (idx <= 0) return 0
  if (idx >= s.length) return runeCount(s)
  return runeCount(s.slice(0, idx))
}

/** 等宽折叠匹配的结果（相对 `target` 的 UTF-16 下标）。 */
interface FoldSpan {
  start: number
  end: number
}

/**
 * 在 `target` 的 **rune 边界**上做大小写不敏感的首个等长匹配（Go `equalFoldSpan`）。
 *
 * 为什么必须逐 rune 推进：大小写转换可能改变 UTF-8 字节长度（如 `Ⱥ`→`ⱥ`），
 * 只有按 rune 取窗口才能保证切片落在合法边界，且与 Go 的 `range` 起点一致。
 */
function equalFoldSpan(target: string, matchedText: string): FoldSpan | null {
  const matchedRunes = runeCount(matchedText)
  const runes = Array.from(target)
  // 每个 rune 的 UTF-16 起始偏移（末尾追加全文长度）
  const starts: number[] = []
  let off = 0
  for (const ch of runes) {
    starts.push(off)
    off += ch.length
  }
  starts.push(off)

  for (let i = 0; i < runes.length; i++) {
    const endIdx = i + matchedRunes
    if (endIdx >= starts.length) {
      // 剩余 rune 不足一个窗口：Go 侧 end >= len(target) → end=-1，后续起点同样不可能命中
      break
    }
    const start = starts[i]!
    const end = starts[endIdx]!
    if (equalFold(target.slice(start, end), matchedText)) {
      return { start, end }
    }
  }
  return null
}

/**
 * 在 `target` 中定位 `matchedText` 的首次出现，返回带 **rune 偏移**的 Span
 * （Go `LocateSpan`）。
 *
 * 定位失败时仍返回仅含 `matchedText` 的 Span（偏移为 null），保证 issue 不丢。
 * `matchedText` 前后空白先按 Go `strings.TrimSpace` 剥除；空串返回 `null`。
 */
export function locateSpan(target: string, matchedTextIn: string): Span | null {
  let matchedText = trimSpace(matchedTextIn)
  if (matchedText === '') {
    return null
  }
  const span: Span = { matchedText }
  let idx = target.indexOf(matchedText)
  let endIdx = idx < 0 ? -1 : idx + matchedText.length
  if (idx < 0) {
    // 大小写转换可能改变 UTF-8 字节长度，因此必须在原文 rune 边界上匹配。
    const fold = equalFoldSpan(target, matchedText)
    if (fold === null) {
      return span
    }
    idx = fold.start
    endIdx = fold.end
    matchedText = target.slice(idx, endIdx)
    span.matchedText = matchedText
  }
  const start = runeOffset(target, idx)
  const end = start + runeCount(target.slice(idx, endIdx))
  span.targetStart = start
  span.targetEnd = end
  return span
}

/**
 * 用「等值 / 大小写不敏感」匹配语义填充 `span` 的偏移（Go `locateSpanFull`）。
 *
 * 供 `LocateSpanExcludingRegions` 在保护区外定位失败时回退使用：宁可偏移不准，
 * 也不漏报。
 */
export function locateSpanFull(target: string, matchedTextIn: string, span: Span): Span {
  let matchedText = matchedTextIn
  let idx = target.indexOf(matchedText)
  let endIdx = idx < 0 ? -1 : idx + matchedText.length
  if (idx < 0) {
    const fold = equalFoldSpan(target, matchedText)
    if (fold === null) {
      return span
    }
    idx = fold.start
    endIdx = fold.end
    matchedText = target.slice(idx, endIdx)
    span.matchedText = matchedText
  }
  const start = runeOffset(target, idx)
  const end = start + runeCount(target.slice(idx, endIdx))
  span.targetStart = start
  span.targetEnd = end
  return span
}
