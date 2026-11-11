/**
 * Go `regexp`（RE2）到 JavaScript 的兼容层。
 *
 * 为什么不用原生 `RegExp`：Go 标准库的正则语义与 JS 存在若干**不可忽略**的差异，
 * 直接搬运正则源码会导致匹配结果与后端不一致：
 *
 * | 语义 | Go RE2 | JS RegExp |
 * |---|---|---|
 * | `\s` | `[\t\n\f\r ]`（不含 `\v`、不含 Unicode 空白） | 含 `\v`、含 NBSP/全角空格/U+FEFF |
 * | `(?m)^` | 仅在 `\n` 之后 | 也在 `\r`、`\u2028`、`\u2029` 之后 |
 * | `(?m)$` | 仅在 `\n` 之前与文本末尾 | 也在 `\r`、`\u2028`、`\u2029` 之前 |
 * | 匹配语义 | leftmost-first（与 PCRE 一致） | leftmost-first（一致） |
 *
 * `re2js` 是 Go `regexp` 的 JavaScript 移植（DFA/NFA 线性时间，无 ReDoS），
 * 上述差异全部按 RE2 语义实现，故本模块直接复用它，保证前后端逐字节一致。
 *
 * 偏移量单位说明：re2js 的 `start()` / `end()` 返回 **UTF-16 code unit 下标**
 * （Go 返回 UTF-8 字节下标）。本模块的所有切片都在同一坐标系内完成，
 * 因此提取出的子串与 Go 完全相同；调用方若需要字节偏移必须显式换算。
 */
import { RE2JS } from 're2js'

const cache = new Map<string, RE2JS>()

/** 编译并缓存一个 RE2 正则（等价 Go `regexp.MustCompile`）。 */
export function compile(pattern: string): RE2JS {
  const cached = cache.get(pattern)
  if (cached) return cached
  const compiled = RE2JS.compile(pattern)
  cache.set(pattern, compiled)
  return compiled
}

/**
 * 判断 UTF-16 下标 `i` 是否为**码点边界**（Go 的 rune 边界）。
 *
 * Go 的 regexp 在 rune 边界匹配；re2js 的 `find(start)` 允许落在代理对中间
 * （UTF-16 code unit 位置），该位置在 Go 中不存在，必须跳过。
 */
function isCodePointBoundary(src: string, i: number): boolean {
  if (i <= 0 || i >= src.length) return true
  const prev = src.charCodeAt(i - 1)
  const cur = src.charCodeAt(i)
  const prevIsHigh = prev >= 0xd800 && prev < 0xdc00
  const curIsLow = cur >= 0xdc00 && cur <= 0xdfff
  return !(prevIsHigh && curIsLow)
}

/**
 * `i` 处码点的 UTF-16 宽度（Go `utf8.DecodeRuneInString` 的宽度语义；
 * 位置越界时宽度为 0，与 Go 行为一致）。
 */
function codePointWidthAt(src: string, i: number): number {
  if (i < 0 || i >= src.length) return 0
  return src.codePointAt(i)! > 0xffff ? 2 : 1
}

/**
 * 从 `from`（含）开始找左侧首个匹配，且匹配起点必须是码点边界。
 *
 * re2js 的 `find(start)` 可能在代理对中间给出空匹配；Go 的 RE2 引擎不存在
 * 这样的匹配位置，因此这里逐次推进到下一个码点边界重试。
 */
function findFromBoundary(
  matcher: ReturnType<RE2JS['matcher']>,
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
 * 全部替换，等价 Go `regexp.ReplaceAllStringFunc`。
 *
 * 复刻 Go `regexp.replaceAll` 的精确语义（`go/src/regexp/regexp.go`）：
 *
 * 1. 匹配间的不参与文本原样拷贝；
 * 2. **仅当** `a[1] > lastMatchEnd || a[0] == 0` 时才调用替换函数——
 *    「紧跟在上一个匹配结束处的空匹配」不调用（否则 `a*` 之类会产生双替换）；
 * 3. 推进规则保证至少前进一个码点（空匹配不死循环）；
 * 4. 空匹配传入函数的是空串（Go 实测：`a*` on `"bab"` → `<>b<a>b<>`）。
 */
export function replaceAllStringFunc(
  re: RE2JS,
  src: string,
  fn: (match: string) => string,
): string {
  const matcher = re.matcher(src)
  const end = src.length
  let out = ''
  let lastMatchEnd = 0
  let searchPos = 0
  while (searchPos <= end) {
    if (!findFromBoundary(matcher, src, searchPos)) break
    const matchStart = matcher.start()
    const matchEnd = matcher.end()
    // 拷贝匹配前的不参与文本。
    out += src.slice(lastMatchEnd, matchStart)
    if (matchEnd > lastMatchEnd || matchStart === 0) {
      out += fn(src.slice(matchStart, matchEnd))
    }
    lastMatchEnd = matchEnd
    // 至少推进一个码点（Go：按 searchPos 处的 rune 宽度）。
    const width = codePointWidthAt(src, searchPos)
    if (searchPos + width > matchEnd) {
      searchPos += width
    } else if (searchPos + 1 > matchEnd) {
      // 仅发生在输入末尾（宽度为 0）。
      searchPos++
    } else {
      searchPos = matchEnd
    }
  }
  return out + src.slice(lastMatchEnd)
}

/** 全部替换为固定字符串，等价 Go `regexp.ReplaceAllString`。 */
export function replaceAllString(re: RE2JS, src: string, repl: string): string {
  return replaceAllStringFunc(re, src, () => repl)
}

/**
 * 查找全部匹配的 [start, end) 下标对，等价 Go `regexp.FindAllStringIndex`。
 *
 * 复刻 Go `allMatches` 的迭代语义（`go/src/regexp/regexp.go`）：
 *
 * - 空匹配**紧跟**在上一个匹配结束处（`matches[0] == prevMatchEnd`）时被拒绝；
 * - 空匹配处按码点宽度推进（代理对 +2），末尾宽度为 0 时退出循环；
 * - 匹配起点只落在码点边界（Go rune 边界；Go 实测：`x*` on `"😀x"` 仅有
 *   `0..0` 与 `4..5` 两处匹配，末尾空匹配被拒绝）。
 *
 * Go 返回 UTF-8 字节下标；此处返回 UTF-16 code unit 下标，供 JS 字符串切片
 * 使用（调用方若需要字节偏移必须显式换算）。
 */
export function findAllStringIndex(re: RE2JS, src: string): Array<[number, number]> {
  const matcher = re.matcher(src)
  const end = src.length
  const out: Array<[number, number]> = []
  let pos = 0
  let prevMatchEnd = -1
  while (pos <= end) {
    if (!findFromBoundary(matcher, src, pos)) break
    const start = matcher.start()
    const matchEnd = matcher.end()
    let accept = true
    if (matchEnd === pos) {
      // 空匹配：紧邻上一个匹配结束处则拒绝。
      if (start === prevMatchEnd) accept = false
      const width = codePointWidthAt(src, pos)
      if (width > 0) {
        pos += width
      } else {
        pos = end + 1
      }
    } else {
      pos = matchEnd
    }
    prevMatchEnd = matchEnd
    if (accept) out.push([start, matchEnd])
  }
  return out
}

/**
 * 查找左侧首个匹配的子分组文本，等价 Go `regexp.FindStringSubmatch`。
 *
 * 未参与匹配的分组返回空串（与 Go 一致；re2js 的 `group()` 返回 null，此处归一）；
 * 无匹配时返回 `null`。
 */
export function findStringSubmatch(re: RE2JS, src: string): string[] | null {
  const matcher = re.matcher(src)
  if (!matcher.find()) return null
  const count = matcher.groupCount()
  const out: string[] = []
  for (let i = 0; i <= count; i++) {
    const g = matcher.group(i)
    out.push(g === null || g === undefined ? '' : g)
  }
  return out
}

/** 左侧首个匹配的完整文本，等价 Go `regexp.FindString`（无匹配返回空串）。 */
export function findString(re: RE2JS, src: string): string {
  const matcher = re.matcher(src)
  if (!matcher.find()) return ''
  return matcher.group(0) ?? ''
}

/** 左侧首个匹配的 [start, end) 下标对，无匹配返回 `null`（等价 Go `FindStringIndex`）。 */
export function findStringIndex(re: RE2JS, src: string): [number, number] | null {
  const matcher = re.matcher(src)
  if (!matcher.find()) return null
  return [matcher.start(), matcher.end()]
}

/** 是否匹配，等价 Go `regexp.MatchString`。 */
export function matchString(re: RE2JS, src: string): boolean {
  return re.test(src)
}

/**
 * 统计匹配次数，等价 Go `regexp.Count`。
 *
 * 注意：Go 的 `Count` 统计的是**匹配个数**（含空匹配），而非匹配文本的总长度。
 */
export function countMatches(re: RE2JS, src: string): number {
  return findAllStringIndex(re, src).length
}
