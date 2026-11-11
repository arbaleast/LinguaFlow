/**
 * 内联标记保护区（对应 Go `backend/internal/qa/protect_region.go`）。
 *
 * QA 的文本类 checker 必须先屏蔽三类「非正文」片段，否则标签属性里的字母/引号/空格
 * 会被当成译文内容误报：
 *
 * 1. **Protected 通道**：`protect.XMLProtector` 等把保护片段写入 `seg.Protected`；
 * 2. **ruby 通道**：`ruby.Restorer` 在 Unprotect 之后插回 `<ruby>…</ruby>`，不进
 *    `seg.Protected`，区域定位复用 `ruby.ElementSpans`（与 `stripRubyTags` 同一扫描口径）；
 * 3. **裸标签通道**：`htmlTagRe` 兜底屏蔽 `<a href="x">` 等标签，覆盖 Protected
 *    映射缺失的手动编辑 / DB 重载场景。
 *
 * 所有区域都是 **rune（码点）偏移**：Go 从正则/`strings.Index` 的字节下标换算，
 * 这里从 UTF-16 下标换算（`runeOffset`），二者在码点边界上等价。
 */
import { elementSpans, trimSpace } from '../ruby'
import { compile, findAllStringIndex, replaceAllStringFunc } from '../shared/re2'
import { runeCount } from '../shared/unicode'
import { locateSpanFull, runeOffset } from './span'
import type { Span } from './types'

/** 半开区间 `[start, end)`，单位为 rune 偏移。 */
export type Region = [number, number]

/** 匹配 HTML/XML 标签，用于裸标签的兜底屏蔽（Go `htmlTagRe`）。 */
const htmlTagRe = compile('<[^>]*>')

/**
 * 返回 `target` 中全部 Protected 区（升序、已合并）；无输入返回 `null`
 * （Go `ProtectedRegions`；TS 用 `null` 表达 Go 的 nil slice）。
 */
export function protectedRegions(
  target: string,
  protectedMap: Record<string, string> | null | undefined,
): Region[] | null {
  if (protectedMap === null || protectedMap === undefined || target === '') {
    return null
  }
  const keys = Object.keys(protectedMap)
  if (keys.length === 0) {
    return null
  }
  return mergeRegions(protectedOccurrences(target, protectedMap))
}

/**
 * 在 `target` 中找出每个 protected 值的全部出现位置（Go `protectedOccurrences`）。
 *
 * 同一保护值可能在译文中重复出现（多个 `<br/>` 或相同 URL），必须全部记录，
 * 否则未屏蔽的副本仍会被 checker 误报。
 */
export function protectedOccurrences(
  target: string,
  protectedMap: Record<string, string>,
): Region[] {
  const raw: Region[] = []
  for (const value of Object.values(protectedMap)) {
    if (value === '') continue
    let searchStart = 0
    while (searchStart <= target.length) {
      const rel = target.indexOf(value, searchStart)
      if (rel < 0) break
      const start = runeOffset(target, rel)
      const end = start + runeCount(value)
      raw.push([start, end])
      searchStart = rel + value.length
    }
  }
  return raw
}

/** 找出所有含完整注音对的 `<ruby>…</ruby>` 元素区域（Go `rubyRegions`）。 */
function rubyRegions(target: string): Region[] {
  const spans = elementSpans(target)
  if (spans.length === 0) {
    return []
  }
  const raw: Region[] = []
  for (const [startU16, endU16] of spans) {
    const start = runeOffset(target, startU16)
    const end = start + runeCount(target.slice(startU16, endU16))
    raw.push([start, end])
  }
  return raw
}

/** 裸标签兜底屏蔽区域（Go `tagRegions`）。 */
function tagRegions(target: string): Region[] {
  const matches = findAllStringIndex(htmlTagRe, target)
  if (matches.length === 0) {
    return []
  }
  const raw: Region[] = []
  for (const [startU16, endU16] of matches) {
    const start = runeOffset(target, startU16)
    const end = start + runeCount(target.slice(startU16, endU16))
    raw.push([start, end])
  }
  return raw
}

/**
 * 返回 `target` 中「Protected 区 ∪ ruby 元素区 ∪ 内联标签区」的 rune 偏移并集
 * （升序、已合并），作为 QA 层统一的内联标记屏蔽出口（Go `InlineMarkupRegions`）。
 */
export function inlineMarkupRegions(
  target: string,
  protectedMap: Record<string, string> | null | undefined,
): Region[] | null {
  const raw: Region[] = []
  if (protectedMap !== null && protectedMap !== undefined) {
    raw.push(...protectedOccurrences(target, protectedMap))
  }
  raw.push(...rubyRegions(target))
  raw.push(...tagRegions(target))
  if (raw.length === 0) {
    return null
  }
  return mergeRegions(raw)
}

/**
 * 对 `regions` 排序并合并重叠区域，返回升序、已合并的并集（Go `mergeRegions`）。
 *
 * 同起点时长区域在前：保证前缀关系（如 `<br>` 与 `<br/>`）中较长区域被保留。
 */
export function mergeRegions(input: readonly Region[]): Region[] | null {
  if (input.length === 0) {
    return null
  }
  const sorted = input.map((r) => [r[0], r[1]] as Region)
  sorted.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : b[1] - a[1]))
  const out: Region[] = []
  for (const r of sorted) {
    if (out.length === 0) {
      out.push(r)
      continue
    }
    const last = out[out.length - 1]!
    if (r[0] >= last[1]) {
      // 不重叠：新增独立区域。
      out.push(r)
    } else if (r[1] > last[1]) {
      // 重叠且向后延伸：扩展为并集，吞并被覆盖的尾部内容。
      last[1] = r[1]
    }
    // 否则被既有区域完全包含，丢弃。
  }
  return out
}

/** 删除 `regions` 覆盖的片段（Go `StripRegions`）；`regions` 为空时原样返回。 */
export function stripRegions(target: string, regions: readonly Region[] | null): string {
  if (regions === null || regions.length === 0) {
    return target
  }
  const runes = Array.from(target)
  const result: string[] = []
  let pos = 0
  for (const [start, end] of regions) {
    if (start > pos) {
      result.push(...runes.slice(pos, start))
    }
    if (end > pos) {
      pos = end
    }
  }
  if (pos < runes.length) {
    result.push(...runes.slice(pos))
  }
  return result.join('')
}

/** 移除 `__LF_*` 占位符并转小写（Go `stripPlaceholders`）。 */
export function stripPlaceholders(s: string): string {
  return stripPlaceholderTokens(s).toLowerCase()
}

/** 移除 `__LF_*` 占位符，保留原大小写（Go `stripPlaceholderTokens`）。 */
export function stripPlaceholderTokens(s: string): string {
  if (!s.includes('__LF_')) {
    return s
  }
  return replaceAllStringFunc(placeholderTokenRe, s, () => '')
}

/** 匹配 `__LF_` 后接字母数字下划线（Go `placeholderRe`）。 */
const placeholderTokenRe = compile('__LF_[A-Za-z0-9_]+')

/**
 * 返回去掉内联标记区域与 `__LF_*` 占位符并小写后的文本，即 checker 判定所用的
 * 「干净文本」（Go `StripProtectedRegions`）。
 */
export function stripProtectedRegions(
  text: string,
  protectedMap: Record<string, string> | null | undefined,
): string {
  return stripPlaceholders(stripRegions(text, inlineMarkupRegions(text, protectedMap)))
}

/**
 * 同 {@link stripProtectedRegions}，但复用已算好的 regions（Go
 * `StripProtectedRegionsWithRegions`），避免热路径重复扫描。
 */
export function stripProtectedRegionsWithRegions(
  text: string,
  regions: readonly Region[] | null,
): string {
  return stripPlaceholders(stripRegions(text, regions))
}

/** 判断 `[start, end)` 是否被任一合并后的保护区覆盖（部分重叠即视为覆盖）。 */
export function regionCovers(
  regions: readonly Region[] | null,
  start: number,
  end: number,
): boolean {
  if (regions === null) return false
  for (const r of regions) {
    if (start < r[1] && end > r[0]) {
      return true
    }
  }
  return false
}

/**
 * 在 `target` 中定位 `matchedText` 的首个「落在保护区之外」的出现（Go
 * `LocateSpanExcludingRegions`）。
 *
 * 全部出现都在保护区内时回退为普通 `LocateSpan` 语义——宁可偏移不准，也不漏报。
 */
export function locateSpanExcludingRegions(
  target: string,
  matchedTextIn: string,
  regions: readonly Region[] | null,
): Span | null {
  // Go `strings.TrimSpace`（注意不是 JS `trim()`：后者多剥 U+FEFF）
  const matchedText = trimSpace(matchedTextIn)
  if (matchedText === '') {
    return null
  }
  const span: Span = { matchedText }
  if (regions === null || regions.length === 0) {
    return locateSpanFull(target, matchedText, span)
  }
  const needle = matchedText
  let searchStart = 0
  while (searchStart <= target.length) {
    const rel = target.indexOf(needle, searchStart)
    if (rel < 0) break
    const start = runeOffset(target, rel)
    const end = start + runeCount(target.slice(rel, rel + needle.length))
    if (!regionCovers(regions, start, end)) {
      span.targetStart = start
      span.targetEnd = end
      return span
    }
    searchStart = rel + needle.length
  }
  // 全部出现都在保护区内：回退为首次出现的偏移（含 equalFold 兜底）。
  return locateSpanFull(target, matchedText, span)
}
