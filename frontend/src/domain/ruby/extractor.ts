/**
 * 注音（ruby）提取与剥离（对应 Go `backend/internal/ruby/extractor.go`）。
 *
 * 单一事实源是文本中的 HTML 标签本身：
 *
 * 1. 提取所有 `<ruby>` 元素中每一对「基底 + 注音」（多段 `<rt>` 的元素逐对产出，
 *    与等价的相邻独立元素语义一致）；
 * 2. 合并相邻的 per-kanji ruby 为词级注音；
 * 3. 剥离 ruby 标签，只保留基底文本。
 *
 * 偏移量单位说明：Go 使用 **UTF-8 字节偏移**；本移植统一使用 **UTF-16 code unit 偏移**，
 * 因为所有切片都在 JS 字符串内完成，截取出的子串与 Go 完全一致。
 * 唯一需要注意的差异是 Go 的 `utf8.DecodeRuneInString` 判「单个 rune」，
 * 此处改用「单个 Unicode 码点」判定（见 `isPerKanji`）。
 */
import { compile, findAllStringIndex, replaceAllString } from '../shared/re2'
import { assignIds, newRubyItem, type RubyItem } from './item'

/** 定位 `<ruby>…</ruby>` 元素跨度（分组 1 = 元素内内容）。 */
const rubyElementSpanRe = compile('<ruby>(.*?)</ruby>')

/** 在 ruby 元素内扫描完整 `<rt>注音</rt>` 跨度（分组 1 = 注音文本）。 */
const rubyRTSpanRe = compile('<rt>(.*?)</rt>')

/** 匹配 HTML/XML 标签，用于从基底文本中清理辅助标签。 */
const htmlTagRe = compile('<[^>]*>')

/** Go `unicode.Han`（CJK 统一表意文字）。 */
const HAN_RE = /\p{Script=Han}/u

/** 注音条目（基底文本 + 标注文本）。 */
interface Annotation {
  base: string
  text: string
}

/** ruby 匹配：注音条目 + 在源文本中的位置。 */
interface RubyMatch extends Annotation {
  start: number
  end: number
}

/** `<rt>注音</rt>` 注音跨度。 */
interface RtSpan {
  start: number
  end: number
  textStart: number
  textEnd: number
}

/** `<ruby>…</ruby>` 元素。 */
interface RubyElement {
  start: number
  end: number
  rts: RtSpan[]
}

/**
 * 定位 source 中所有 `<ruby>…</ruby>` 元素跨度及其内部全部完整 `<rt>…</rt>` 注音跨度。
 *
 * 无任何完整 rt 对的元素在此统一过滤，不进入扫描结果。
 * 不带 `(?s)`：`.` 不匹配换行，跨行元素不命中（与 Go 行为一致）。
 */
function scanRubyElements(source: string): RubyElement[] {
  const elements: RubyElement[] = []
  const elMatches = findAllStringIndex(rubyElementSpanRe, source)
  if (elMatches.length === 0) return elements

  for (const [elStart, elEnd] of elMatches) {
    // 元素内内容 = 元素整体去掉 <ruby> 前缀与 </ruby> 后缀。
    const innerStart = elStart + '<ruby>'.length
    const innerEnd = elEnd - '</ruby>'.length
    const inner = source.slice(innerStart, innerEnd)
    const rts: RtSpan[] = []
    for (const [locStart, locEnd] of findAllStringIndex(rubyRTSpanRe, inner)) {
      rts.push({
        start: innerStart + locStart,
        end: innerStart + locEnd,
        textStart: innerStart + locStart + '<rt>'.length,
        textEnd: innerStart + locEnd - '</rt>'.length,
      })
    }
    if (rts.length === 0) continue
    elements.push({ start: elStart, end: elEnd, rts })
  }
  return elements
}

/**
 * 提取 source 中所有 ruby 元素的每对「基底 + 注音」及其位置。
 *
 * 多段 `<rt>` 的元素（如 `<ruby>何<rt>な</rt>故<rt>ぜ</rt></ruby>`）逐对产出，
 * 语义与相邻独立元素一致：每对的 span 平铺整个元素，保证 `mergeAdjacentRuby`
 * 的「紧邻」判定在元素内与跨元素间口径一致。
 */
function extractRubyMatches(source: string): RubyMatch[] {
  const elements = scanRubyElements(source)
  const matches: RubyMatch[] = []
  for (const el of elements) {
    for (let i = 0; i < el.rts.length; i++) {
      const rt = el.rts[i] as RtSpan
      // 本对起点 = 元素起点（首对，含 <ruby> 前缀）或上一对 </rt> 终点（中间对）
      const start = i > 0 ? (el.rts[i - 1] as RtSpan).end : el.start
      const base = replaceAllString(htmlTagRe, source.slice(start, rt.start), '')
      // span 覆盖本对的基底 + 注音，并向元素两端延伸
      const end = i < el.rts.length - 1 ? rt.end : el.end
      matches.push({ base, text: source.slice(rt.textStart, rt.textEnd), start, end })
    }
  }
  return matches
}

/**
 * 合并相邻的 per-kanji ruby 为词级注音。
 *
 * 合并条件：当前基底是单个汉字、下一个紧邻（无分隔字符）、下一个也是 per-kanji。
 */
function mergeAdjacentRuby(matches: readonly RubyMatch[]): Annotation[] {
  if (matches.length === 0) return []

  const result: Annotation[] = []
  let i = 0
  while (i < matches.length) {
    const current = matches[i] as RubyMatch
    if (isPerKanji(current.base)) {
      const merged: Annotation = { base: current.base, text: current.text }
      let j = i + 1
      while (j < matches.length) {
        const next = matches[j] as RubyMatch
        const prev = matches[j - 1] as RubyMatch
        if (next.start !== prev.end) break // 不紧邻
        if (!isPerKanji(next.base)) break
        merged.base += next.base
        merged.text += next.text
        j++
      }
      result.push(merged)
      i = j
    } else {
      result.push({ base: current.base, text: current.text })
      i++
    }
  }
  return result
}

/**
 * 检查基底文本是否为单个汉字。
 *
 * Go `isPerKanji`：单个 rune 且属于 `unicode.Han`。
 */
function isPerKanji(base: string): boolean {
  const cps = Array.from(base)
  if (cps.length !== 1) return false
  const cp = cps[0]!.codePointAt(0) ?? 0
  return HAN_RE.test(String.fromCodePoint(cp))
}

/**
 * 从源文本中提取所有 ruby 注音条目并剥离 ruby 标签。
 *
 * 返回按出现顺序排列的条目（ID 经 `assignIds` 分配为段内稳定序号）与剥离后的文本；
 * 无 ruby 元素时 items 为空数组、文本原样返回。
 */
export function extract(source: string): { items: RubyItem[]; stripped: string } {
  const matches = extractRubyMatches(source)
  const merged = mergeAdjacentRuby(matches)
  const stripped = stripRubyTags(source)

  if (merged.length === 0) {
    return { items: [], stripped }
  }
  const items = merged.map((a) => newRubyItem({ source_base: a.base, source_text: a.text }))
  assignIds(items)
  return { items, stripped }
}

/**
 * 剥离 `<ruby>` / `<rt>` 标签，只保留基底文本。
 *
 * 元素内删除全部完整 `<rt>…</rt>` 跨度（标签与注音内容一起删），
 * 其余辅助标签（如 `<rp>`、`<rb>`；仅删标签本身，其回退文本内容保留）一并清理。
 * 无任何完整 rt 对的元素不经本函数改写、原样保留（含标签）。
 *
 * 本函数是全仓注音剥离的单一来源。
 */
export function stripRubyTags(source: string): string {
  const elements = scanRubyElements(source)
  if (elements.length === 0) return source

  let out = ''
  let cursor = 0
  for (const el of elements) {
    out += source.slice(cursor, el.start)
    let pos = el.start
    for (const rt of el.rts) {
      out += replaceAllString(htmlTagRe, source.slice(pos, rt.start), '')
      pos = rt.end
    }
    out += replaceAllString(htmlTagRe, source.slice(pos, el.end), '')
    cursor = el.end
  }
  out += source.slice(cursor)
  return out
}

/**
 * 返回 s 中所有 `<ruby>…</ruby>` 元素的跨度 `[start, end)`（升序、不重叠）。
 *
 * Go `ruby.ElementSpans`。
 */
export function elementSpans(s: string): Array<[number, number]> {
  return scanRubyElements(s).map((el) => [el.start, el.end] as [number, number])
}
