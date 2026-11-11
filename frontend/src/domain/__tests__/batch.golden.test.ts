/**
 * `domain/batch`（含字词计数）黄金向量对拍测试。
 *
 * 期望值全部来自 Go `backend/internal/pipeline` 的真实输出
 * （由 `backend/internal/pipeline/golden_vectors_test.go` 导出）。
 */
import { describe, expect, it } from 'vitest'
import batchFixture from '../__fixtures__/batch.json'
import {
  buildContextAwareBatches,
  buildContextSet,
  buildContinuousPendingBatches,
  buildPackedPendingBatches,
  buildEligibleWordPrefix,
  estimateContextWords,
  estimateContextWordsWithPrefix,
  expandBatchWithContext,
  filterPendingIdxs,
  shrinkConstraint,
  type BatchConstraint,
  type BatchDocument,
  type BatchSegment,
} from '../batch'
import { countWords } from '../shared/words'
import {
  argBoolean,
  argNumber,
  argNumberArray,
  argString,
  runGolden,
  type GoldenFixture,
} from './helpers/golden'

const fixture = batchFixture as unknown as GoldenFixture

/** 黄金向量中的可序列化段落描述。 */
interface GoldenSeg {
  source: string
  original_source?: string
  skip?: boolean
  translate?: boolean
  structural_only?: boolean
}

/** 把黄金向量段落转换为领域层的段落结构。 */
function toSegment(seg: GoldenSeg): BatchSegment {
  return {
    source: seg.source,
    originalSource: seg.original_source,
    skip: seg.skip,
    translate: seg.translate,
    structuralOnly: seg.structural_only,
  }
}

/** 构造领域层文档。 */
function toDocument(segs: GoldenSeg[]): BatchDocument {
  return { segments: segs.map(toSegment) }
}

/** 读取黄金向量中的段落数组。 */
function argSegments(args: Record<string, unknown>, key: string): GoldenSeg[] {
  const v = args[key]
  if (!Array.isArray(v)) {
    throw new Error(`黄金向量参数 "${key}" 期望为数组`)
  }
  return v as GoldenSeg[]
}

/** 读取黄金向量中的纯文本来源数组。 */
function argSources(args: Record<string, unknown>, key: string): GoldenSeg[] {
  const v = args[key]
  if (!Array.isArray(v)) {
    throw new Error(`黄金向量参数 "${key}" 期望为数组`)
  }
  return (v as string[]).map((source) => ({ source, translate: true }))
}

/** 读取黄金向量中的约束。 */
function argConstraint(args: Record<string, unknown>): BatchConstraint {
  return {
    maxSegments: argNumber(args, 'max_segments'),
    maxWords: argNumber(args, 'max_words'),
  }
}

describe('domain/batch 黄金向量', () => {
  it('覆盖全部黄金向量', () => {
    runGolden(fixture, {
      'words.count': (args) => {
        return { count: countWords(argString(args, 'text')) }
      },

      'batch.build_context_aware': (args) => {
        const doc = toDocument(argSources(args, 'sources'))
        const constraint = argConstraint(args)
        const ctxWindow = argNumber(args, 'ctx_window')
        const enabled = argBoolean(args, 'enabled')
        const useEstimator = argBoolean(args, 'use_estimator')
        const estimator = useEstimator
          ? (idxs: number[]) => estimateContextWords(doc, idxs, ctxWindow)
          : null
        return {
          batches: buildContextAwareBatches(
            doc,
            argNumberArray(args, 'pending'),
            constraint,
            ctxWindow,
            enabled,
            estimator,
          ),
        }
      },

      'batch.build_continuous': (args) => {
        const doc = toDocument(argSources(args, 'sources'))
        return {
          batches: buildContinuousPendingBatches(
            doc,
            argNumberArray(args, 'pending'),
            argConstraint(args),
          ),
        }
      },

      'batch.build_packed': (args) => {
        const doc = toDocument(argSources(args, 'sources'))
        return {
          batches: buildPackedPendingBatches(
            doc,
            argNumberArray(args, 'pending'),
            argConstraint(args),
            argNumber(args, 'max_index_span'),
          ),
        }
      },

      'batch.expand_context': (args) => {
        const doc = toDocument(argSegments(args, 'segments'))
        const r = expandBatchWithContext(
          doc,
          argNumberArray(args, 'idxs'),
          argNumber(args, 'total_segments'),
          argNumber(args, 'ctx_window'),
          argNumber(args, 'max_chars'),
        )
        return { idxs: r.idxs, truncated: r.truncatedSrc }
      },

      'batch.estimate_context_words': (args) => {
        const doc = toDocument(argSegments(args, 'segments'))
        const batch = argNumberArray(args, 'batch')
        const ctxWindow = argNumber(args, 'ctx_window')
        const prefix = buildEligibleWordPrefix(doc)
        return {
          words: estimateContextWords(doc, batch, ctxWindow),
          prefixWords: estimateContextWordsWithPrefix(doc, batch, ctxWindow, prefix),
        }
      },

      'batch.build_context_set': (args) => {
        const expanded = argNumberArray(args, 'expanded')
        const batchSet = new Set(argNumberArray(args, 'batch'))
        const ctxSet = buildContextSet(expanded, batchSet)
        return {
          context: [...ctxSet].sort((a, b) => a - b),
          pending: filterPendingIdxs(expanded, ctxSet),
        }
      },

      'batch.shrink_constraint': (args) => {
        const out = shrinkConstraint(
          {
            maxSegments: argNumber(args, 'max_segments'),
            maxWords: argNumber(args, 'max_words'),
          },
          argNumber(args, 'shrink'),
          argNumber(args, 'pool'),
        )
        return { max_segments: out.maxSegments, max_words: out.maxWords }
      },
    })
  })

  it('黄金向量覆盖了批次切分的全部操作', () => {
    const ops = new Set(fixture.cases.map((c) => c.op))
    expect([...ops].sort()).toEqual([
      'batch.build_context_aware',
      'batch.build_context_set',
      'batch.build_continuous',
      'batch.build_packed',
      'batch.estimate_context_words',
      'batch.expand_context',
      'batch.shrink_constraint',
      'words.count',
    ])
  })
})
