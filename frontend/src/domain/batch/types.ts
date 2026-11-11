/**
 * 批次切分的类型契约（对应 Go `backend/internal/pipeline/batch.go` 与 `batch_utils.go`）。
 *
 * 领域层只保留批次切分真正读写的段落字段，避免耦合完整文档模型。
 */

/** 可参与批次切分的段落。 */
export interface BatchSegment {
  /** 原文（protect 之后为含占位符的版本）。 */
  source: string
  /** protect 之前的原文快照，供字数统计与上下文展示使用。 */
  originalSource?: string
  /** 增量翻译标记：true 时 translate stage 跳过。 */
  skip?: boolean
  /** 上下文标记：true=需要翻译，false=仅作上下文参考。 */
  translate?: boolean
  /** 结构段标记：剥离可保护跨度后无字母/数字。 */
  structuralOnly?: boolean
}

/** 可参与批次切分的文档。 */
export interface BatchDocument {
  segments: BatchSegment[]
}

/**
 * 批次的大小约束。
 *
 * 两个条件同时生效（AND），任一达到上限即切批。
 * `maxSegments <= 0` 表示不限段落数；`maxWords <= 0` 表示不限字词数。
 * 两者都 `<= 0` 时，调用方应回退到默认 `maxSegments = 1`。
 */
export interface BatchConstraint {
  /** 段落数上限（原 BatchSize）。 */
  maxSegments: number
  /** 字词数上限（0 = 不限制）。 */
  maxWords: number
  /** 自定义字数统计函数（缺省使用 `countWords(source)`）。 */
  wordCount?: (seg: BatchSegment) => number
}

/**
 * 预估候选批次（pending 索引）会拉入的上下文字词数。
 *
 * `null` 表示不计入上下文预算（退化为旧行为）。仅在 `maxWords > 0` 时被调用。
 */
export type ContextWordEstimator = (batchIdxs: number[]) => number
