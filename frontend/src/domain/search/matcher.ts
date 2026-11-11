/**
 * 段落文本匹配器（对应 Go `backend/internal/service/segmatch`）。
 *
 * ## 与 Go 的语义对齐要点
 *
 * 1. **大小写不敏感用 SimpleFold 折叠环**，不是 JS 的 `toLowerCase()`：
 *    Go 用 `unicode.SimpleFold` 折叠环的**最小代表元**做归一，
 *    两个码点折叠等价当且仅当代表元相同。代表元表由 `fold-table.ts` 提供
 *    （从 Go 标准库导出），因此 İ / ſ / ß / K(Kelvin) / µ 等处与 Go 完全一致。
 * 2. **KMP 单趟匹配**：折叠后的 pattern 预计算失配函数，扫描严格 O(n+m)，
 *    避免长文档下的 O(n·m) 退化。
 * 3. **整词边界**：`isWholeWord` 用 `unicode.IsLetter || unicode.IsDigit`
 *    （即 `\p{L}` / `\p{Nd}`），与 Go 的 `isWordRune` 一致。
 * 4. **正则用 RE2**（`domain/shared/re2.ts` 的 `compile`），线性时间、无回溯。
 *    整词时用 `(?:\A|[^\p{L}\p{Nd}])(?:PATTERN)(?:\z|[^\p{L}\p{Nd}])` 做**必要条件预筛**，
 *    预筛命中仍以 `find` 为准（Go 的 `boundary` 预筛语义）。
 * 5. **偏移单位**：Go 是 UTF-8 字节偏移；本移植统一为**码点偏移**
 *    （见 `types.ts`）。切片坐标系内截出的子串与 Go 一致。
 */
import { compile } from '../shared/re2'
import { codePoints, isDigit, isLetter } from '../shared/unicode'
import { foldRepresentative } from './fold-table'
import {
  MAX_PATTERN_RUNES,
  SEARCH_ERROR_INVALID_PATTERN,
  SEARCH_ERROR_PATTERN_TOO_LONG,
  SEARCH_ERROR_UNSUPPORTED_MODE,
  SearchError,
  type SearchMatch,
  type SearchMatcher,
  type SearchOptions,
} from './types'

/** 折叠归一：把码点序列映射为折叠环代表元序列（长度不变，1:1）。 */
function foldRunes(codepoints: readonly number[]): number[] {
  return codepoints.map((cp) => foldRepresentative(cp))
}

/** KMP 失配函数：`fail[i]` 是 `pat[:i+1]` 的最长真前缀且同时为后缀的长度。 */
function kmpFailure(pattern: readonly number[]): number[] {
  const fail = Array.from({ length: pattern.length }, () => 0)
  let k = 0
  for (let i = 1; i < pattern.length; i++) {
    while (k > 0 && pattern[k] !== pattern[i]) {
      k = fail[k - 1] as number
    }
    if (pattern[k] === pattern[i]) {
      k++
    }
    fail[i] = k
  }
  return fail
}

/** 整词边界判定：命中前后不得紧邻字母或十进制数字。 */
function isWholeWord(codepoints: readonly number[], start: number, end: number): boolean {
  if (start > 0) {
    const previous = codepoints[start - 1] as number
    if (isLetter(previous) || isDigit(previous)) return false
  }
  if (end < codepoints.length) {
    const next = codepoints[end] as number
    if (isLetter(next) || isDigit(next)) return false
  }
  return true
}

/** 子串匹配器。 */
class SubstringMatcher implements SearchMatcher {
  /** 待查找的字面量（避免与 `find(text)` 方法同名）。 */
  private readonly needle: string
  private readonly caseSensitive: boolean
  private readonly wholeWord: boolean
  /** 折叠后的 pattern（大小写不敏感时使用）。 */
  private readonly folded: number[]
  /** KMP 失配函数。 */
  private readonly fail: number[]
  /** pattern 的码点数。 */
  private readonly patternLen: number

  constructor(options: SearchOptions) {
    this.needle = options.find
    this.caseSensitive = options.caseSensitive ?? true
    this.wholeWord = options.wholeWord ?? false
    const pattern = codePoints(options.find)
    this.patternLen = pattern.length
    this.folded = this.caseSensitive ? [] : foldRunes(pattern)
    this.fail = this.caseSensitive ? [] : kmpFailure(this.folded)
  }

  find(text: string): SearchMatch[] {
    if (this.needle === '') return []
    const codepoints = codePoints(text)
    if (codepoints.length < this.patternLen) return []
    return this.caseSensitive
      ? this.findCaseSensitive(codepoints)
      : this.findCaseInsensitive(codepoints)
  }

  hasMatch(text: string): boolean {
    if (this.needle === '') return false
    const codepoints = codePoints(text)
    if (codepoints.length < this.patternLen) return false
    const first = this.caseSensitive
      ? this.nextCaseSensitive(codepoints, 0)
      : this.nextCaseInsensitive(codepoints)
    return first !== null
  }

  replaceAll(text: string, replaceWith: string): { text: string; count: number } {
    const matches = this.find(text)
    if (matches.length === 0) return { text, count: 0 }
    const codepoints = codePoints(text)
    let out = ''
    let last = 0
    for (const match of matches) {
      out += codepoints
        .slice(last, match.start)
        .map((cp) => String.fromCodePoint(cp))
        .join('')
      out += replaceWith
      last = match.end
    }
    out += codepoints
      .slice(last)
      .map((cp) => String.fromCodePoint(cp))
      .join('')
    return { text: out, count: matches.length }
  }

  candidateLiteral(): string {
    return this.caseSensitive ? this.needle : ''
  }

  /** 大小写敏感：左最先、非重叠；整词被拒时起点前进一个码点。 */
  private findCaseSensitive(codepoints: readonly number[]): SearchMatch[] {
    const pattern = codePoints(this.needle)
    const matches: SearchMatch[] = []
    let searchStart = 0
    while (searchStart <= codepoints.length) {
      const relative = indexOfSequence(codepoints, pattern, searchStart)
      if (relative < 0) break
      const start = relative
      const end = start + pattern.length
      if (!this.wholeWord || isWholeWord(codepoints, start, end)) {
        matches.push({ start, end })
        searchStart = end
        continue
      }
      // 被拒的候选可能与后续有效候选重叠：起点只前进一个码点。
      searchStart = start + 1
    }
    return matches
  }

  /** 大小写敏感：找出下一个命中的位置。 */
  private nextCaseSensitive(codepoints: readonly number[], from: number): SearchMatch | null {
    const pattern = codePoints(this.needle)
    const relative = indexOfSequence(codepoints, pattern, from)
    if (relative < 0) return null
    const end = relative + pattern.length
    if (this.wholeWord && !isWholeWord(codepoints, relative, end)) return null
    return { start: relative, end }
  }

  /** 大小写不敏感：在折叠序列上跑 KMP。 */
  private findCaseInsensitive(codepoints: readonly number[]): SearchMatch[] {
    const matches: SearchMatch[] = []
    const foldedText = foldRunes(codepoints)
    const pattern = this.folded
    const patternLen = this.patternLen
    const fail = this.fail
    // 环形缓冲：记录每个已消费码点的起始序号（用于把命中起点映射回原文）。
    const startRing = Array.from({ length: patternLen }, () => 0)
    let q = 0
    for (let seq = 0; seq < foldedText.length; seq++) {
      const folded = foldedText[seq] as number
      while (q > 0 && pattern[q] !== folded) {
        q = fail[q - 1] as number
      }
      if (pattern[q] !== folded) continue
      startRing[seq % patternLen] = seq
      q++
      if (q < patternLen) continue
      const startSeq = startRing[(seq - patternLen + 1) % patternLen] as number
      const start = startSeq
      const end = seq + 1
      if (!this.wholeWord || isWholeWord(codepoints, start, end)) {
        matches.push({ start, end })
        q = 0
        continue
      }
      // 整词拒绝：按标准 KMP 回退继续寻找重叠候选。
      q = fail[patternLen - 1] as number
    }
    return matches
  }

  /** 大小写不敏感：找出下一个命中的位置。 */
  private nextCaseInsensitive(codepoints: readonly number[]): SearchMatch | null {
    const foldedText = foldRunes(codepoints)
    const pattern = this.folded
    const patternLen = this.patternLen
    const fail = this.fail
    const startRing = Array.from({ length: patternLen }, () => 0)
    let q = 0
    for (let seq = 0; seq < foldedText.length; seq++) {
      const folded = foldedText[seq] as number
      while (q > 0 && pattern[q] !== folded) {
        q = fail[q - 1] as number
      }
      if (pattern[q] !== folded) continue
      startRing[seq % patternLen] = seq
      q++
      if (q < patternLen) continue
      const start = startRing[(seq - patternLen + 1) % patternLen] as number
      const end = seq + 1
      if (this.wholeWord && !isWholeWord(codepoints, start, end)) {
        q = fail[patternLen - 1] as number
        continue
      }
      return { start, end }
    }
    return null
  }
}

/** 在码点序列中查找子序列（返回绝对起点，未找到返回 -1）。 */
function indexOfSequence(
  haystack: readonly number[],
  needle: readonly number[],
  from: number,
): number {
  if (needle.length === 0) return from
  const limit = haystack.length - needle.length
  outer: for (let i = from; i <= limit; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

/** 正则匹配器。 */
class RegexMatcher implements SearchMatcher {
  private readonly re: ReturnType<typeof compile>
  private readonly wholeWord: boolean
  private readonly candidate: string
  /** 整词预筛正则（可能编译失败 → null）。 */
  private readonly boundary: ReturnType<typeof compile> | null

  constructor(options: SearchOptions, pattern: string, flags: string) {
    const compiled = compile(`${flags}${pattern}`)
    this.re = compiled
    this.wholeWord = options.wholeWord ?? false
    this.candidate = options.caseSensitive === false ? '' : literalPrefix(pattern)
    this.boundary = this.wholeWord
      ? safeCompile(`${flags}(?:\\A|[^\\p{L}\\p{Nd}])(?:${pattern})(?:\\z|[^\\p{L}\\p{Nd}])`)
      : null
  }

  find(text: string): SearchMatch[] {
    const codepoints = codePoints(text)
    const out: SearchMatch[] = []
    for (const [start, end] of this.matchRanges(text)) {
      if (this.wholeWord && !isWholeWord(codepoints, start, end)) continue
      out.push({ start, end })
    }
    return out
  }

  hasMatch(text: string): boolean {
    if (!this.wholeWord) {
      return this.re.test(text)
    }
    if (this.boundary && !this.boundary.test(text)) {
      return false
    }
    return this.matchRanges(text).length > 0
  }

  replaceAll(text: string, replaceWith: string): { text: string; count: number } {
    const matches = this.matchAll(text)
    const codepoints = codePoints(text)
    const filtered = matches.filter(
      (m) => !this.wholeWord || isWholeWord(codepoints, m.start, m.end),
    )
    if (filtered.length === 0) return { text, count: 0 }
    let out = ''
    let last = 0
    for (const match of filtered) {
      out += codepoints
        .slice(last, match.start)
        .map((cp) => String.fromCodePoint(cp))
        .join('')
      out += expandReplacement(replaceWith, match)
      last = match.end
    }
    out += codepoints
      .slice(last)
      .map((cp) => String.fromCodePoint(cp))
      .join('')
    return { text: out, count: filtered.length }
  }

  candidateLiteral(): string {
    return this.candidate
  }

  /** 全部非重叠匹配（含捕获组文本）。 */
  private matchAll(text: string): RegexMatch[] {
    const matcher = this.re.matcher(text)
    const out: RegexMatch[] = []
    while (matcher.find()) {
      const numbered: Record<number, string> = {}
      for (let g = 1; g <= matcher.groupCount(); g++) {
        const value = matcher.group(g)
        if (value !== null && value !== undefined) {
          numbered[g] = value
        }
      }
      const namedRaw = matcher.getNamedGroups() as Record<string, string> | undefined
      out.push({
        start: matcher.start(0),
        end: matcher.end(0),
        numbered,
        named: namedRaw ?? {},
      })
    }
    return out
  }

  /** 全部非重叠匹配的 [start, end) 码点区间（基于**完整字符串**，锚点语义与 Go 一致）。 */
  private matchRanges(text: string): Array<[number, number]> {
    return this.matchAll(text).map((m) => [m.start, m.end] as [number, number])
  }
}

/** 一次正则匹配（含捕获组）。 */
interface RegexMatch {
  start: number
  end: number
  numbered: Record<number, string>
  named: Record<string, string>
}

/** 安全编译（失败返回 null）。 */
function safeCompile(pattern: string): ReturnType<typeof compile> | null {
  try {
    return compile(pattern)
  } catch {
    return null
  }
}

/**
 * 计算正则的**字面前缀**（对应 Go `regexp.LiteralPrefix`）。
 *
 * Go 的规则：编译后的程序若以单个 rune 的指令开头，该 rune 即字面前缀；
 * 因此分组（含捕获组与非捕获组）会**下钻**取其首字面量，
 * 而分支（`|`）、字符类、量词与锚点会中断前缀。
 */
export function literalPrefix(pattern: string): string {
  let i = 0
  // 跳过行首的 inline flag 组（`(?i)` 等）：它们不产生字面量。
  const flagGroup = /^\(\?[imsU-]+\)/.exec(pattern)
  if (flagGroup) {
    i = flagGroup[0].length
  }
  let out = ''
  while (i < pattern.length) {
    const ch = pattern[i] as string
    if (ch === '\\') {
      const next = pattern[i + 1]
      if (next === undefined) break
      // 转义标点 → 字面量；转义字母（\d \w \s \b …）→ 类别，非字面量。
      if (/[A-Za-z]/.test(next)) break
      out += next
      i += 2
      continue
    }
    if (ch === '(') {
      // 下钻进分组（非捕获 / 捕获 / 命名捕获）。
      const rest = pattern.slice(i)
      const group = /^\((?:\?(?:P<[^>]+>|P=[^)]+)|:|!)?/.exec(rest)
      if (!group) break
      const inner = rest.slice(group[0].length)
      const close = matchParen(inner)
      if (close < 0) break
      const prefix = literalPrefix(inner.slice(0, close))
      if (prefix === '') break
      // 分组内部若不是纯字面量，其后缀不可知 → 前缀到此为止。
      const consumed = group[0].length + close + 1
      if (consumed < pattern.length) {
        const after = pattern[consumed]
        if (after !== undefined && !'[|)'.includes(after)) {
          // 组后还有内容且不是量词：Go 的编译结果不保证组以字面量开头。
          break
        }
      }
      out += prefix
      i = consumed
      continue
    }
    if ('.[]{}*+?|^$'.includes(ch)) break
    out += ch
    i++
  }
  return out
}

/** 找到与 `(` 配对的 `)` 下标（跳过转义与字符类）。 */
function matchParen(text: string): number {
  let depth = 0
  let inClass = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    if (ch === '\\') {
      i++
      continue
    }
    if (inClass) {
      if (ch === ']') inClass = false
      continue
    }
    if (ch === '[') {
      inClass = true
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * 展开替换串中的捕获组引用（对应 Go `Regexp.ExpandString`）。
 *
 * 支持 `$$`（字面 `$`）、`$N`（第 N 个捕获组）、`${name}`（命名捕获组）。
 */
function expandReplacement(replaceWith: string, match: RegexMatch): string {
  if (!replaceWith.includes('$')) return replaceWith
  let out = ''
  for (let i = 0; i < replaceWith.length; i++) {
    const ch = replaceWith[i] as string
    if (ch !== '$') {
      out += ch
      continue
    }
    const next = replaceWith[i + 1]
    if (next === '$') {
      out += '$'
      i++
      continue
    }
    if (next === '{') {
      const close = replaceWith.indexOf('}', i + 2)
      if (close > 0) {
        const name = replaceWith.slice(i + 2, close)
        out += match.named[name] ?? ''
        i = close
        continue
      }
    }
    if (next !== undefined && /[0-9]/.test(next)) {
      let j = i + 1
      let digits = ''
      while (j < replaceWith.length && /[0-9]/.test(replaceWith[j] as string)) {
        digits += replaceWith[j]
        j++
      }
      out += match.numbered[Number(digits)] ?? ''
      i = j - 1
      continue
    }
    out += ch
  }
  return out
}

/**
 * 构造匹配器。
 *
 * @throws SearchError 模式过长 / 正则非法 / 匹配模式不支持
 */
export function createSearchMatcher(options: SearchOptions): SearchMatcher {
  const pattern = options.find
  if (codePoints(pattern).length > MAX_PATTERN_RUNES) {
    throw new SearchError(
      SEARCH_ERROR_PATTERN_TOO_LONG,
      `pattern too long: ${codePoints(pattern).length} runes, max ${MAX_PATTERN_RUNES}`,
    )
  }
  const matchMode = options.matchMode ?? 'substring'
  switch (matchMode) {
    case 'substring':
      return new SubstringMatcher(options)
    case 'regex': {
      const caseSensitive = options.caseSensitive ?? true
      const flags = caseSensitive ? '' : '(?i)'
      try {
        return new RegexMatcher(options, pattern, flags)
      } catch (error) {
        throw new SearchError(
          SEARCH_ERROR_INVALID_PATTERN,
          `invalid regex pattern: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    default:
      throw new SearchError(
        SEARCH_ERROR_UNSUPPORTED_MODE,
        `unsupported match mode: ${String(matchMode)}`,
      )
  }
}
