/**
 * `duplicate` checker（对应 Go `checker_duplicate.go`）。
 *
 * 检测同一批次中不同原文映射到相同译文的情况。相同原文映射到相同译文不算问题
 * （同文同译是合理复用）。硬规则，不可裁决：需同批多段输入，无单段裁决语义。
 */
import { CHECK_DUPLICATE } from '../codes'
import { SEVERITY_WARNING, type CheckInput, type Checker, type QualityIssue } from '../types'

/** 重复译文检测器。 */
export class DuplicateTranslationChecker implements Checker {
  name(): string {
    return CHECK_DUPLICATE
  }

  check(segments: readonly CheckInput[]): QualityIssue[] {
    interface Entry {
      sourceIndex: number
      sourceText: string
    }
    const targetMap = new Map<string, Entry>()
    const issues: QualityIssue[] = []
    for (const seg of segments) {
      const tgt = seg.targetText
      if (tgt === '') {
        continue
      }
      const prev = targetMap.get(tgt)
      if (prev !== undefined) {
        if (prev.sourceText !== seg.sourceText) {
          issues.push({
            segmentIndex: seg.index,
            severity: SEVERITY_WARNING,
            code: CHECK_DUPLICATE,
            message: `译文与段落 ${prev.sourceIndex} 重复（原文不同）`,
            disposition: '',
          })
        }
      } else {
        targetMap.set(tgt, { sourceIndex: seg.index, sourceText: seg.sourceText })
      }
    }
    return issues
  }
}
