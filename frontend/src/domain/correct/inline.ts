/**
 * QA 内联标记屏蔽工具的领域层移植（对应 Go `qa.InlineMarkupRegions` /
 * `StripProtectedRegions` / `StripRegions` / `stripPlaceholders`）。
 *
 * 纠错规则的「clean 文本」口径必须与 QA checker 完全一致，否则会出现
 * 「checker 在 clean 上检出、规则在原文上改写」的漂移。Go 侧 qa 包未被移植，
 * 故此处按 `backend/internal/qa/protect_region.go` 与 `checker_source_residual.go`
 * 的语义逐行对齐，作为 correct 包内部依赖（非跨包公共 API）。
 *
 * 偏移量单位：Go 用 rune 偏移；本移植同样用 **码点下标**（`codePoints` 数组），
 * 避免 UTF-16 代理对把 emoji 劈成两半。
 */
import { compile, findAllStringIndex, replaceAllString } from '../shared/re2'
import { codePoints } from '../shared/unicode'
import { elementSpans } from '../ruby/extractor'

/** 匹配 HTML/XML 标签，用于裸标签的兜底屏蔽（与 Go `qa.htmlTagRe` 同源）。 */
const htmlTagRe = compile('<[^>]*>')

/** 匹配 `__LF_*` 占位符（与 Go `qa.placeholderRe` 同源）。 */
const placeholderRe = compile('__LF_[A-Za-z0-9_]+')

/**
 * 把 UTF-16 code unit 下标映射为码点下标。
 *
 * Go 的 `utf8.RuneOffset` 语义是「字节偏移 → 码点偏移」；这里同样只做坐标换算，
 * 不改变切片内容。
 */
function buildUtf16ToRune(text: string): number[] {
  const map: number[] = Array.from({ length: text.length + 1 }, () => 0)
  let rune = 0
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i) ?? 0
    const width = cp > 0xffff ? 2 : 1
    for (let k = 0; k < width; k++) map[i + k] = rune
    i += width
    rune++
  }
  map[text.length] = rune
  return map
}

/**
 * 对区域按起点升序、同起点长区域在前排序并合并重叠区间
 * （与 Go `qa.mergeRegions` 完全一致，含「同起点长区域优先」的稳定性约定）。
 */
function mergeRegions(input: Array<[number, number]>): Array<[number, number]> {
  if (input.length === 0) return []
  const sorted = [...input].sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : b[1] - a[1]))
  const out: Array<[number, number]> = []
  for (const r of sorted) {
    if (out.length === 0) {
      out.push([r[0], r[1]])
      continue
    }
    const last = out[out.length - 1] as [number, number]
    if (r[0] >= last[1]) {
      out.push([r[0], r[1]])
    } else if (r[1] > last[1]) {
      last[1] = r[1]
    }
  }
  return out
}

/** 在 target 中找出每个 protected 值的全部出现位置（码点偏移）。 */
function protectedOccurrences(
  target: string,
  protectedMap: Record<string, string>,
): Array<[number, number]> {
  const raw: Array<[number, number]> = []
  const entries = Object.values(protectedMap)
  if (entries.length === 0 || target === '') return raw
  const map = buildUtf16ToRune(target)
  for (const value of entries) {
    if (value === '') continue
    let searchStart = 0
    for (;;) {
      const rel = target.indexOf(value, searchStart)
      if (rel < 0) break
      const start = map[rel] ?? 0
      const end = start + codePoints(value).length
      raw.push([start, end])
      searchStart = rel + value.length
    }
  }
  return raw
}

/** 找出所有含完整注音对的 `<ruby>…</ruby>` 元素位置（码点偏移）。 */
function rubyRegions(target: string): Array<[number, number]> {
  const spans = elementSpans(target)
  if (spans.length === 0) return []
  const map = buildUtf16ToRune(target)
  return spans.map(([start, end]) => [
    map[start] ?? 0,
    (map[start] ?? 0) + codePoints(target.slice(start, end)).length,
  ])
}

/** 裸标签兜底屏蔽通道（码点偏移）。 */
function tagRegions(target: string): Array<[number, number]> {
  const matches = findAllStringIndex(htmlTagRe, target)
  if (matches.length === 0) return []
  const map = buildUtf16ToRune(target)
  return matches.map(([start, end]) => [map[start] ?? 0, map[end] ?? 0])
}

/**
 * 返回 target 中「Protected 区 ∪ ruby 元素区 ∪ 内联标签区」的码点偏移并集
 * （升序、已合并）；空输入返回空数组（与 Go 的 nil 语义等价）。
 */
export function inlineMarkupRegions(
  target: string,
  protectedMap: Record<string, string>,
): Array<[number, number]> {
  const raw = [
    ...protectedOccurrences(target, protectedMap),
    ...rubyRegions(target),
    ...tagRegions(target),
  ]
  if (raw.length === 0) return []
  return mergeRegions(raw)
}

/** 按区域删除文本（与 Go `qa.StripRegions` 一致；regions 需升序且已合并）。 */
export function stripRegions(
  text: string,
  regions: ReadonlyArray<readonly [number, number]>,
): string {
  if (regions.length === 0) return text
  const runes = codePoints(text)
  const out: number[] = []
  let pos = 0
  for (const [start, end] of regions) {
    if (start > pos) out.push(...runes.slice(pos, start))
    if (end > pos) pos = end
  }
  if (pos < runes.length) out.push(...runes.slice(pos))
  return out.map((cp) => String.fromCodePoint(cp)).join('')
}

/** 移除 `__LF_*` 占位符并转小写（与 Go `qa.stripPlaceholders` 一致）。 */
export function stripPlaceholders(s: string): string {
  if (!s.includes('__LF_')) return s.toLowerCase()
  return replaceAllString(placeholderRe, s, '').toLowerCase()
}

/**
 * 返回去掉内联标记区与 `__LF_*` 占位符、并转小写后的 clean 文本
 * （与 Go `qa.StripProtectedRegions` 一致）。
 */
export function stripProtectedRegions(text: string, protectedMap: Record<string, string>): string {
  return stripPlaceholders(stripRegions(text, inlineMarkupRegions(text, protectedMap)))
}

/** 判断码点下标是否落在任一区域（regions 需升序且已合并）。 */
export function runeInRegions(
  regions: ReadonlyArray<readonly [number, number]>,
  i: number,
): boolean {
  for (const [start, end] of regions) {
    if (start > i) return false
    if (i < end) return true
  }
  return false
}
