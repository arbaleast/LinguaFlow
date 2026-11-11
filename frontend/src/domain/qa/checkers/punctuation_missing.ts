/**
 * `punctuation_missing` checker（对应 Go `checker_punctuation_missing.go`）。
 *
 * 检测译文整类缺失源文存在的包裹标点（引号类 / 括号类）。与 `punctuation_pairing`
 * 互补：仅译文该类标点计数 === 0 时触发；译文有 ≥1 个即不报（失衡交给 pairing），
 * 二者互斥无双报。无语言依赖。
 */
import { trimSpace } from '../../ruby'
import { isLetter } from '../../shared/unicode'
import { CHECK_PUNCTUATION_MISSING } from '../codes'
import {
  countCategory,
  DIRECTIONAL_QUOTE_PAIRS,
  firstCategoryRune,
  PAREN_RUNES,
  QUOTE_RUNES,
  runeText,
} from './punctuation_common'
import {
  inlineMarkupRegions,
  locateSpanExcludingRegions,
  stripProtectedRegions,
  stripProtectedRegionsWithRegions,
} from '../protect_region'
import { SEVERITY_WARNING, type CheckInput, type Checker, type QualityIssue } from '../types'

/** 一个「包裹标点类别」及其从源文推定配对片段的方式（Go `punctMissingCategory`）。 */
interface PunctMissingCategory {
  name: string
  set: ReadonlySet<number>
  sourcePair: (text: string) => { matched: string; ok: boolean }
}

/** 两个类别：引号类与括号类（顺序决定 issue 顺序）。 */
const PUNCT_MISSING_CATEGORIES: readonly PunctMissingCategory[] = [
  { name: '引号', set: QUOTE_RUNES, sourcePair: firstQuotePair },
  { name: '括号', set: PAREN_RUNES, sourcePair: firstParenPair },
]

/** 包裹标点整类缺失检测器。 */
export class PunctuationMissingChecker implements Checker {
  name(): string {
    return CHECK_PUNCTUATION_MISSING
  }

  check(segments: readonly CheckInput[]): QualityIssue[] {
    const issues: QualityIssue[] = []
    for (const seg of segments) {
      const tgt = seg.targetText
      const src = trimSpace(seg.sourceText)
      if (src === '' || trimSpace(tgt) === '') {
        continue
      }
      const cleanSrc = stripProtectedRegions(src, seg.protected)
      const regions = inlineMarkupRegions(tgt, seg.protected)
      const cleanTgt = stripProtectedRegionsWithRegions(tgt, regions)
      for (const cat of PUNCT_MISSING_CATEGORIES) {
        const sourcePair = cat.sourcePair(cleanSrc)
        if (!sourcePair.ok || countCategory(cleanTgt, cat.set) !== 0) {
          continue
        }
        const matched = sourcePair.matched
        const span = locateSpanExcludingRegions(tgt, matched, regions) ?? { matchedText: matched }
        issues.push({
          segmentIndex: seg.index,
          severity: SEVERITY_WARNING,
          code: CHECK_PUNCTUATION_MISSING,
          message: `译文缺失源文的${cat.name}标点：${matched}`,
          span,
          disposition: '',
        })
      }
    }
    return issues
  }
}

/**
 * 从源文推定首个引号配对片段（Go `firstQuotePair`）。
 *
 * 撇号（`’`）夹在两个字母之间时按法语省音处理，跳过不计——否则整段法语散文会被
 * 判成「引号类缺失」。返回开+闭两个 rune（ASCII `"` 对称处理）。
 */
export function firstQuotePair(text: string): { matched: string; ok: boolean } {
  interface QuoteFrame {
    open: number
    close: number
    symmetric: boolean
  }
  const runes = Array.from(text)
  const stack: QuoteFrame[] = []
  for (let i = 0; i < runes.length; i++) {
    const ch = runes[i]!
    const r = ch.codePointAt(0) ?? 0
    if (
      r === '’'.codePointAt(0) &&
      i > 0 &&
      i + 1 < runes.length &&
      isLetter(runes[i - 1]!.codePointAt(0) ?? 0) &&
      isLetter(runes[i + 1]!.codePointAt(0) ?? 0)
    ) {
      continue
    }

    if (r === '"'.codePointAt(0)) {
      const top = stack[stack.length - 1]
      if (top !== undefined && top.symmetric) {
        stack.pop()
        return { matched: '""', ok: true }
      }
      stack.push({ open: r, close: r, symmetric: true })
      continue
    }

    const close = DIRECTIONAL_QUOTE_PAIRS.get(r)
    if (close !== undefined) {
      stack.push({ open: r, close, symmetric: false })
      continue
    }
    const top = stack[stack.length - 1]
    if (top === undefined || top.close !== r) {
      continue
    }
    const open = top.open
    stack.pop()
    return { matched: runeText(open) + ch, ok: true }
  }
  return { matched: '', ok: false }
}

/**
 * 源文括号类标点 ≥2 时取首现（0）+次现（1）拼成 matched（Go `firstParenPair`）。
 *
 * 源文推定良构，故通常为开+闭；对称 rune 亦成立。
 */
export function firstParenPair(text: string): { matched: string; ok: boolean } {
  if (countCategory(text, PAREN_RUNES) < 2) {
    return { matched: '', ok: false }
  }
  return {
    matched: firstCategoryRune(text, PAREN_RUNES, 0) + firstCategoryRune(text, PAREN_RUNES, 1),
    ok: true,
  }
}
