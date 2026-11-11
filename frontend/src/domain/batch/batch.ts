/**
 * 批次切分（对应 Go `backend/internal/pipeline/batch.go`）。
 *
 * 口径：**段落数 + 字词数双约束**（AND），任一达到上限即切批。
 * 超限时，触发超限的段落不加入当前批次，成为下一批次的第一段；
 * 单段超限时独占一个批次（不截断），后续由 shrink 机制处理。
 */
import { countWords } from '../shared/words'
import type { BatchConstraint, BatchDocument, BatchSegment, ContextWordEstimator } from './types'

/**
 * 应用与静态轮次批次、动态对齐批次相同的内容软上限。
 *
 * 调用方允许「首个成员超限」独占一批。
 */
function exceeds(
  constraint: BatchConstraint,
  segments: number,
  words: number,
  nextWords: number,
): boolean {
  return (
    (constraint.maxSegments > 0 && segments >= constraint.maxSegments) ||
    (constraint.maxWords > 0 &&
      (words > constraint.maxWords || nextWords > constraint.maxWords - words))
  )
}

/**
 * 根据上下文窗口合并重叠段落的 batch。
 *
 * `enabled === false` 或 `ctxWindow <= 0` 时退化为连续分组。
 */
export function buildContextAwareBatches(
  doc: BatchDocument,
  pending: readonly number[],
  constraint: BatchConstraint,
  ctxWindow: number,
  enabled: boolean,
  estimator: ContextWordEstimator | null,
): number[][] {
  if (!enabled || ctxWindow <= 0) {
    return buildContinuousPendingBatches(doc, pending, constraint)
  }
  if (pending.length === 0) {
    return []
  }

  // 1. 按上下文覆盖范围分组
  const groups: number[][] = []
  let groupStart = (pending[0] as number) - ctxWindow
  let groupEnd = (pending[0] as number) + ctxWindow

  for (let i = 1; i < pending.length; i++) {
    const idx = pending[i] as number
    const segStart = idx - ctxWindow
    const segEnd = idx + ctxWindow
    if (segStart <= groupEnd + 1) {
      groupEnd = segEnd
    } else {
      groups.push(filterInRange(pending, groupStart, groupEnd, i))
      groupStart = segStart
      groupEnd = segEnd
    }
  }
  groups.push(filterInRange(pending, groupStart, groupEnd, pending.length))

  // 2. 每组内按约束切分
  const batches: number[][] = []
  for (const group of groups) {
    batches.push(...splitByConstraintAndSpan(doc, group, constraint, 0, estimator))
  }
  return batches
}

/**
 * 将 pending 段索引按连续性分组，每组内再按约束切批。
 *
 * 分散段落会被拆到不同 batch，避免上下文断裂。
 * 每组切分后的**最后一批**被收集到 leftovers，按「批长度倒序、首个索引升序」
 * 稳定排序后追加到结果末尾。
 */
export function buildContinuousPendingBatches(
  doc: BatchDocument,
  pending: readonly number[],
  constraint: BatchConstraint,
): number[][] {
  if (pending.length === 0) {
    return []
  }
  const runs: number[][] = []
  let start = 0
  for (let i = 1; i <= pending.length; i++) {
    if (i === pending.length || pending[i] !== (pending[i - 1] as number) + 1) {
      runs.push(pending.slice(start, i))
      start = i
    }
  }

  const batches: number[][] = []
  const leftovers: number[][] = []
  for (const run of runs) {
    const sub = splitByConstraint(doc, run, constraint)
    if (sub.length > 1) {
      batches.push(...sub.slice(0, sub.length - 1))
      leftovers.push(sub[sub.length - 1] as number[])
    } else if (sub.length === 1) {
      leftovers.push(sub[0] as number[])
    }
  }
  leftovers.sort((a, b) => {
    if (a.length === b.length) {
      return (a[0] as number) - (b[0] as number)
    }
    return b.length - a.length
  })
  batches.push(...leftovers)
  return batches
}

/**
 * 按文档顺序贪心填充批次，允许索引不连续的段落同批。
 *
 * 适用于裁决等段落独立、无需连续上下文的场景。
 *
 * - `maxIndexSpan <= 0`：不限制同批首尾索引跨度（默认关闭）。
 * - `maxIndexSpan > 0`：要求同批内 `max(idx) - min(idx) <= maxIndexSpan`，超限则切批。
 * - 段落数 / 字词数约束与 `splitByConstraint` 相同；单段超限仍独占一批。
 */
export function buildPackedPendingBatches(
  doc: BatchDocument,
  pending: readonly number[],
  constraint: BatchConstraint,
  maxIndexSpan: number,
): number[][] {
  if (pending.length === 0) {
    return []
  }
  if (maxIndexSpan <= 0) {
    return splitByConstraint(doc, pending, constraint)
  }
  return splitByConstraintAndSpan(doc, pending, constraint, maxIndexSpan, null)
}

/**
 * 按段落数和字词数双重约束切分一组段落索引（不必连续）。
 *
 * 超限时，触发超限的段落不加入当前批次，成为下一批次的第一段。
 * 单段超限时独占一个批次（不截断），后续由 shrink 机制处理。
 */
export function splitByConstraint(
  doc: BatchDocument,
  group: readonly number[],
  constraint: BatchConstraint,
): number[][] {
  return splitByConstraintAndSpan(doc, group, constraint, 0, null)
}

/**
 * 在 `splitByConstraint` 基础上可选索引跨度上限，以及上下文词数预估器。
 *
 * `maxIndexSpan <= 0` 表示不限制跨度。`estimator` 为 `null` 时不计入上下文预算。
 */
export function splitByConstraintAndSpan(
  doc: BatchDocument,
  group: readonly number[],
  constraint: BatchConstraint,
  maxIndexSpan: number,
  estimator: ContextWordEstimator | null,
): number[][] {
  if (group.length === 0) {
    return []
  }
  const noSegLimit = constraint.maxSegments <= 0
  const noWordLimit = constraint.maxWords <= 0
  const noSpanLimit = maxIndexSpan <= 0
  if (noSegLimit && noWordLimit && noSpanLimit) {
    return [group.slice()]
  }

  const batches: number[][] = []
  let start = 0
  let pendingWords = 0
  for (let i = 0; i < group.length; i++) {
    const idx = group[i] as number
    const seg = doc.segments[idx] as BatchSegment
    let segWords = countWords(seg.source)
    if (constraint.wordCount) {
      segWords = constraint.wordCount(seg)
    }
    if (i > start) {
      const segCount = i - start
      let estCtx = 0
      if (!noWordLimit && estimator) {
        const candidate = group.slice(start, i)
        candidate.push(idx)
        estCtx = estimator(candidate)
      }
      const exceedContent =
        exceeds(constraint, segCount, pendingWords, segWords) ||
        (!noWordLimit &&
          (estCtx > constraint.maxWords || pendingWords + segWords > constraint.maxWords - estCtx))
      const exceedSpan = !noSpanLimit && idx - (group[start] as number) > maxIndexSpan
      if (exceedContent || exceedSpan) {
        batches.push(group.slice(start, i))
        start = i
        pendingWords = 0
      }
    }
    pendingWords += segWords
  }
  if (start < group.length) {
    batches.push(group.slice(start))
  }
  return batches
}

/**
 * 返回 `pending[0:endIdx]` 中值在 `[lo, hi]` 范围内的元素。
 */
export function filterInRange(
  pending: readonly number[],
  lo: number,
  hi: number,
  endIdx: number,
): number[] {
  const result: number[] = []
  for (let i = 0; i < endIdx; i++) {
    const v = pending[i] as number
    if (v >= lo && v <= hi) {
      result.push(v)
    }
  }
  return result
}

/**
 * 按池索引缩放批次约束：`floor(orig * shrink^poolIndex)`，下限 clamp 到 1。
 *
 * Go `pipeline.shrinkConstraint`。
 */
export function shrinkConstraint(
  orig: BatchConstraint,
  shrink: number,
  poolIndex: number,
): BatchConstraint {
  if (
    poolIndex <= 0 ||
    shrink <= 0 ||
    shrink >= 1 ||
    Number.isNaN(shrink) ||
    !Number.isFinite(shrink)
  ) {
    return orig
  }
  const factor = Math.pow(shrink, poolIndex)
  const out: BatchConstraint = { ...orig }
  if (orig.maxSegments > 0) {
    out.maxSegments = Math.max(1, Math.floor(orig.maxSegments * factor))
  }
  if (orig.maxWords > 0) {
    out.maxWords = Math.max(1, Math.floor(orig.maxWords * factor))
  }
  return out
}
