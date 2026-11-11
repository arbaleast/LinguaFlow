/**
 * 上下文窗口扩展（对应 Go `backend/internal/pipeline/batch_utils.go` 与 `context.go`）。
 *
 * 核心契约：`ExpandBatchWithContext` 是「哪些段落会被拉入上下文」的**单一事实源**，
 * 预估函数 `estimateContextWords` / `estimateContextWordsWithPrefix` 复用同一选段规则，
 * 保证预估与实际发送不可偏离。
 */
import { countWords } from '../shared/words'
import { runeCount, sliceRunes } from '../shared/unicode'
import type { BatchDocument, BatchSegment } from './types'

/** pipeline 级别的翻译上下文窗口运行时配置。 */
export interface ContextConfig {
  enabled: boolean
  before: number
  after: number
  maxChars: number
}

/** 默认上下文配置：`enabled=true`、`before=1`、`after=1`、`maxChars=0`。 */
export function defaultContextConfig(): ContextConfig {
  return { enabled: true, before: 1, after: 1, maxChars: 0 }
}

/** 上下文扩展结果。 */
export interface ExpandedContext {
  /** 扩展后的索引列表。 */
  idxs: number[]
  /** 被 `maxChars` 截断的上下文段文本（key = idx 字符串）。 */
  truncatedSrc: Record<string, string>
}

/**
 * 返回段落的原始文本：优先 protect 之前的原文快照，未保护过时回退 `source`。
 *
 * `source` 在 protect 之后是含占位符的版本，任何需要「人类可读原文」的场合
 * （上下文展示、字数统计、结果落库、结构段判定）都必须走本函数。
 */
export function rawSource(seg: BatchSegment): string {
  if (seg.originalSource !== undefined && seg.originalSource !== '') {
    return seg.originalSource
  }
  return seg.source
}

/**
 * 判断段落是否可作为上下文段（与 `expandBatchWithContext` 的选段规则同源）。
 *
 * 契约：`structuralOnly` 标记由 translate 轮对全部非 Skip 段统一计算；
 * 未标记（零值 false）按「有内容」处理（fail-open）。
 */
export function isContextEligible(seg: BatchSegment): boolean {
  return !seg.skip && !seg.structuralOnly
}

/**
 * 为批次扩展上下文段落，并按 `maxChars` 对上下文段做 rune 截断。
 *
 * `maxChars <= 0` 表示不截断。批次内段（pending）永不截断。
 *
 * 截断按 **Unicode 码点**（rune）而非 UTF-16 code unit 进行，
 * 与 Go 的 `utf8.RuneCountInString` / `[]rune(src)[:maxChars]` 一致。
 */
export function expandBatchWithContext(
  doc: BatchDocument,
  idxs: readonly number[],
  totalSegments: number,
  ctxWindow: number,
  maxChars: number,
): ExpandedContext {
  const truncatedSrc: Record<string, string> = {}
  if (ctxWindow <= 0 || idxs.length === 0) {
    return { idxs: idxs.slice(), truncatedSrc }
  }
  const batchSet = new Set<number>(idxs)
  const firstIdx = idxs[0] as number
  const lastIdx = idxs[idxs.length - 1] as number
  const expandFrom = Math.max(firstIdx - ctxWindow, 0)
  const expandTo = Math.min(lastIdx + ctxWindow, totalSegments - 1)
  const expanded: number[] = []
  for (let i = expandFrom; i <= expandTo; i++) {
    if (batchSet.has(i)) {
      expanded.push(i)
      continue
    }
    const seg = doc.segments[i] as BatchSegment
    if (!isContextEligible(seg)) {
      continue
    }
    if (maxChars > 0) {
      const src = rawSource(seg)
      if (runeCount(src) > maxChars) {
        truncatedSrc[String(i)] = `${sliceRunes(src, 0, maxChars)}…`
      }
    }
    expanded.push(i)
  }
  return { idxs: expanded, truncatedSrc }
}

/**
 * 预估给定候选批次（pending 索引）在 ctxWindow 下会拉入的上下文字词数。
 *
 * 直接复用 `expandBatchWithContext` 的选段结果（maxChars=0，仅统计非批次段），
 * 保证选段区间与过滤规则单一来源。
 */
export function estimateContextWords(
  doc: BatchDocument,
  batchIdxs: readonly number[],
  ctxWindow: number,
): number {
  if (ctxWindow <= 0 || batchIdxs.length === 0) {
    return 0
  }
  const expanded = expandBatchWithContext(doc, batchIdxs, doc.segments.length, ctxWindow, 0)
  const batchSet = new Set<number>(batchIdxs)
  let words = 0
  for (const idx of expanded.idxs) {
    if (batchSet.has(idx)) {
      continue
    }
    const seg = doc.segments[idx] as BatchSegment
    words += countWords(rawSource(seg))
  }
  return words
}

/**
 * 预计算 eligible 上下文段的字数前缀和。
 *
 * `prefix[i] = sum(countWords(originalSource ?? source))` for eligible segs in `[0, i)`。
 * 供 `estimateContextWordsWithPrefix` 做 O(1) 区间求和，避免巨大 ctxWindow 下的 O(n²) 退化。
 */
export function buildEligibleWordPrefix(doc: BatchDocument): number[] {
  const prefix = Array.from({ length: doc.segments.length + 1 }, () => 0)
  for (let i = 0; i < doc.segments.length; i++) {
    prefix[i + 1] = prefix[i] as number
    const seg = doc.segments[i] as BatchSegment
    if (isContextEligible(seg)) {
      prefix[i + 1] = (prefix[i] as number) + countWords(rawSource(seg))
    }
  }
  return prefix
}

/**
 * 用前缀和数组快速预估候选批次的上下文字词数。
 *
 * 与 `estimateContextWords` 同源（同区间、同过滤 `isContextEligible`、同源文本回退），
 * 但每次调用 O(batchSize) 而非 O(ctxWindow + batchSize)，与 ctxWindow 大小无关。
 * 批内段一定落在 `[lo, hi]` 内，扣除其字数即可。
 */
export function estimateContextWordsWithPrefix(
  doc: BatchDocument,
  batchIdxs: readonly number[],
  ctxWindow: number,
  eligiblePrefix: readonly number[],
): number {
  if (ctxWindow <= 0 || batchIdxs.length === 0) {
    return 0
  }
  const docLen = doc.segments.length
  const lo = Math.max((batchIdxs[0] as number) - ctxWindow, 0)
  const hi = Math.min((batchIdxs[batchIdxs.length - 1] as number) + ctxWindow, docLen - 1)
  let total = (eligiblePrefix[hi + 1] as number) - (eligiblePrefix[lo] as number)
  for (const idx of batchIdxs) {
    const seg = doc.segments[idx] as BatchSegment
    if (isContextEligible(seg)) {
      total -= countWords(rawSource(seg))
    }
  }
  return total
}

/**
 * 从扩展后的索引列表中构建上下文集合。
 *
 * 返回的集合只包含非批次内的上下文索引。
 */
export function buildContextSet(
  expandedIdxs: readonly number[],
  batchSet: ReadonlySet<number>,
): Set<number> {
  const ctxSet = new Set<number>()
  for (const idx of expandedIdxs) {
    if (!batchSet.has(idx)) {
      ctxSet.add(idx)
    }
  }
  return ctxSet
}

/** 过滤掉上下文索引，只保留待处理的索引。 */
export function filterPendingIdxs(
  idxs: readonly number[],
  contextSet: ReadonlySet<number>,
): number[] {
  if (contextSet.size === 0) {
    return idxs.slice()
  }
  const pending: number[] = []
  for (const idx of idxs) {
    if (!isContext(contextSet, idx)) {
      pending.push(idx)
    }
  }
  return pending
}

/** 检查 idx 是否在 contextSet 中。 */
export function isContext(contextSet: ReadonlySet<number>, idx: number): boolean {
  if (contextSet.size === 0) {
    return false
  }
  return contextSet.has(idx)
}
