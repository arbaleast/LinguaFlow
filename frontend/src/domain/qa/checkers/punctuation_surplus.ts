/**
 * `punctuation_surplus` checker（对应 Go `checker_punctuation_surplus.go`）。
 *
 * 检测译文整类多出源文不存在的包裹标点。与 `punctuation_missing` 互补：仅源文该类
 * 计数 === 0 且译文该类计数 ≥ 2 时触发；译文 <2 个即不报（失衡交给
 * `punctuation_pairing`），二者互斥无双报。无语言依赖。
 */
import { trimSpace } from '../../ruby'
import { CHECK_PUNCTUATION_SURPLUS } from '../codes'
import { countCategory, firstCategoryRune, PAREN_RUNES, QUOTE_RUNES } from './punctuation_common'
import {
  inlineMarkupRegions,
  locateSpanExcludingRegions,
  stripProtectedRegions,
  stripProtectedRegionsWithRegions,
} from '../protect_region'
import { SEVERITY_WARNING, type CheckInput, type Checker, type QualityIssue } from '../types'

/** 类别定义（与 `punctuation_missing` 共用同一组 rune 集合与顺序）。 */
const PUNCT_SURPLUS_CATEGORIES = [
  { name: '引号', set: QUOTE_RUNES },
  { name: '括号', set: PAREN_RUNES },
] as const

/** 包裹标点整类多余检测器。 */
export class PunctuationSurplusChecker implements Checker {
  name(): string {
    return CHECK_PUNCTUATION_SURPLUS
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
      for (const cat of PUNCT_SURPLUS_CATEGORIES) {
        if (countCategory(cleanSrc, cat.set) !== 0 || countCategory(cleanTgt, cat.set) < 2) {
          continue
        }
        const matched =
          firstCategoryRune(cleanTgt, cat.set, 0) + firstCategoryRune(cleanTgt, cat.set, 1)
        const span = locateSpanExcludingRegions(tgt, matched, regions) ?? { matchedText: matched }
        issues.push({
          segmentIndex: seg.index,
          severity: SEVERITY_WARNING,
          code: CHECK_PUNCTUATION_SURPLUS,
          message: `译文多出源文没有的${cat.name}标点：${matched}`,
          span,
          disposition: '',
        })
      }
    }
    return issues
  }
}
