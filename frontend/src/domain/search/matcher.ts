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
 *    避免长文档下的 O(n·m) 退化。命中后状态归 0；整词判定拒绝候选时状态回退到
 *    `fail[patternLen-1]`（保留重叠候选），与 Go `substringCursor` 逐行对应。
 * 3. **整词边界**：`isWordRune` 用 `unicode.IsLetter || unicode.IsDigit`
 *    （即 `\p{L}` / `\p{Nd}`），与 Go 的 `isWholeWord` 一致。
 * 4. **正则用 RE2**（`domain/shared/re2.ts` 的 `compile`），线性时间、无回溯。
 *    `FindAll` 迭代精确复刻 Go `regexp.allMatches`：**紧邻上一个匹配结束处的空匹配
 *    被拒绝**、空匹配按码点宽度推进、匹配起点只落在码点边界（Go 的 rune 边界）。
 *    整词时用 `(?:\A|[^\p{L}\p{Nd}])(?:PATTERN)(?:\z|[^\p{L}\p{Nd}])` 做**必要条件预筛**，
 *    预筛命中仍以实际 `find` 为准（Go 的 `boundary` 预筛语义）。
 * 5. **偏移单位**：Go 是 UTF-8 字节偏移；本移植统一为**码点偏移**
 *    （见 `types.ts`）。内部把 re2js 的 UTF-16 下标换算成码点下标后再对外。
 * 6. **替换展开**：正则替换串按 Go `Regexp.ExpandString` 的 `extract`/`expand`
 *    逐字符解析（`$$`、`$N`、`$name`、`${name}`），未参与匹配的组展开为空串；
 *    substring 的替换串是纯字面量，不做展开。
 * 7. **`candidateLiteral`**：大小写敏感的 substring 返回原文；大小写敏感的 regex
 *    返回编译后程序的首指令推导出的字面前缀（见 `literalPrefix`）；大小写不敏感
 *    一律返回空串。空串表示「无安全锚点」，调用方可退化为全量精筛。
 */
import { compile } from '../shared/re2'
import { codePoints, isDigit, isLetter, runeCount } from '../shared/unicode'
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

/** 折叠归一：码点 → SimpleFold 折叠环最小代表元（1:1，长度不变）。 */
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

/** Go `isWordRune`：字母或十进制数字（`\p{L}` / `\p{Nd}`）。 */
function isWordRune(cp: number): boolean {
  return isLetter(cp) || isDigit(cp)
}

/** 整词边界判定：命中前后不得紧邻字母或十进制数字。 */
function isWholeWord(codepoints: readonly number[], start: number, end: number): boolean {
  if (start > 0 && isWordRune(codepoints[start - 1] as number)) return false
  if (end < codepoints.length && isWordRune(codepoints[end] as number)) return false
  return true
}

/** 在码点序列中查找子序列（返回绝对起点，未找到返回 -1）。 */
function indexOfSequence(
  haystack: readonly number[],
  needle: readonly number[],
  from: number,
): number {
  const limit = haystack.length - needle.length
  outer: for (let i = from; i <= limit; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

/** 子串匹配器。 */
class SubstringMatcher implements SearchMatcher {
  /** 待查找的字面量（避免与 `find(text)` 方法同名）。 */
  private readonly needle: string
  private readonly caseSensitive: boolean
  private readonly wholeWord: boolean
  /** pattern 的码点序列。 */
  private readonly pattern: number[]
  /** 折叠后的 pattern（大小写不敏感时使用）。 */
  private readonly folded: number[]
  /** KMP 失配函数。 */
  private readonly fail: number[]

  constructor(options: SearchOptions) {
    this.needle = options.find
    this.caseSensitive = options.caseSensitive ?? true
    this.wholeWord = options.wholeWord ?? false
    this.pattern = codePoints(options.find)
    this.folded = this.caseSensitive ? [] : foldRunes(this.pattern)
    this.fail = this.caseSensitive ? [] : kmpFailure(this.folded)
  }

  find(text: string): SearchMatch[] {
    // Go：空 pattern 直接返回 nil（`strings.Index` 的 0 语义不适用于 Find）。
    if (this.pattern.length === 0) return []
    const codepoints = codePoints(text)
    if (codepoints.length < this.pattern.length) return []
    const matches: SearchMatch[] = []
    if (this.caseSensitive) {
      this.scanCaseSensitive(codepoints, (start, end) => {
        matches.push({ start, end })
        return true
      })
    } else {
      this.scanCaseInsensitive(codepoints, (start, end) => {
        matches.push({ start, end })
        return true
      })
    }
    return matches
  }

  hasMatch(text: string): boolean {
    if (this.pattern.length === 0) return false
    const codepoints = codePoints(text)
    if (codepoints.length < this.pattern.length) return false
    let found = false
    const stop = (): boolean => {
      found = true
      return false
    }
    if (this.caseSensitive) {
      this.scanCaseSensitive(codepoints, stop)
    } else {
      this.scanCaseInsensitive(codepoints, stop)
    }
    return found
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

  /**
   * 大小写敏感：沿用 Go `strings.Index` 的左最先、非重叠语义。
   *
   * 整词被拒时起点只前进**一个码点**，使跨过被拒起点的重叠候选仍可命中
   * （Go 前进一个字节；对合法 UTF-8 pattern 两者结果集合等价）。
   *
   * @returns 回调返回 `false` 时提前结束（`hasMatch` 的首个命中即停）。
   */
  private scanCaseSensitive(
    codepoints: readonly number[],
    onMatch: (start: number, end: number) => boolean,
  ): void {
    let searchStart = 0
    while (searchStart <= codepoints.length) {
      const start = indexOfSequence(codepoints, this.pattern, searchStart)
      if (start < 0) return
      const end = start + this.pattern.length
      if (!this.wholeWord || isWholeWord(codepoints, start, end)) {
        searchStart = end
        if (!onMatch(start, end)) return
      } else {
        searchStart = start + 1
      }
    }
  }

  /**
   * 大小写不敏感：在折叠归一的码点序列上跑 KMP 单趟匹配。
   *
   * 命中后状态归 0；整词被拒时状态回退到 `fail[patternLen-1]`，保留重叠候选。
   * 命中起点取自环形缓冲（每个已消费码点的全局序号对 patternLen 取模），
   * 而不是当前 KMP 状态——状态会因失配回退与命中重置而不再对应起点。
   */
  private scanCaseInsensitive(
    codepoints: readonly number[],
    onMatch: (start: number, end: number) => boolean,
  ): void {
    const foldedText = foldRunes(codepoints)
    const pattern = this.folded
    const patternLen = pattern.length
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
      if (!this.wholeWord || isWholeWord(codepoints, start, end)) {
        q = 0
        if (!onMatch(start, end)) return
      } else {
        // 整词拒绝：按标准 KMP 回退继续寻找重叠候选。
        q = fail[patternLen - 1] as number
      }
    }
  }
}

/** 一次正则匹配（含捕获组文本，索引均为 UTF-16 下标）。 */
interface RegexHit {
  /** 完整匹配起点。 */
  start: number
  /** 完整匹配终点（不含）。 */
  end: number
  /** 各捕获组文本（0 = 完整匹配；未参与匹配的组为空串）。 */
  groups: string[]
  /** 命名捕获组 → 组号。 */
  named: Record<string, number>
}

/** 正则匹配器。 */
class RegexMatcher implements SearchMatcher {
  private readonly re: ReturnType<typeof compile>
  private readonly wholeWord: boolean
  private readonly candidate: string
  /** 整词预筛正则（编译失败 → null，退化为直接精确判断，只慢不错）。 */
  private readonly boundary: ReturnType<typeof compile> | null

  constructor(options: SearchOptions, pattern: string, flags: string) {
    this.re = compile(`${flags}${pattern}`)
    this.wholeWord = options.wholeWord ?? false
    this.candidate = options.caseSensitive === false ? '' : literalPrefix(pattern)
    this.boundary = this.wholeWord
      ? safeCompile(`${flags}(?:\\A|[^\\p{L}\\p{Nd}])(?:${pattern})(?:\\z|[^\\p{L}\\p{Nd}])`)
      : null
  }

  find(text: string): SearchMatch[] {
    const hits = this.filteredHits(text)
    if (hits.length === 0) return []
    const offsets = utf16RuneOffsets(text)
    return hits.map((hit) => ({
      start: offsets[hit.start] as number,
      end: offsets[hit.end] as number,
    }))
  }

  hasMatch(text: string): boolean {
    if (!this.wholeWord) {
      // 非整词：`MatchString` 与 FindAll 非空等价，且不生成匹配切片。
      return this.re.test(text)
    }
    if (this.boundary && !this.boundary.test(text)) {
      return false
    }
    return this.filteredHits(text).length > 0
  }

  replaceAll(text: string, replaceWith: string): { text: string; count: number } {
    const hits = this.filteredHits(text)
    if (hits.length === 0) return { text, count: 0 }
    let out = ''
    let last = 0
    for (const hit of hits) {
      out += text.slice(last, hit.start)
      out += expandReplacement(replaceWith, hit)
      last = hit.end
    }
    out += text.slice(last)
    return { text: out, count: hits.length }
  }

  candidateLiteral(): string {
    return this.candidate
  }

  /** 全部非重叠匹配，再按整词边界过滤（等价 Go `submatchIndices`）。 */
  private filteredHits(text: string): RegexHit[] {
    const hits = this.matchAll(text)
    if (!this.wholeWord || hits.length === 0) return hits
    const codepoints = codePoints(text)
    const offsets = utf16RuneOffsets(text)
    return hits.filter((hit) =>
      isWholeWord(codepoints, offsets[hit.start] as number, offsets[hit.end] as number),
    )
  }

  /**
   * 复刻 Go `regexp.FindAllStringSubmatchIndex(text, -1)` 的迭代语义：
   *
   * - 左最先、非重叠；
   * - **空匹配紧邻上一个匹配结束处时被拒绝**（`start === prevMatchEnd`）；
   * - 空匹配处按 `pos` 所在码点宽度推进（代理对 +2），文本末尾宽度为 0 时结束；
   * - 匹配起点只落在码点边界（Go 的 rune 边界，re2js 允许代理对中间的位置）。
   */
  private matchAll(text: string): RegexHit[] {
    const matcher = this.re.matcher(text)
    const end = text.length
    const hits: RegexHit[] = []
    let pos = 0
    let prevMatchEnd = -1
    while (pos <= end) {
      if (!findAtOrAfter(matcher, text, pos)) break
      const start = matcher.start()
      const matchEnd = matcher.end()
      let accept = true
      if (matchEnd === start) {
        // 空匹配：紧邻上一个匹配结束处的忽略。
        if (start === prevMatchEnd) accept = false
        const width = codePointWidthAt(text, pos)
        if (width > 0) {
          pos += width
        } else {
          pos = end + 1
        }
      } else {
        pos = matchEnd
      }
      prevMatchEnd = matchEnd
      if (!accept) continue
      hits.push(this.hitAt(matcher, text, start, matchEnd))
    }
    return hits
  }

  /** 从当前 matcher 状态提取一次命中的捕获组文本。 */
  private hitAt(
    matcher: ReturnType<ReturnType<typeof compile>['matcher']>,
    text: string,
    start: number,
    end: number,
  ): RegexHit {
    const count = matcher.groupCount()
    const groups: string[] = []
    for (let g = 0; g <= count; g++) {
      const groupStart = matcher.start(g)
      groups.push(groupStart < 0 ? '' : text.slice(groupStart, matcher.end(g)))
    }
    return { start, end, groups, named: matcher.namedGroups ?? {} }
  }
}

/** 安全编译（失败返回 null）。 */
function safeCompile(pattern: string): ReturnType<typeof compile> | null {
  try {
    return compile(pattern)
  } catch {
    return null
  }
}

/** 判断 UTF-16 下标 `i` 是否为**码点边界**（Go 的 rune 边界）。 */
function isCodePointBoundary(src: string, i: number): boolean {
  if (i <= 0 || i >= src.length) return true
  const prev = src.charCodeAt(i - 1)
  const cur = src.charCodeAt(i)
  const prevIsHigh = prev >= 0xd800 && prev < 0xdc00
  const curIsLow = cur >= 0xdc00 && cur <= 0xdfff
  return !(prevIsHigh && curIsLow)
}

/** `i` 处码点的 UTF-16 宽度（越界为 0，与 Go `utf8.DecodeRuneInString` 一致）。 */
function codePointWidthAt(src: string, i: number): number {
  if (i < 0 || i >= src.length) return 0
  return (src.codePointAt(i) ?? 0) > 0xffff ? 2 : 1
}

/**
 * 从 `from`（含）开始找左侧首个匹配，且匹配起点必须是码点边界。
 *
 * re2js 的 `find(start)` 可能落在代理对中间并给出 Go 中不存在的匹配位置，
 * 因此逐次推进到下一个码点边界重试。
 */
function findAtOrAfter(
  matcher: ReturnType<ReturnType<typeof compile>['matcher']>,
  src: string,
  from: number,
): boolean {
  let pos = from
  while (pos <= src.length) {
    if (!matcher.find(pos)) return false
    if (isCodePointBoundary(src, matcher.start())) return true
    pos += codePointWidthAt(src, pos) || 1
  }
  return false
}

/**
 * 构造 `UTF-16 下标 → 码点下标` 的映射表（长度 `text.length + 1`）。
 *
 * 匹配边界都落在码点边界上，因此表中每个 UTF-16 下标的映射值即该位置之前的
 * 码点数（代理对的两个 code unit 映射到同一个码点下标）。
 */
function utf16RuneOffsets(text: string): number[] {
  const offsets = Array.from({ length: text.length + 1 }, () => 0)
  let rune = 0
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i) ?? 0
    const width = cp > 0xffff ? 2 : 1
    offsets[i] = rune
    if (width === 2) offsets[i + 1] = rune
    rune++
    i += width
  }
  offsets[text.length] = rune
  return offsets
}

/**
 * 展开替换串中的捕获组引用（对应 Go `Regexp.ExpandString`）。
 *
 * 逐字符复刻 Go `expand` + `extract`：
 *
 * - `$$` → 字面 `$`；
 * - `$N` / `${N}` → 第 N 个捕获组（`$0` 为完整匹配）；
 * - `$name` / `${name}` → 命名捕获组；
 * - 名字由字母 / 十进制数字 / `_` 组成（Go `unicode.IsLetter || IsDigit || '_'`）；
 * - 纯数字名字带前导零（如 `$01`）或含非数字（如 `$1x`）→ 不是组号，
 *   按「不存在的命名组」展开为空串；
 * - 未参与匹配的组展开为空串；
 * - 解析失败（如 `${1` 缺右花括号、结尾单个 `$`）→ `$` 按字面量保留。
 */
function expandReplacement(template: string, hit: RegexHit): string {
  if (!template.includes('$')) return template
  let out = ''
  let rest = template
  for (;;) {
    const dollar = rest.indexOf('$')
    if (dollar < 0) {
      out += rest
      return out
    }
    out += rest.slice(0, dollar)
    rest = rest.slice(dollar + 1)
    if (rest.startsWith('$')) {
      // `$$` → 字面 `$`。
      out += '$'
      rest = rest.slice(1)
      continue
    }
    const parsed = extractName(rest)
    if (parsed === null) {
      // 解析失败：`$` 按字面量保留，剩余部分继续按普通文本处理。
      out += '$'
      continue
    }
    rest = parsed.rest
    if (parsed.num >= 0) {
      out += parsed.num < hit.groups.length ? (hit.groups[parsed.num] as string) : ''
    } else {
      const index = hit.named[parsed.name]
      out +=
        index !== undefined && index < hit.groups.length ? (hit.groups[index] as string) : ''
    }
  }
}

/** 解析 `$` 之后的组名（对应 Go `regexp.extract`）。 */
function extractName(str: string): { name: string; num: number; rest: string } | null {
  if (str.length === 0) return null
  let i = 0
  let brace = false
  if (str[0] === '{') {
    brace = true
    i = 1
  }
  const nameStart = i
  while (i < str.length) {
    const cp = str.codePointAt(i) ?? 0
    if (!isLetter(cp) && !isDigit(cp) && cp !== 0x5f) break
    i += cp > 0xffff ? 2 : 1
  }
  if (i === nameStart) return null
  const name = str.slice(nameStart, i)
  if (brace) {
    if (i >= str.length || str[i] !== '}') return null
    i++
  }
  let num = 0
  for (let k = 0; k < name.length; k++) {
    const code = name.charCodeAt(k)
    if (code < 0x30 || code > 0x39) {
      num = -1
      break
    }
    num = num * 10 + (code - 0x30)
  }
  // 禁止前导零（`$0` 合法，`$01` 不是组号）。
  if (name[0] === '0' && name.length > 1) num = -1
  return { name, num, rest: str.slice(i) }
}

/**
 * 计算正则的**字面前缀**（对应 Go `regexp.LiteralPrefix` 的 `syntax.Prog.Prefix` 路径）。
 *
 * Go 的规则：编译后的程序若以单个 rune 的指令开头，该 rune 即字面前缀；
 * 分组（InstCapture）与 Nop 会被跳过，因此捕获组会**下钻**取其首个字面量；
 * 分支（`|`）、字符类、量词与锚点（`\A`、`\b` 等 EmptyWidth 指令）会中断前缀；
 * 折叠大小写（`(?i)`）与 U+FFFD 字面量同样中断。
 *
 * 实现直接复用 re2js 编译程序的 `prefix` 字段（RE2 的 `Prog.prefix()` 移植），
 * 因而分支因子化（`abc|abd` → `ab`）、`\Q...\E`、`\x41` 等细节与 Go 一致；
 * 仅补上 Go 独有的一处判定：**U+FFFD 字面量中断前缀**。
 *
 * 已知差异：Go 的 `LiteralPrefix` 对「以 `\A` / 非多行 `^` 开头且整体 one-pass」
 * 的模式会改用 `onePassPrefix`（跳过起始锚点）而返回非空前缀，例如 `^cat` → `cat`。
 * 本实现按 `Prog.Prefix` 返回空串——空串表示「无安全锚点」，只会让调用方退化为
 * 全量精筛，不会漏匹配。简单锚定字面量（`^cat`、`^(?:cat)`、`^a{3}`）由
 * `anchoredLiteralPrefix` 补齐，其余锚定模式保守返回空串。
 */
export function literalPrefix(pattern: string): string {
  const anchored = anchoredLiteralPrefix(pattern)
  if (anchored !== null) return anchored
  try {
    const re = compile(pattern)
    const prefix = re.re2().prefix
    if (typeof prefix !== 'string') return ''
    const replacement = prefix.indexOf('\uFFFD')
    return replacement >= 0 ? prefix.slice(0, replacement) : prefix
  } catch {
    return ''
  }
}

/**
 * 简单锚定模式的字面前缀（补齐 Go `onePassPrefix` 的常见情形）。
 *
 * 仅当模式满足「起始指令是 `\A` / 非多行 `^`，且其后全部是字面量 / 转义字面量 /
 * 单字符类 / 非捕获分组 / 固定次数重复」时返回前缀；其余一律返回 `null`，
 * 交由 `Prog.Prefix` 的保守路径处理（锚点中断 → 空串）。
 */
function anchoredLiteralPrefix(pattern: string): string | null {
  const state: AnchorScan = { i: 0, fold: false, multiline: false }
  skipLeadingGroups(pattern, state)
  if (!consumeBeginTextAnchor(pattern, state)) return null
  return gatherSimpleLiteral(pattern, state)
}

/** 锚定扫描状态。 */
interface AnchorScan {
  /** 当前扫描下标。 */
  i: number
  /** 是否处于 `(?i)` 折叠大小写作用域。 */
  fold: boolean
  /** 是否处于 `(?m)` 多行作用域。 */
  multiline: boolean
}

/**
 * 跳过起始的 `(?flags)` 组头与「包裹整个模式」的 `(?:`（它们不产生指令）。
 *
 * 只接受闭合括号恰好在模式末尾的 `(?:`：若分组后面还有内容，分组可能被量词
 * 修饰（`(?:^a)*b`）或参与分支（`(?:^a)|b`），此时锚点不保证出现在每个匹配开头，
 * 必须交给保守路径返回空串。
 */
function skipLeadingGroups(pattern: string, state: AnchorScan): void {
  while (state.i < pattern.length) {
    const flags = /^\(\?([imsU]*)(?:-([imsU]*))?\)/.exec(pattern.slice(state.i))
    if (flags) {
      applyFlags(state, flags[1] ?? '', flags[2] ?? '')
      state.i += flags[0].length
      continue
    }
    if (pattern.startsWith('(?:', state.i) && groupClose(pattern, state.i) === pattern.length - 1) {
      state.i += 3
      continue
    }
    return
  }
}

/** 返回与 `openIndex` 处 `(` 配对的 `)` 下标（跳过转义与字符类）；未配对返回 -1。 */
function groupClose(pattern: string, openIndex: number): number {
  let depth = 0
  let inClass = false
  for (let i = openIndex; i < pattern.length; i++) {
    const ch = pattern[i] as string
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
    if (ch === '(') {
      depth++
    } else if (ch === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** 应用 inline flag 组（只关心 `i` 与 `m`）。 */
function applyFlags(state: AnchorScan, on: string, off: string): void {
  for (const flag of on) {
    if (flag === 'i') state.fold = true
    if (flag === 'm') state.multiline = true
  }
  for (const flag of off) {
    if (flag === 'i') state.fold = false
    if (flag === 'm') state.multiline = false
  }
}

/** 消费起始 `\A` / 非多行 `^`；不是锚点则返回 false。 */
function consumeBeginTextAnchor(pattern: string, state: AnchorScan): boolean {
  if (pattern.startsWith('\\A', state.i)) {
    state.i += 2
    return true
  }
  if (pattern[state.i] === '^' && !state.multiline) {
    state.i += 1
    return true
  }
  return false
}

/**
 * 收集锚点之后的简单字面前缀；模式不是「简单锚定字面量」时返回 `null`。
 *
 * 简单 = 字面量 rune、转义字面量、单字符类、非捕获分组、固定次数重复 `{n}`、
 * 以及结尾锚点 `$` / `\z`。出现捕获组、分支、可变量词、`.`、字符类（多字符）、
 * `\d`/`\p` 等类别转义、`\b`/`\B` 时返回 `null`。
 */
function gatherSimpleLiteral(pattern: string, state: AnchorScan): string | null {
  let out = ''
  let lastRune = ''
  while (state.i < pattern.length) {
    const ch = pattern[state.i] as string
    if (ch === ')' || ch === '$') return out
    if (pattern.startsWith('\\z', state.i)) return out
    if (ch === '(') {
      if (pattern.startsWith('(?:', state.i)) {
        state.i += 3
        const inner = gatherSimpleLiteral(pattern, state)
        if (inner === null) return null
        out += inner
        // `gatherSimpleLiteral` 停在 `)` 或结尾。
        if (pattern[state.i] === ')') {
          state.i += 1
          lastRune = ''
          continue
        }
        return out
      }
      const flags = /^\(\?([imsU]*)(?:-([imsU]*))?:/.exec(pattern.slice(state.i))
      if (flags) {
        // `(?flags:...)` 的作用域限于分组内部，退出分组后必须还原。
        const savedFold = state.fold
        const savedMultiline = state.multiline
        applyFlags(state, flags[1] ?? '', flags[2] ?? '')
        state.i += flags[0].length
        const inner = gatherSimpleLiteral(pattern, state)
        state.fold = savedFold
        state.multiline = savedMultiline
        if (inner === null) return null
        out += inner
        if (pattern[state.i] === ')') {
          state.i += 1
          lastRune = ''
          continue
        }
        return out
      }
      return null
    }
    if (ch === '|' || ch === '.' || ch === '[') {
      if (ch === '[') {
        const single = parseSingleCharClass(pattern, state)
        if (single === null) return null
        out += single
        lastRune = single
        continue
      }
      return null
    }
    if (ch === '*' || ch === '+' || ch === '?') return null
    if (ch === '{') {
      const repeat = /^\{(\d+)\}/.exec(pattern.slice(state.i))
      if (!repeat) return null
      const count = Number(repeat[1])
      if (lastRune === '') return null
      if (count === 0) {
        // `x{0}` 等价于删除该 rune（Go `Simplify` 会把 `a{0}b` 化简为 `b`）。
        out = out.slice(0, out.length - lastRune.length)
        lastRune = ''
        state.i += repeat[0].length
        continue
      }
      out += lastRune.repeat(count - 1)
      state.i += repeat[0].length
      continue
    }
    if (ch === '\\') {
      const literal = parseEscapedLiteral(pattern, state)
      if (literal === null) return null
      if (state.fold) return out
      out += literal
      lastRune = literal
      continue
    }
    if (state.fold) return out
    const cp = pattern.codePointAt(state.i) ?? 0
    if (cp === 0xfffd) return out
    const literal = String.fromCodePoint(cp)
    out += literal
    lastRune = literal
    state.i += literal.length
  }
  return out
}

/** 解析转义字面量（`\.`、`\x41`、`\n`、`\Q...\E` 等）；类别/锚点转义返回 `null`。 */
function parseEscapedLiteral(pattern: string, state: AnchorScan): string | null {
  const next = pattern[state.i + 1]
  if (next === undefined) return null
  if (next === 'Q') {
    const end = pattern.indexOf('\\E', state.i + 2)
    const text = pattern.slice(state.i + 2, end < 0 ? pattern.length : end)
    state.i = end < 0 ? pattern.length : end + 2
    return text
  }
  if ('dDwWsSbBAzZpP'.includes(next)) return null
  if (next === 'x') {
    const braced = /^\\x\{([0-9A-Fa-f]+)\}/.exec(pattern.slice(state.i))
    if (braced) {
      state.i += braced[0].length
      return String.fromCodePoint(Number.parseInt(braced[1] as string, 16))
    }
    const hex = /^\\x([0-9A-Fa-f]{2})/.exec(pattern.slice(state.i))
    if (!hex) return null
    state.i += hex[0].length
    return String.fromCodePoint(Number.parseInt(hex[1] as string, 16))
  }
  if (next >= '0' && next <= '7') {
    const octal = /^\\([0-7]{1,3})/.exec(pattern.slice(state.i))
    if (!octal) return null
    state.i += octal[0].length
    return String.fromCodePoint(Number.parseInt(octal[1] as string, 8))
  }
  const simple: Record<string, string> = { a: '\x07', f: '\f', t: '\t', n: '\n', r: '\r', v: '\v' }
  state.i += 2
  return simple[next] ?? next
}

/** 解析单字符类 `[a]`（含转义）；多字符类 / 区间 / 取反返回 `null`。 */
function parseSingleCharClass(pattern: string, state: AnchorScan): string | null {
  let i = state.i + 1
  if (pattern[i] === '^') return null
  let literal: string | null = null
  while (i < pattern.length) {
    const ch = pattern[i] as string
    if (ch === ']') {
      if (literal === null) return null
      state.i = i + 1
      return literal
    }
    let piece: string | null
    let next: number
    if (ch === '\\') {
      const sub: AnchorScan = { i, fold: state.fold, multiline: state.multiline }
      piece = parseEscapedLiteral(pattern, sub)
      if (piece === null) return null
      next = sub.i
    } else {
      if (ch === '-') return null
      const cp = pattern.codePointAt(i) ?? 0
      piece = String.fromCodePoint(cp)
      next = i + piece.length
    }
    if (literal !== null) return null
    literal = piece
    i = next
  }
  return null
}

/**
 * 构造匹配器。
 *
 * @throws SearchError 模式过长 / 正则非法 / 匹配模式不支持
 */
export function createSearchMatcher(options: SearchOptions): SearchMatcher {
  const pattern = options.find
  const patternRunes = runeCount(pattern)
  if (patternRunes > MAX_PATTERN_RUNES) {
    throw new SearchError(
      SEARCH_ERROR_PATTERN_TOO_LONG,
      `pattern too long: ${patternRunes} runes, max ${MAX_PATTERN_RUNES}`,
    )
  }
  const rawMode = options.matchMode as string | undefined
  // Go 把空 MatchMode 视为 "substring"（`case "", "substring":`）。
  const matchMode = rawMode === undefined || rawMode === '' ? 'substring' : rawMode
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
