/**
 * `number_mismatch` checker（对应 Go `checker_number.go`）。
 *
 * 检测源/译阿拉伯数字 token 多重集合是否一致。归一化千分位/小数分隔符后比对；
 * v1 不做 CJK 数字换算（「三」与「3」不互相折算）。
 */
import { trimSpace } from '../../ruby'
import { compile, findAllStringIndex } from '../../shared/re2'
import { isDigit, sliceRunes } from '../../shared/unicode'
import { CHECK_NUMBER_MISMATCH } from '../codes'
import { SEVERITY_WARNING, type CheckInput, type Checker, type QualityIssue } from '../types'

/** 匹配含阿拉伯数字的 token：允许内部 `,` / `.` 作为千分位/小数分隔（Go `numberTokenRe`）。 */
const numberTokenRe = compile('[0-9]+(?:[.,][0-9]+)*')

/** 数字守恒检测器。 */
export class NumberMismatchChecker implements Checker {
  name(): string {
    return CHECK_NUMBER_MISMATCH
  }

  check(segments: readonly CheckInput[]): QualityIssue[] {
    const issues: QualityIssue[] = []
    for (const seg of segments) {
      const src = seg.sourceText
      const tgt = seg.targetText
      if (trimSpace(src) === '' || trimSpace(tgt) === '') {
        continue
      }
      const srcNums = extractNormalizedNumbers(src)
      const tgtNums = extractNormalizedNumbers(tgt)
      if (multisetEqual(srcNums, tgtNums)) {
        continue
      }
      issues.push({
        segmentIndex: seg.index,
        severity: SEVERITY_WARNING,
        code: CHECK_NUMBER_MISMATCH,
        message: `数字不一致：原文 ${formatStringSlice(displayNumbers(src))}，译文 ${formatStringSlice(displayNumbers(tgt))}`,
        disposition: '',
      })
    }
    return issues
  }
}

/** 提取并归一化全部数字 token 的多重集合（Go `extractNormalizedNumbers`）。 */
export function extractNormalizedNumbers(text: string): Map<string, number> {
  const normalized = normalizeNumberWidth(text)
  const counts = new Map<string, number>()
  for (const [start, end] of findAllStringIndex(numberTokenRe, normalized)) {
    const raw = normalized.slice(start, end)
    const norm = normalizeNumberToken(raw)
    if (norm === '') {
      continue
    }
    counts.set(norm, (counts.get(norm) ?? 0) + 1)
  }
  return counts
}

/**
 * 容忍千分位逗号/点与小数点/逗号互换（Go `normalizeNumberToken`）。
 *
 * 策略：若只有一个分隔符且其后位数不是 3 的整数倍惯例，优先视为小数；
 * 简化实现——去掉所有 thousand-like 分组后保留最后一个小数分隔符。
 */
export function normalizeNumberToken(raw: string): string {
  if (raw === '') {
    return ''
  }
  // 仅数字直接返回
  let onlyDigits = true
  for (const ch of raw) {
    if (!isDigit(ch.codePointAt(0) ?? 0)) {
      onlyDigits = false
      break
    }
  }
  if (onlyDigits) {
    return raw
  }

  // 收集数字与分隔符位置
  const digits: string[] = []
  const seps: Array<{ pos: number; ch: string }> = []
  let digitCount = 0
  for (const ch of raw) {
    const r = ch.codePointAt(0) ?? 0
    if (isDigit(r)) {
      digits.push(ch)
      digitCount++
      continue
    }
    if (r === 0x2e || r === 0x2c) {
      seps.push({ pos: digitCount, ch })
    }
  }
  const d = digits.join('')
  if (seps.length === 0) {
    return d
  }

  // 判定最后一个分隔符是否为小数分隔符：其后数字位数不为 3，或只有一个分隔符且后位数 < 3
  const last = seps[seps.length - 1]!
  const afterLast = digitCount - last.pos
  const isDecimal = afterLast > 0 && afterLast !== 3
  // 多个分隔符时，若全部后段为 3 位则全是千分位
  let allThousands = true
  for (let i = 0; i < seps.length; i++) {
    const s = seps[i]!
    const after = i + 1 < seps.length ? seps[i + 1]!.pos - s.pos : digitCount - s.pos
    if (after !== 3) {
      allThousands = false
      break
    }
  }
  if (allThousands) {
    return d
  }
  if (isDecimal || afterLast !== 3) {
    // 整数部分 = last.pos 位，小数 = 其余（d 已是纯数字）
    const intPart = sliceRunes(d, 0, last.pos)
    const frac = sliceRunes(d, last.pos)
    if (frac === '') {
      return intPart
    }
    return `${intPart}.${frac}`
  }
  return d
}

/** 比较两个多重集合（Go `multisetEqual`）。 */
export function multisetEqual(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
): boolean {
  if (a.size !== b.size) {
    return false
  }
  for (const [k, v] of a) {
    if (b.get(k) !== v) {
      return false
    }
  }
  return true
}

/** 按原文顺序列出数字 token（未归一化；Go `displayNumbers`）。 */
export function displayNumbers(text: string): string[] {
  const normalized = normalizeNumberWidth(text)
  return findAllStringIndex(numberTokenRe, normalized).map(([start, end]) =>
    normalized.slice(start, end),
  )
}

/**
 * 将全角数字与全角小数点/千分位逗号转为半角（Go `normalizeNumberWidth`）。
 *
 * 仅用于数字守恒比较，不修改外部文本。
 */
export function normalizeNumberWidth(text: string): string {
  const out: string[] = []
  for (const ch of text) {
    const r = ch.codePointAt(0) ?? 0
    if (r >= 0xff10 && r <= 0xff19) {
      out.push(String.fromCharCode(r - 0xff10 + 0x30))
    } else if (r === 0xff0e) {
      out.push('.')
    } else if (r === 0xff0c) {
      out.push(',')
    } else {
      out.push(ch)
    }
  }
  return out.join('')
}

/**
 * 等价 Go `fmt.Sprintf("%v", []string)`。
 *
 * Go 打印切片为 `[a b c]`（空格分隔、无引号）；nil / 空切片为 `[]`。
 */
export function formatStringSlice(items: readonly string[]): string {
  return `[${items.join(' ')}]`
}
