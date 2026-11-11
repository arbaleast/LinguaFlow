/**
 * `leftover_placeholder` checker（对应 Go `checker_placeholder_leak.go`）。
 *
 * 检测最终译文中残留的 `__LF_*` 占位符（Unprotect 泄漏兜底）。同一占位符重复出现
 * 只报一条（按 token 去重）。占位符泄漏意味着译文会把内部 key 直接暴露给用户。
 */
import { compile, findAllStringIndex } from '../../shared/re2'
import { CHECK_LEFTOVER_PLACEHOLDER } from '../codes'
import { locateSpan } from '../span'
import { SEVERITY_ERROR, type CheckInput, type Checker, type QualityIssue } from '../types'

/** 与 protect 包占位符形态兼容：`__LF_` 后接字母数字下划线（Go `leftoverPlaceholderRe`）。 */
const leftoverPlaceholderRe = compile('__LF_[A-Za-z0-9_]+')

/** 占位符泄漏检测器。 */
export class LeftoverPlaceholderChecker implements Checker {
  name(): string {
    return CHECK_LEFTOVER_PLACEHOLDER
  }

  check(segments: readonly CheckInput[]): QualityIssue[] {
    const issues: QualityIssue[] = []
    for (const seg of segments) {
      const tgt = seg.targetText
      if (tgt === '' || !tgt.includes('__LF_')) {
        continue
      }
      const seen = new Set<string>()
      for (const [start, end] of findAllStringIndex(leftoverPlaceholderRe, tgt)) {
        const m = tgt.slice(start, end)
        if (seen.has(m)) {
          continue
        }
        seen.add(m)
        const span = locateSpan(tgt, m) ?? { matchedText: m }
        issues.push({
          segmentIndex: seg.index,
          severity: SEVERITY_ERROR,
          code: CHECK_LEFTOVER_PLACEHOLDER,
          message: `译文残留占位符：${m}`,
          span,
          disposition: '',
        })
      }
    }
    return issues
  }
}
