/**
 * 三条白名单机械纠错规则（对应 Go `backend/internal/correct/rule_*.go`）。
 *
 * 规则只读段落、不修改入参；改写结果通过 `CorrectionResult.newTarget` 返回，
 * 由调用方决定是否回写。触发条件统一为「存在 pending（未 dismissed）的 issue」。
 */
import { isSpace } from '../shared/unicode'
import { inlineMarkupRegions, runeInRegions, stripProtectedRegions } from './inline'
import {
  CHECK_PUNCTUATION_MISSING,
  CHECK_PUNCTUATION_WRAP_LOSS,
  CHECK_WIDTH_MIX,
  emptyCorrectionResult,
  RULE_PUNCTUATION_MISSING_WRAP,
  RULE_PUNCTUATION_WRAP_LOSS_WRAP,
  RULE_WIDTH_MIX_NORMALIZE,
  type CorrectRule,
  type CorrectableSegment,
  type CorrectionResult,
  type QualityIssue,
} from './types'

/** 有向配对引号映射（对称的 `"` 被刻意排除：它没有开/闭方向）。 */
const QUOTE_PAIRS = new Map<string, string>([
  ['「', '」'],
  ['『', '』'],
  ['“', '”'],
  ['‘', '’'],
  ['«', '»'],
])

/** 译文边缘会阻断包裹的全部引号 rune（镜像 `qa.quoteRunes`）。 */
const EDGE_QUOTE_RUNES = new Set(['「', '」', '『', '』', '“', '”', '‘', '’', '«', '»', '"'])

/** 源文边界守卫失败时的共用拒绝原因。 */
const REASON_SOURCE_QUOTES_INSIDE_MARKUP =
  'source quotes sit inside protected markup; skip to avoid inverting structure'

/** 报告 issues 中是否存在指定 code 且未被裁决为 dismissed 的 issue。 */
function hasPendingIssueCode(issues: readonly QualityIssue[], code: string): boolean {
  return issues.some((iss) => iss.code === code && iss.disposition !== 'dismissed')
}

/** Go `strings.TrimSpace` 等价实现（不吞 U+FEFF，与 JS `trim()` 不同）。 */
export function trimSpace(s: string): string {
  const runes = Array.from(s)
  let start = 0
  let end = runes.length
  while (start < end && isSpace(runes[start]!.codePointAt(0) ?? 0)) start++
  while (end > start && isSpace(runes[end - 1]!.codePointAt(0) ?? 0)) end--
  return runes.slice(start, end).join('')
}

/** 返回首个 rune 与是否存在（Go `firstRune`）。 */
function firstRune(s: string): { r: string; ok: boolean } {
  for (const r of s) return { r, ok: true }
  return { r: '', ok: false }
}

/** 返回末个 rune 与是否存在（Go `lastRune`）。 */
function lastRune(s: string): { r: string; ok: boolean } {
  let last = ''
  let seen = false
  for (const r of s) {
    last = r
    seen = true
  }
  return { r: last, ok: seen }
}

/** 统计 rune 出现次数（Go `countRune`）。 */
function countRune(s: string, r: string): number {
  let n = 0
  for (const c of s) {
    if (c === r) n++
  }
  return n
}

/** rune 数量（Go `runeLen` / `utf8.RuneCountInString`）。 */
function runeLen(s: string): number {
  let n = 0
  for (const _ of s) n++
  return n
}

/**
 * 源文经 TrimSpace 后是否以 open 开头、close 结尾。
 *
 * 内联标记被 `stripProtectedRegions` 视为透明：`<b>「你好」</b>` 剥离后仍是单一
 * 包裹 span，但直接包裹原始译文会把引号放到标记之外、与源文结构相反。
 */
function sourceQuotesAtRawEdges(source: string, open: string, close: string): boolean {
  const rawSrc = trimSpace(source)
  return rawSrc.startsWith(open) && rawSrc.endsWith(close)
}

/** 解析源文的外层有向引号对；不满足条件时返回 reason。 */
function resolveSourceQuotePair(
  seg: CorrectableSegment,
  reportEmptySource: boolean,
): { open: string; close: string } | { reason: string } {
  const cleanSrc = trimSpace(stripProtectedRegions(seg.source, seg.protected))
  const first = firstRune(cleanSrc)
  if (!first.ok) {
    return {
      reason: reportEmptySource
        ? 'empty source'
        : 'source does not start with a paired opening quote',
    }
  }
  const close = QUOTE_PAIRS.get(first.r)
  if (close === undefined) {
    return { reason: 'source does not start with a paired opening quote' }
  }
  const last = lastRune(cleanSrc)
  if (!last.ok || last.r !== close) {
    return { reason: 'source does not end with the matching closing quote' }
  }
  if (runeLen(cleanSrc) <= 2) {
    return { reason: 'source has no content between the quotes' }
  }
  if (countRune(cleanSrc, first.r) !== 1 || countRune(cleanSrc, close) !== 1) {
    return { reason: 'multi-span source, cannot safely whole-wrap' }
  }
  return { open: first.r, close }
}

/**
 * `punctuation_missing_wrap`：机械补回译文丢失的源文外层配对引号。
 *
 * 仅当段落携带 `punctuation_missing` pending issue、源文为单一引号包裹 span、
 * 且译文完全不含这对引号 rune 时生效。多 span 源文保持不变。
 */
export class PunctuationMissingWrapRule implements CorrectRule {
  name(): string {
    return RULE_PUNCTUATION_MISSING_WRAP
  }

  resolvedCodes(): string[] {
    return [CHECK_PUNCTUATION_MISSING]
  }

  apply(seg: CorrectableSegment): CorrectionResult {
    if (!hasPendingIssueCode(seg.issues, CHECK_PUNCTUATION_MISSING)) {
      return { ...emptyCorrectionResult(), reason: 'no punctuation_missing issue' }
    }
    const pair = resolveSourceQuotePair(seg, true)
    if ('reason' in pair) {
      return { ...emptyCorrectionResult(), reason: pair.reason }
    }
    const cleanTgt = trimSpace(stripProtectedRegions(seg.target, seg.protected))
    if (countRune(cleanTgt, pair.open) !== 0 || countRune(cleanTgt, pair.close) !== 0) {
      return { ...emptyCorrectionResult(), reason: 'target already contains the quote runes' }
    }
    if (!sourceQuotesAtRawEdges(seg.source, pair.open, pair.close)) {
      return { ...emptyCorrectionResult(), reason: REASON_SOURCE_QUOTES_INSIDE_MARKUP }
    }
    return {
      changed: true,
      newTarget: pair.open + seg.target + pair.close,
      op: 'punctuation_missing.wrap',
      resolvedCodes: [CHECK_PUNCTUATION_MISSING],
      reason: '',
    }
  }
}

/** 译文真实外缘是否已有引号 rune（内部引号不阻断外层包裹）。 */
function targetHasEdgeQuoteRune(text: string): boolean {
  const first = firstRune(text)
  if (first.ok && EDGE_QUOTE_RUNES.has(first.r)) {
    return true
  }
  const last = lastRune(text)
  if (!last.ok || !EDGE_QUOTE_RUNES.has(last.r)) {
    return false
  }
  // 末尾闭引号若其配对开引号在译文前部出现过，属内层引号；否则视为外缘引号。
  for (const [open, close] of QUOTE_PAIRS) {
    if (close !== last.r) continue
    if (countRune(text, open) > 0) return false
  }
  return true
}

/** 每对有向引号开/闭计数是否相等，且 ASCII `"` 出现偶数次。 */
function interiorQuotesBalanced(text: string): boolean {
  for (const [open, close] of QUOTE_PAIRS) {
    if (countRune(text, open) !== countRune(text, close)) return false
  }
  return countRune(text, '"') % 2 === 0
}

/**
 * `punctuation_wrap_loss_wrap`：机械恢复译文丢失的源文外层配对引号。
 *
 * 译文边缘已有的引号 rune 保持不动；内部引号失衡时拒绝包裹以避免加剧嵌套混乱。
 */
export class PunctuationWrapLossWrapRule implements CorrectRule {
  name(): string {
    return RULE_PUNCTUATION_WRAP_LOSS_WRAP
  }

  resolvedCodes(): string[] {
    return [CHECK_PUNCTUATION_WRAP_LOSS]
  }

  apply(seg: CorrectableSegment): CorrectionResult {
    if (!hasPendingIssueCode(seg.issues, CHECK_PUNCTUATION_WRAP_LOSS)) {
      return { ...emptyCorrectionResult(), reason: 'no punctuation_wrap_loss issue' }
    }
    const pair = resolveSourceQuotePair(seg, false)
    if ('reason' in pair) {
      return { ...emptyCorrectionResult(), reason: pair.reason }
    }
    const cleanTgt = trimSpace(stripProtectedRegions(seg.target, seg.protected))
    if (targetHasEdgeQuoteRune(cleanTgt)) {
      return { ...emptyCorrectionResult(), reason: 'target edge already has quote runes' }
    }
    if (!sourceQuotesAtRawEdges(seg.source, pair.open, pair.close)) {
      return { ...emptyCorrectionResult(), reason: REASON_SOURCE_QUOTES_INSIDE_MARKUP }
    }
    if (!interiorQuotesBalanced(cleanTgt)) {
      return { ...emptyCorrectionResult(), reason: 'target has unbalanced interior quotes' }
    }
    return {
      changed: true,
      newTarget: pair.open + seg.target + pair.close,
      op: 'punctuation_wrap_loss.wrap',
      resolvedCodes: [CHECK_PUNCTUATION_WRAP_LOSS],
      reason: '',
    }
  }
}

/** 零歧义半角标点 → 全角（+0xFEE0）。 */
function halfToFull(r: string): string | null {
  switch (r) {
    case '!':
    case '?':
    case ',':
    case ';':
    case ':':
    case '(':
    case ')':
    case '[':
    case ']':
      return String.fromCodePoint((r.codePointAt(0) ?? 0) + 0xfee0)
    default:
      return null
  }
}

/** U+FF01–U+FF5E 全角字符 → 半角（-0xFEE0）。 */
function fullToHalf(r: string): string | null {
  const cp = r.codePointAt(0) ?? 0
  if (cp >= 0xff01 && cp <= 0xff5e) return String.fromCodePoint(cp - 0xfee0)
  return null
}

/** 是否为 ASCII 十进制数字（守卫只认 0-9）。 */
function isAsciiDigit(r: string): boolean {
  return r >= '0' && r <= '9'
}

/** 数字双侧守卫：左右紧邻均为 ASCII 数字时豁免（保留 1,000 / 12:30）。 */
function digitFlankedBoth(clean: readonly string[], i: number): boolean {
  return (
    i > 0 &&
    i < clean.length - 1 &&
    isAsciiDigit(clean[i - 1] as string) &&
    isAsciiDigit(clean[i + 1] as string)
  )
}

/**
 * 数字前缀 run 守卫：`clean[i]`（必为 `!` 或 `?`）起最大连续 `!?` run 若紧邻
 * ASCII 数字前缀则整体豁免。
 */
function digitPrefixedRunExempt(
  clean: readonly string[],
  i: number,
): { exempt: boolean; skipTo: number } {
  let j = i + 1
  while (j < clean.length && (clean[j] === '!' || clean[j] === '?')) j++
  if (i > 0 && isAsciiDigit(clean[i - 1] as string)) {
    return { exempt: true, skipTo: j }
  }
  return { exempt: false, skipTo: i + 1 }
}

/** 在 clean 上扫描半角标点并施加两类数字守卫，命中写入原文 rune 下标。 */
function rewriteCjkHalfPunct(
  clean: readonly string[],
  origIdx: readonly number[],
  rewrites: Map<number, string>,
): void {
  for (let i = 0; i < clean.length;) {
    const r = clean[i] as string
    const full = halfToFull(r)
    if (full === null) {
      i++
      continue
    }
    if ((r === ',' || r === ':') && digitFlankedBoth(clean, i)) {
      i++
    } else if (r === '!' || r === '?') {
      const { exempt, skipTo } = digitPrefixedRunExempt(clean, i)
      if (exempt) {
        i = skipTo
        continue
      }
      rewrites.set(origIdx[i] as number, full)
      i++
    } else {
      rewrites.set(origIdx[i] as number, full)
      i++
    }
  }
}

/**
 * 从首条 pending width_mix issue 的 Span.MatchedText 首 rune 反推改写方向。
 *
 * 半角安全集 → CJK 译文；FF01–FF5E → 拉丁译文。span 缺失 / 空 / 首 rune 不属
 * 任一集合时返回 ok=false——宁可放弃修复也绝不猜方向。
 */
function inferWidthMixDirection(issues: readonly QualityIssue[]): { cjk: boolean; ok: boolean } {
  for (const iss of issues) {
    if (iss.code !== CHECK_WIDTH_MIX || iss.disposition === 'dismissed') continue
    const matched = iss.span?.matchedText ?? ''
    if (iss.span === undefined || iss.span === null || matched === '') {
      return { cjk: false, ok: false }
    }
    const first = firstRune(matched)
    if (halfToFull(first.r) !== null) return { cjk: true, ok: true }
    if (fullToHalf(first.r) !== null) return { cjk: false, ok: true }
    return { cjk: false, ok: false }
  }
  return { cjk: false, ok: false }
}

/**
 * `width_mix_normalize`：机械修复 width_mix 报出的全半角混用。
 *
 * CJK 译文：零歧义半角标点（`! ? , ; : ( ) [ ]`）转全角，数字双侧的 `, :` 与
 * 数字前缀的 `!?` run 豁免。拉丁译文：U+FF01–U+FF5E 转回半角。守卫判定基准统一为
 * clean 文本，命中经平行 `origIdx` 回写原文副本，保护区内容逐字保留。
 */
export class WidthMixNormalizeRule implements CorrectRule {
  name(): string {
    return RULE_WIDTH_MIX_NORMALIZE
  }

  resolvedCodes(): string[] {
    return [CHECK_WIDTH_MIX]
  }

  apply(seg: CorrectableSegment): CorrectionResult {
    if (!hasPendingIssueCode(seg.issues, CHECK_WIDTH_MIX)) {
      return { ...emptyCorrectionResult(), reason: 'no width_mix issue' }
    }
    const direction = inferWidthMixDirection(seg.issues)
    if (!direction.ok) {
      return {
        ...emptyCorrectionResult(),
        reason: 'width_mix issue span unreadable, cannot infer direction',
      }
    }
    const runes = Array.from(seg.target)
    const regions = inlineMarkupRegions(seg.target, seg.protected)
    const clean: string[] = []
    const origIdx: number[] = []
    for (let i = 0; i < runes.length; i++) {
      if (runeInRegions(regions, i)) continue
      clean.push(runes[i] as string)
      origIdx.push(i)
    }
    const rewrites = new Map<number, string>()
    if (direction.cjk) {
      rewriteCjkHalfPunct(clean, origIdx, rewrites)
    } else {
      for (let i = 0; i < clean.length; i++) {
        const half = fullToHalf(clean[i] as string)
        if (half !== null) rewrites.set(origIdx[i] as number, half)
      }
    }
    if (rewrites.size === 0) {
      return {
        ...emptyCorrectionResult(),
        reason: 'no convertible width char outside protected regions',
      }
    }
    const out = [...runes]
    for (const [idx, nr] of rewrites) out[idx] = nr
    return {
      changed: true,
      newTarget: out.join(''),
      op: 'width_mix.normalize',
      resolvedCodes: [CHECK_WIDTH_MIX],
      reason: '',
    }
  }
}

/** 全部内置规则名（canonical 顺序）。 */
export function allRuleNames(): string[] {
  return [RULE_PUNCTUATION_MISSING_WRAP, RULE_PUNCTUATION_WRAP_LOSS_WRAP, RULE_WIDTH_MIX_NORMALIZE]
}

/** 按规则名创建规则实例；未知名字返回 `null`（白名单过滤）。 */
export function ruleByName(name: string): CorrectRule | null {
  switch (name) {
    case RULE_PUNCTUATION_MISSING_WRAP:
      return new PunctuationMissingWrapRule()
    case RULE_PUNCTUATION_WRAP_LOSS_WRAP:
      return new PunctuationWrapLossWrapRule()
    case RULE_WIDTH_MIX_NORMALIZE:
      return new WidthMixNormalizeRule()
    default:
      return null
  }
}
