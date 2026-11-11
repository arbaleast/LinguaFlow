/**
 * `punctuation_pairing` checker（对应 Go `checker_punctuation_pairing.go`）。
 *
 * 用栈检测目标语配对标点（引号/括号/书名号等）的未闭合、错嵌套与多余闭合。
 * 对称引号（open === close，如 ASCII `"`）按交替开合处理；撇号不属于任何配对，
 * 因此 `Don't` 不会误报。
 */
import { trimSpace } from '../../ruby'
import { CHECK_PUNCTUATION_PAIRING } from '../codes'
import { glossaryIsCJK } from '../glossary'
import { goQuote, runeText } from './punctuation_common'
import { locateSpanExcludingRegions, stripRegions, inlineMarkupRegions } from '../protect_region'
import { SEVERITY_WARNING, type CheckInput, type Checker, type QualityIssue } from '../types'

/** 一对配对标点（Go `pairDef`，用码点表示 rune）。 */
export interface PairDef {
  open: number
  close: number
}

/** 按目标语选择配对表（Go `punctuationPairsFor`）。 */
export function punctuationPairsFor(lang: string): PairDef[] {
  if (glossaryIsCJK(lang)) {
    return [
      { open: '「'.codePointAt(0)!, close: '」'.codePointAt(0)! },
      { open: '『'.codePointAt(0)!, close: '』'.codePointAt(0)! },
      { open: '【'.codePointAt(0)!, close: '】'.codePointAt(0)! },
      { open: '（'.codePointAt(0)!, close: '）'.codePointAt(0)! },
      { open: '《'.codePointAt(0)!, close: '》'.codePointAt(0)! },
      { open: '〈'.codePointAt(0)!, close: '〉'.codePointAt(0)! },
      { open: '“'.codePointAt(0)!, close: '”'.codePointAt(0)! },
      { open: '‘'.codePointAt(0)!, close: '’'.codePointAt(0)! },
      { open: '('.codePointAt(0)!, close: ')'.codePointAt(0)! },
      { open: '['.codePointAt(0)!, close: ']'.codePointAt(0)! },
      { open: '{'.codePointAt(0)!, close: '}'.codePointAt(0)! },
      { open: '"'.codePointAt(0)!, close: '"'.codePointAt(0)! },
    ]
  }
  return [
    { open: '('.codePointAt(0)!, close: ')'.codePointAt(0)! },
    { open: '['.codePointAt(0)!, close: ']'.codePointAt(0)! },
    { open: '{'.codePointAt(0)!, close: '}'.codePointAt(0)! },
    { open: '“'.codePointAt(0)!, close: '”'.codePointAt(0)! },
    { open: '‘'.codePointAt(0)!, close: '’'.codePointAt(0)! },
    { open: '«'.codePointAt(0)!, close: '»'.codePointAt(0)! },
    { open: '"'.codePointAt(0)!, close: '"'.codePointAt(0)! },
  ]
}

/** 标点配对检测器。 */
export class PunctuationPairingChecker implements Checker {
  private readonly pairs: PairDef[]

  /** 按目标语选择配对表。 */
  constructor(targetLang: string) {
    this.pairs = punctuationPairsFor(targetLang)
  }

  name(): string {
    return CHECK_PUNCTUATION_PAIRING
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
      const problem = findPairingProblem(cleanTgt, this.pairs)
      if (problem.matched !== '') {
        const span = locateSpanExcludingRegions(tgt, problem.matched, regions) ?? {
          matchedText: problem.matched,
        }
        issues.push({
          segmentIndex: seg.index,
          severity: SEVERITY_WARNING,
          code: CHECK_PUNCTUATION_PAIRING,
          message: `标点配对异常：${problem.detail}`,
          span,
          disposition: '',
        })
      }
    }
    return issues
  }
}

/** 配对问题（Go 的 `(matched, detail)` 双返回值）。 */
export interface PairingProblem {
  matched: string
  detail: string
}

/**
 * 用栈检测未匹配或错嵌套的配对标点（Go `findPairingProblem`）。
 *
 * 对称引号（open === close）按交替开合处理。
 */
export function findPairingProblem(text: string, pairs: readonly PairDef[]): PairingProblem {
  const openOf = new Map<number, number>()
  const closeOf = new Map<number, number>()
  const symmetric = new Set<number>()
  for (const p of pairs) {
    if (p.open === p.close) {
      symmetric.add(p.open)
      continue
    }
    openOf.set(p.open, p.close)
    closeOf.set(p.close, p.open)
  }

  interface Frame {
    open: number
    close: number
    sym: boolean
  }
  const stack: Frame[] = []

  for (const ch of text) {
    const r = ch.codePointAt(0) ?? 0
    if (symmetric.has(r)) {
      const top = stack[stack.length - 1]
      if (top !== undefined && top.sym && top.open === r) {
        stack.pop()
      } else {
        stack.push({ open: r, close: r, sym: true })
      }
      continue
    }
    const close = openOf.get(r)
    if (close !== undefined) {
      stack.push({ open: r, close, sym: false })
      continue
    }
    const open = closeOf.get(r)
    if (open !== undefined) {
      if (stack.length === 0) {
        return { matched: ch, detail: `多余的闭合标点 ${goQuote(ch)}` }
      }
      const top = stack[stack.length - 1]!
      if (top.open !== open) {
        return {
          matched: ch,
          detail: `标点错嵌套：期望闭合 ${goQuote(runeText(top.close))}，实际 ${goQuote(ch)}`,
        }
      }
      stack.pop()
    }
  }
  if (stack.length > 0) {
    const top = stack[stack.length - 1]!
    const openText = runeText(top.open)
    return { matched: openText, detail: `未闭合的标点 ${goQuote(openText)}` }
  }
  return { matched: '', detail: '' }
}
