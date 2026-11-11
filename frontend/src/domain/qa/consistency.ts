/**
 * 文档级「同文异译」检查（对应 Go `backend/internal/qa/consistency.go`）。
 *
 * 该检查不走 `Engine` 注册表（需全局视角），由调用方在 translate 轮之后直接调用：
 * 规范化后完全相同的源文段若出现不同译文，以组内首条译文为规范译法，
 * 对目标不同的后续段发出 warning。
 */
import { trimSpace } from '../ruby'
import { isSpace } from '../shared/unicode'
import { CODE_DUPLICATE_SOURCE_DIVERGENCE } from './codes'
import { checkerEnabled } from './qa'
import { SEVERITY_WARNING, type CheckInput, type QualityIssue } from './types'

/**
 * 报告给定 checks 配置下文档级同文异译检查是否启用（Go
 * `DuplicateSourceDivergenceEnabled`）。
 *
 * 注意 `Config.enabled` 与本判定相互独立，由调用方一并检查。
 */
export function duplicateSourceDivergenceEnabled(checks: readonly string[] | null): boolean {
  return checkerEnabled(checks, CODE_DUPLICATE_SOURCE_DIVERGENCE)
}

/** 文档级检查：规范化后完全相同的源文段出现不同译文（Go `CheckDuplicateSourceDivergence`）。 */
export function checkDuplicateSourceDivergence(segments: readonly CheckInput[]): QualityIssue[] {
  interface GroupEntry {
    index: number
    targetNorm: string
    targetRaw: string
  }
  const groups = new Map<string, GroupEntry[]>()
  const order: string[] = []

  for (const seg of segments) {
    const src = trimSpace(seg.sourceText)
    const tgt = trimSpace(seg.targetText)
    if (src === '' || tgt === '') {
      continue
    }
    const srcKey = normalizeSourceForDivergence(src)
    if (srcKey === '') {
      continue
    }
    if (!groups.has(srcKey)) {
      order.push(srcKey)
    }
    const list = groups.get(srcKey)
    const entry: GroupEntry = {
      index: seg.index,
      targetNorm: normalizeSourceForDivergence(tgt),
      targetRaw: tgt,
    }
    if (list === undefined) {
      groups.set(srcKey, [entry])
    } else {
      list.push(entry)
    }
  }

  const issues: QualityIssue[] = []
  for (const key of order) {
    const ents = groups.get(key) ?? []
    if (ents.length < 2) {
      continue
    }
    const canonical = ents[0]!.targetNorm
    for (let i = 1; i < ents.length; i++) {
      if (ents[i]!.targetNorm === canonical) {
        continue
      }
      issues.push({
        segmentIndex: ents[i]!.index,
        severity: SEVERITY_WARNING,
        code: CODE_DUPLICATE_SOURCE_DIVERGENCE,
        message: `相同原文译文不一致（与段落 ${ents[0]!.index} 不同）`,
        disposition: '',
      })
    }
  }
  return issues
}

/**
 * 折叠空白并去掉首尾空格；保留大小写与标点（Go `normalizeSourceForDivergence`）。
 */
export function normalizeSourceForDivergence(s: string): string {
  const trimmed = trimSpace(s)
  if (trimmed === '') {
    return ''
  }
  const out: string[] = []
  let prevSpace = false
  for (const ch of trimmed) {
    if (isSpace(ch.codePointAt(0) ?? 0)) {
      if (prevSpace) {
        continue
      }
      out.push(' ')
      prevSpace = true
      continue
    }
    prevSpace = false
    out.push(ch)
  }
  return trimSpace(out.join(''))
}
