/**
 * `width_mix` checker（对应 Go `checker_width_mix.go`）。
 *
 * 检测全半角混用：
 * - CJK 目标语中混入零歧义的半角标点（安全集 `! ? , ; : ( ) [ ]`）；
 * - 拉丁目标语中混入全角字符（U+FF01–FF5E，含全角字母数字与标点；排除 FF5F/FF60）。
 *
 * CJK 分支带两类「数字上下文」守卫：
 * - `,` / `:` 左右紧邻均为 ASCII 数字时豁免（`1,000` / `12:30` / `2:1`）；
 * - `!` / `?` 连续 run 前紧邻 ASCII 数字时整个 run 豁免（`5!` / `100!?`）。
 */
import { trimSpace } from '../../ruby'
import { CHECK_WIDTH_MIX } from '../codes'
import { glossaryIsCJK } from '../glossary'
import { goQuote } from './punctuation_common'
import { inlineMarkupRegions, locateSpanExcludingRegions, stripRegions } from '../protect_region'
import { SEVERITY_WARNING, type CheckInput, type Checker, type QualityIssue } from '../types'

/** 全半角混用检测器。 */
export class WidthMixChecker implements Checker {
  private readonly cjkTarget: boolean

  /** 创建全半角混用检测器。 */
  constructor(targetLang: string) {
    this.cjkTarget = glossaryIsCJK(targetLang)
  }

  name(): string {
    return CHECK_WIDTH_MIX
  }

  check(segments: readonly CheckInput[]): QualityIssue[] {
    const issues: QualityIssue[] = []
    for (const seg of segments) {
      const tgt = seg.targetText
      if (trimSpace(tgt) === '') {
        continue
      }
      const regions = inlineMarkupRegions(tgt, seg.protected)
      const cleanTgt = stripRegions(tgt, regions)
      const hit = findWidthMix(cleanTgt, this.cjkTarget)
      if (hit.matched !== '') {
        const span = locateSpanExcludingRegions(tgt, hit.matched, regions) ?? {
          matchedText: hit.matched,
        }
        issues.push({
          segmentIndex: seg.index,
          severity: SEVERITY_WARNING,
          code: CHECK_WIDTH_MIX,
          message: hit.message,
          span,
          disposition: '',
        })
      }
    }
    return issues
  }
}

/** 命中结果（Go 的 `(matched, message)` 双返回值）。 */
export interface WidthMixHit {
  matched: string
  message: string
}

/** 查找首个全半角混用字符（Go `findWidthMix`）。 */
export function findWidthMix(text: string, cjkTarget: boolean): WidthMixHit {
  if (cjkTarget) {
    const runes = Array.from(text, (ch) => ch.codePointAt(0) ?? 0)
    let i = 0
    while (i < runes.length) {
      const r = runes[i]!
      if (!isHalfwidthPunct(r)) {
        i++
        continue
      }
      const ch = String.fromCodePoint(r)
      if (r === 0x2c || r === 0x3a) {
        // 数字双侧守卫：左右紧邻均为 ASCII 数字时豁免（1,000 / 12:30 / 2:1）。
        if (
          i > 0 &&
          i < runes.length - 1 &&
          isASCIIDigit(runes[i - 1]!) &&
          isASCIIDigit(runes[i + 1]!)
        ) {
          i++
          continue
        }
      } else if (r === 0x21 || r === 0x3f) {
        // 数字前缀 run 守卫：!? 连续 run 前紧邻 ASCII 数字时整个 run 豁免（5! / 100!?）。
        let j = i + 1
        while (j < runes.length && (runes[j] === 0x21 || runes[j] === 0x3f)) {
          j++
        }
        if (i > 0 && isASCIIDigit(runes[i - 1]!)) {
          i = j // 跳到 run 结束处
          continue
        }
        return { matched: ch, message: `CJK 译文中混入半角标点：${goQuote(ch)}` }
      }
      return { matched: ch, message: `CJK 译文中混入半角标点：${goQuote(ch)}` }
    }
    return { matched: '', message: '' }
  }
  for (const ch of text) {
    const r = ch.codePointAt(0) ?? 0
    if (isFullwidthChar(r)) {
      return { matched: ch, message: `拉丁译文中混入全角字符：${goQuote(ch)}` }
    }
  }
  return { matched: '', message: '' }
}

/**
 * CJK 译文中零歧义的半角标点安全集：`! ? , ; : ( ) [ ]`（Go `isHalfwidthPunct`）。
 *
 * 半→全转换 +0xFEE0，与 correct 归一化规则共享同一口径。其余半角符号
 * （`. " ' { } @#$%^&*` 等）歧义过大，既不检出也不转换。
 */
export function isHalfwidthPunct(r: number): boolean {
  switch (r) {
    case 0x21: // !
    case 0x3f: // ?
    case 0x2c: // ,
    case 0x3b: // ;
    case 0x3a: // :
    case 0x28: // (
    case 0x29: // )
    case 0x5b: // [
    case 0x5d: // ]
      return true
    default:
      return false
  }
}

/** 判断是否 ASCII 数字 0-9（守卫用；Go `isASCIIDigit`）。 */
export function isASCIIDigit(r: number): boolean {
  return r >= 0x30 && r <= 0x39
}

/**
 * 半角/全角形式区中与 ASCII 一一对应的全角字符（U+FF01–FF5E；Go `isFullwidthChar`）。
 *
 * 含全角字母数字与全角标点；排除 FF5F/FF60（｟｠，无 ASCII 对应）。
 */
export function isFullwidthChar(r: number): boolean {
  return r >= 0xff01 && r <= 0xff5e
}
