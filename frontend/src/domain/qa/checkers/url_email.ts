/**
 * `url_email` checker（对应 Go `checker_url_email.go`）。
 *
 * 比对还原后源/译 URL 与邮箱多重集合（兜底校验）：译者不应改写链接与邮箱。
 * 宽松匹配 http(s)/ftp URL 与常见邮箱；比对时统一小写，并去掉尾部常见标点。
 */
import { trimSpace } from '../../ruby'
import { compile, findAllStringIndex } from '../../shared/re2'
import { CHECK_URL_EMAIL_MISMATCH } from '../codes'
import { formatStringSlice, multisetEqual } from './number'
import { SEVERITY_WARNING, type CheckInput, type Checker, type QualityIssue } from '../types'

/** URL token（Go `urlTokenRe`，大小写不敏感）。 */
const urlTokenRe = compile('(?i)\\b(?:https?|ftp)://[^\\s<>"\']+')

/** 邮箱 token（Go `emailTokenRe`，大小写不敏感）。 */
const emailTokenRe = compile('(?i)\\b[a-z0-9._%+\\-]+@[a-z0-9.\\-]+\\.[a-z]{2,}\\b')

/** 需要从 token 尾部剥掉的常见标点（Go `strings.TrimRight` 的 cutset）。 */
const TRAILING_CUTSET = new Set(Array.from('.,;:!?)]}"\'>'))

/** URL/邮箱守恒检测器。 */
export class URLEmailMismatchChecker implements Checker {
  name(): string {
    return CHECK_URL_EMAIL_MISMATCH
  }

  check(segments: readonly CheckInput[]): QualityIssue[] {
    const issues: QualityIssue[] = []
    for (const seg of segments) {
      const src = seg.sourceText
      const tgt = seg.targetText
      if (trimSpace(src) === '' || trimSpace(tgt) === '') {
        continue
      }
      const srcSet = extractURLEmailMultiset(src)
      const tgtSet = extractURLEmailMultiset(tgt)
      if (srcSet.size === 0 && tgtSet.size === 0) {
        continue
      }
      if (multisetEqual(srcSet, tgtSet)) {
        continue
      }
      issues.push({
        segmentIndex: seg.index,
        severity: SEVERITY_WARNING,
        code: CHECK_URL_EMAIL_MISMATCH,
        message: `URL/邮箱不一致：原文 ${formatStringSlice(keysOf(srcSet))}，译文 ${formatStringSlice(keysOf(tgtSet))}`,
        disposition: '',
      })
    }
    return issues
  }
}

/** 提取 URL/邮箱多重集合（Go `extractURLEmailMultiset`）。 */
export function extractURLEmailMultiset(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  const bump = (key: string): void => {
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (const [start, end] of findAllStringIndex(urlTokenRe, text)) {
    const m = trimRightCutset(text.slice(start, end), TRAILING_CUTSET)
    bump(m.toLowerCase())
  }
  for (const [start, end] of findAllStringIndex(emailTokenRe, text)) {
    const m = trimRightCutset(text.slice(start, end), TRAILING_CUTSET)
    bump(m.toLowerCase())
  }
  return counts
}

/** 等价 Go `strings.TrimRight(s, cutset)`。 */
function trimRightCutset(s: string, cutset: ReadonlySet<string>): string {
  const chars = Array.from(s)
  let end = chars.length
  while (end > 0 && cutset.has(chars[end - 1]!)) {
    end--
  }
  return chars.slice(0, end).join('')
}

/** 多重集合 → 排序后按计数展开的键列表（Go `keysOf`）。 */
export function keysOf(m: ReadonlyMap<string, number>): string[] {
  const keys = Array.from(m.keys()).sort()
  const out: string[] = []
  for (const k of keys) {
    const n = m.get(k) ?? 0
    for (let i = 0; i < n; i++) {
      out.push(k)
    }
  }
  return out
}
