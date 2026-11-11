/**
 * `punctuation_wrap_loss` checker（对应 Go `checker_punctuation_wrap_loss.go`）。
 *
 * 检测源文整段被引号包裹而译文丢失外层包裹。与 `punctuation_missing`（整类计数
 * 归零）互补：译文只要新增任意内层引号（如 `「…」`→`…“x”…`）missing 即不触发，
 * 本 checker 按首尾包裹结构对比捕捉该盲区。不做互斥——彻底丢引号时两码可同时报。
 *
 * 单边残留（`「a` / `a」`）仍委派 `punctuation_pairing`。
 */
import { trimSpace } from '../../ruby'
import { CHECK_PUNCTUATION_WRAP_LOSS } from '../codes'
import {
  countCategory,
  firstRuneOf,
  isQuoteRune,
  lastRuneOf,
  runeLenOf,
  runeText,
  DIRECTIONAL_QUOTE_PAIRS,
} from './punctuation_common'
import {
  inlineMarkupRegions,
  locateSpanExcludingRegions,
  stripProtectedRegions,
  stripProtectedRegionsWithRegions,
} from '../protect_region'
import { SEVERITY_WARNING, type CheckInput, type Checker, type QualityIssue } from '../types'

/** 外层包裹丢失检测器。 */
export class PunctuationWrapLossChecker implements Checker {
  name(): string {
    return CHECK_PUNCTUATION_WRAP_LOSS
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
      const cleanTgt = trimSpace(stripProtectedRegionsWithRegions(tgt, regions))
      if (cleanTgt === '') {
        continue
      }
      const wrap = outerQuoteWrap(cleanSrc)
      if (wrap === null) {
        continue
      }
      if (targetEdgesBare(cleanTgt)) {
        const matched = runeText(wrap.open) + runeText(wrap.close)
        const span = locateSpanExcludingRegions(tgt, matched, regions) ?? { matchedText: matched }
        issues.push({
          segmentIndex: seg.index,
          severity: SEVERITY_WARNING,
          code: CHECK_PUNCTUATION_WRAP_LOSS,
          message: `源文整体被引号包裹，译文丢失外层包裹：${matched}`,
          span,
          disposition: '',
        })
      }
    }
    return issues
  }
}

/** 外层包裹（开/闭引号码点）。 */
export interface OuterWrap {
  open: number
  close: number
}

/**
 * 判定 `text`（clean、已 TrimSpace）是否为「单 span 整段引号包裹」（Go `outerQuoteWrap`）。
 *
 * 首 rune 为有向开引号、末 rune 为其配对闭引号、中间有内容、且开闭各恰好出现一次。
 * 多 span（`「你好」「再见」`）与句中引号均返回 `null`。
 */
export function outerQuoteWrap(text: string): OuterWrap | null {
  const first = firstRuneOf(text)
  if (first === null) {
    return null
  }
  const closing = DIRECTIONAL_QUOTE_PAIRS.get(first)
  if (closing === undefined) {
    return null
  }
  const last = lastRuneOf(text)
  if (last === null || last !== closing) {
    return null
  }
  if (runeLenOf(text) <= 2) {
    return null
  }
  if (countCategory(text, new Set([first, last])) !== 2) {
    return null
  }
  return { open: first, close: closing }
}

/**
 * 报告 `text`（clean、已 TrimSpace）首尾两端是否均无任何引号类 rune（Go `targetEdgesBare`）。
 *
 * 首或尾存在任意引号即视为包裹结构保留（含类别替换 `「`→`“`），交由其他 checker 处理失衡。
 */
export function targetEdgesBare(text: string): boolean {
  const first = firstRuneOf(text)
  if (first !== null && isQuoteRune(first)) {
    return false
  }
  const last = lastRuneOf(text)
  if (last !== null && isQuoteRune(last)) {
    return false
  }
  return true
}
