/**
 * `whitespace_irregular` / `repeated_space` checkers（对应 Go `checker_whitespace.go`）。
 *
 * - 异常空白：零宽字符、NBSP、tab、行/段落分隔符、全角空格，以及行内非普通空格。
 *   普通首尾 trim 差异不报（由 postprocess 负责）。
 * - 连续空格：连续 ASCII 空格；CJK 目标语下还包括两个 CJK 字符之间的单个空格。
 *   在原串上检测后过滤保护区内命中——**不用** `stripRegions`：拼接非保护区片段会在
 *   边界处制造原文不存在的连续空格 / CJK 间空格。
 */
import { trimSpace } from '../../ruby'
import { compile, matchString } from '../../shared/re2'
import { isCJK, isSpace } from '../../shared/unicode'
import { CHECK_REPEATED_SPACE, CHECK_WHITESPACE_IRREGULAR } from '../codes'
import { glossaryIsCJK } from '../glossary'
import {
  inlineMarkupRegions,
  locateSpanExcludingRegions,
  regionCovers,
  stripRegions,
} from '../protect_region'
import { SEVERITY_WARNING, type CheckInput, type Checker, type QualityIssue } from '../types'

/** 匹配 Unicode 格式字符（Go `unicode.Cf`）。 */
const CF_RE = compile('\\p{Cf}')

/** 异常空白字符检测器。 */
export class WhitespaceIrregularChecker implements Checker {
  name(): string {
    return CHECK_WHITESPACE_IRREGULAR
  }

  check(segments: readonly CheckInput[]): QualityIssue[] {
    const issues: QualityIssue[] = []
    for (const seg of segments) {
      const tgt = seg.targetText
      if (tgt === '') {
        continue
      }
      const regions = inlineMarkupRegions(tgt, seg.protected)
      const cleanTgt = stripRegions(tgt, regions)
      const hit = findIrregularWhitespace(cleanTgt)
      if (hit !== '') {
        const span = locateSpanExcludingRegions(tgt, hit, regions) ?? { matchedText: hit }
        issues.push({
          segmentIndex: seg.index,
          severity: SEVERITY_WARNING,
          code: CHECK_WHITESPACE_IRREGULAR,
          message: `存在异常空白字符：${describeWhitespace(hit)}`,
          span,
          disposition: '',
        })
      }
    }
    return issues
  }
}

/** 返回首个异常空白字符；无异常返回空串（Go `findIrregularWhitespace`）。 */
export function findIrregularWhitespace(s: string): string {
  for (const ch of s) {
    const r = ch.codePointAt(0) ?? 0
    switch (r) {
      case 0x200b: // ZWSP
      case 0x200c: // ZWNJ
      case 0x200d: // ZWJ
      case 0xfeff: // BOM
      case 0x00a0: // NBSP
      case 0x09: // TAB
      case 0x2028: // LINE SEPARATOR
      case 0x2029: // PARAGRAPH SEPARATOR
      case 0x3000: // IDEOGRAPHIC SPACE
        return ch
      default:
        break
    }
    if (matchString(CF_RE, ch) && isSpace(r)) {
      return ch
    }
  }
  // 行内连续非普通空格的空白 run（排除纯首尾 trim）
  const trimmed = trimSpace(s)
  if (trimmed === '') {
    return ''
  }
  const start = s.indexOf(trimmed)
  if (start < 0) {
    return ''
  }
  const inner = s.slice(start, start + trimmed.length)
  for (const ch of inner) {
    const r = ch.codePointAt(0) ?? 0
    if (r === 0x0a || r === 0x0d) {
      continue
    }
    if (isSpace(r) && r !== 0x20) {
      return ch
    }
  }
  return ''
}

/** 描述异常空白字符（Go `describeWhitespace`）。 */
export function describeWhitespace(s: string): string {
  if (s === '') {
    return ''
  }
  const r = s.codePointAt(0) ?? 0
  switch (r) {
    case 0x200b:
      return '零宽空格 (U+200B)'
    case 0x200c:
      return '零宽非连接符 (U+200C)'
    case 0x200d:
      return '零宽连接符 (U+200D)'
    case 0xfeff:
      return 'BOM (U+FEFF)'
    case 0x00a0:
      return '不间断空格 (NBSP)'
    case 0x09:
      return '制表符'
    case 0x3000:
      return '全角空格'
    default:
      return `U+${r.toString(16).toUpperCase().padStart(4, '0')}`
  }
}

/** 连续空格 / CJK 间空格检测器。 */
export class RepeatedSpaceChecker implements Checker {
  private readonly cjkTarget: boolean

  /** 创建连续空格检测器。 */
  constructor(targetLang: string) {
    this.cjkTarget = glossaryIsCJK(targetLang)
  }

  name(): string {
    return CHECK_REPEATED_SPACE
  }

  check(segments: readonly CheckInput[]): QualityIssue[] {
    const issues: QualityIssue[] = []
    for (const seg of segments) {
      const tgt = seg.targetText
      if (tgt === '') {
        continue
      }
      // 在原串上检测，再过滤掉落在保护区内的命中。
      const regions = inlineMarkupRegions(tgt, seg.protected)
      for (const m of findRepeatedSpaceAll(tgt, this.cjkTarget)) {
        if (regionCovers(regions, m.start, m.end)) {
          continue
        }
        issues.push({
          segmentIndex: seg.index,
          severity: SEVERITY_WARNING,
          code: CHECK_REPEATED_SPACE,
          message: '存在连续空格或 CJK 字符间多余空格',
          span: { matchedText: m.text, targetStart: m.start, targetEnd: m.end },
          disposition: '',
        })
      }
    }
    return issues
  }
}

/** 连续空格命中（`start` / `end` 为 rune 偏移）。 */
export interface RepeatedSpaceMatch {
  text: string
  start: number
  end: number
}

/**
 * 返回原串中所有连续空格 / CJK 字符间空格的命中（rune 偏移；Go `findRepeatedSpaceAll`）。
 */
export function findRepeatedSpaceAll(s: string, cjkTarget: boolean): RepeatedSpaceMatch[] {
  const out: RepeatedSpaceMatch[] = []
  const runes = Array.from(s, (ch) => ch.codePointAt(0) ?? 0)
  let i = 0
  while (i < runes.length) {
    if (runes[i] !== 0x20) {
      i++
      continue
    }
    const start = i
    while (i < runes.length && runes[i] === 0x20) {
      i++
    }
    if (i - start >= 2) {
      out.push({ text: runeSliceText(runes, start, i), start, end: i })
    }
  }
  if (!cjkTarget) {
    return out
  }
  for (let j = 0; j + 2 < runes.length; j++) {
    if (isCJK(runes[j]!) && runes[j + 1] === 0x20 && isCJK(runes[j + 2]!)) {
      out.push({ text: runeSliceText(runes, j, j + 3), start: j, end: j + 3 })
    }
  }
  return out
}

/** 码点数组片段转字符串。 */
function runeSliceText(runes: readonly number[], start: number, end: number): string {
  return runes
    .slice(start, end)
    .map((cp) => String.fromCodePoint(cp))
    .join('')
}
