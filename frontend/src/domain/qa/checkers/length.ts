/**
 * `length_ratio` checker（对应 Go `checker_length.go`）。
 *
 * 检测译文长度比异常。计长前两侧统一走 `ruby.stripRubyTags` 剥为「基底文本」，
 * 与注音提取/还原的实际形态对齐，避免注音字符虚增长度导致误报。
 */
import { stripRubyTags } from '../../ruby'
import { isCJK, isSpace } from '../../shared/unicode'
import { CHECK_LENGTH_RATIO } from '../codes'
import {
  LENGTH_METHOD_CHAR_WEIGHT,
  LENGTH_METHOD_WORD_COUNT,
  SEVERITY_WARNING,
  type CheckInput,
  type Checker,
  type LengthMethod,
  type QualityIssue,
} from '../types'

/**
 * 等价 Go `fmt.Sprintf("%.<digits>f", value)`。
 *
 * Go 的 `strconv` 使用**round half to even**且基于二进制真值；JS `toFixed` 是
 * round half away from zero，在 `.5` 边界上会与 Go 相差 1 个末位。`Intl.NumberFormat`
 * 的 `roundingMode: 'halfEven'` 与 Go 一致。
 */
export function formatFixedGo(value: number, digits: number): string {
  // `roundingMode` 属 ES2023 的 Intl 扩展，TS 内置 lib 尚未声明（运行时 Node 20+/现代浏览器支持）。
  const options = {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false,
    roundingMode: 'halfEven',
  } as unknown as Intl.NumberFormatOptions
  return new Intl.NumberFormat('en-US', options).format(value)
}

/** 译文长度比检测器。 */
export class LengthRatioChecker implements Checker {
  private readonly minRatio: number
  private readonly maxRatio: number
  private readonly method: LengthMethod

  /**
   * 创建长度比检测器。
   * `minRatio=0` 表示禁用过短检测，`maxRatio=0` 表示禁用过长检测。
   * 负值视为配置错误，回退为默认值（minRatio=0.2, maxRatio=3.0）。
   */
  constructor(minRatio: number, maxRatio: number, method: LengthMethod) {
    let min = minRatio
    let max = maxRatio
    if (min < 0) {
      min = 0.2
    }
    if (max < 0) {
      max = 3.0
    }
    if (max === 0) {
      max = Number.POSITIVE_INFINITY
    }
    this.minRatio = min
    this.maxRatio = max
    this.method = method === '' ? LENGTH_METHOD_CHAR_WEIGHT : method
  }

  name(): string {
    return CHECK_LENGTH_RATIO
  }

  check(segments: readonly CheckInput[]): QualityIssue[] {
    const issues: QualityIssue[] = []
    for (const seg of segments) {
      // 长度检测在源文（提取时已剥离）与译文（还原后含标签）之间必须基于相同形态比较。
      const src = stripRubyTags(seg.sourceText)
      const tgt = stripRubyTags(seg.targetText)
      if (src === '' || tgt === '') {
        continue
      }
      const srcLen = this.measure(src)
      if (srcLen < 5) {
        continue
      }
      const tgtLen = this.measure(tgt)
      const ratio = tgtLen / srcLen
      if (ratio < this.minRatio) {
        issues.push({
          segmentIndex: seg.index,
          severity: SEVERITY_WARNING,
          code: CHECK_LENGTH_RATIO,
          message: `译文过短 (${formatFixedGo(ratio * 100, 1)}%)，长度比 ${formatFixedGo(ratio, 2)}`,
          disposition: '',
        })
      } else if (ratio > this.maxRatio) {
        issues.push({
          segmentIndex: seg.index,
          severity: SEVERITY_WARNING,
          code: CHECK_LENGTH_RATIO,
          message: `译文过长 (${formatFixedGo(ratio * 100, 0)}%)，长度比 ${formatFixedGo(ratio, 2)}`,
          disposition: '',
        })
      }
    }
    return issues
  }

  /** 根据配置的计数方式计算文本长度（Go `measure`）。 */
  private measure(text: string): number {
    if (this.method === LENGTH_METHOD_WORD_COUNT) {
      return countWords(text)
    }
    return weightedLen(text)
  }
}

/** 加权字符长度：CJK 字符计 2，其他计 1（Go `weightedLen`）。 */
export function weightedLen(text: string): number {
  let n = 0
  for (const ch of text) {
    if (isCJK(ch.codePointAt(0) ?? 0)) {
      n += 2
    } else {
      n += 1
    }
  }
  return n
}

/** 语义单元数：CJK 每字 1 词，拉丁每词 1 词（Go `countWords`）。 */
export function countWords(text: string): number {
  let count = 0
  let inWord = false
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (isCJK(cp)) {
      count++
      inWord = false
    } else if (isSpace(cp)) {
      inWord = false
    } else if (!inWord) {
      count++
      inWord = true
    }
  }
  return count
}
