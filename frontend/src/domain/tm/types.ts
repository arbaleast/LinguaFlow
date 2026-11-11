/**
 * `domain/tm` 的类型契约（对应 Go `backend/internal/tm/tm.go` + `sqlite.go`）。
 *
 * Phase 1 只移植**纯匹配逻辑**：SQLite/ent 由 Phase 2 的 IndexedDB 承担。
 * 存储能力被收敛成最小接口 `TmStore`，领域层只依赖它；`MemoryTmStore` 是本包
 * 提供的纯内存实现（测试与预览可用）。
 *
 * 关键约定（与 SQLite 实现逐条对齐）：
 * - 匹配是 `source_hash` + 语言对的**完全相等**，不做相似度/fuzzy；
 * - `Match.score` 恒为 1；
 * - 命中后对命中的每一行执行 `usage_count += 1`；
 * - 查询结果为 `usage_count DESC, id ASC`。
 */
import type { Result } from '../shared/result'

/** 一条命中记录（Go `tm.Match`）。`score` 恒为 1。 */
export interface TmMatch {
  source: string
  target: string
  score: number
}

/** 翻译记忆中的一行（对应 ent.TMEntry 中领域层真正读写的列）。 */
export interface TmEntry {
  /** 自增主键（排序平局时使用）。 */
  id: number
  /** 所属项目（Scope 的持久化形态）。 */
  projectId: number
  /** `fullHash(trim(sourceText))`，SHA-256 全 64 位十六进制。 */
  sourceHash: string
  /** 原文（已 trim）。 */
  sourceText: string
  /** 译文（已 trim）。 */
  targetText: string
  /** 源语言（已 trim）。 */
  sourceLang: string
  /** 目标语言（已 trim）。 */
  targetLang: string
  /** 命中次数；Search 会回写 +1。 */
  usageCount: number
}

/** 作用域（Go `tm.Scope`）。`projectId === 0` 非法。 */
export interface TmScope {
  projectId: number
}

/** 精确匹配查询条件（对应 `baseQuery` 的 WHERE + Scope key）。 */
export interface TmQuery {
  projectId: number
  sourceHash: string
  sourceLang: string
  targetLang: string
}

/** 新建一行所需的字段（`sourceHash` 由调用方（领域层）计算）。 */
export interface TmCreateInput {
  projectId: number
  sourceHash: string
  sourceText: string
  targetText: string
  sourceLang: string
  targetLang: string
}

/**
 * 翻译记忆的最小存储契约（Phase 2 用 IndexedDB 实现）。
 *
 * 刻意不暴露 SQL/事务：领域层只需要「精确查、建、改文本、加计数、快照」。
 * 实现方必须保证：
 * - `find` 只返回四个条件全等的记录，并按 `usageCount DESC, id ASC` 排序；
 * - `create` 在唯一键 `(projectId, sourceHash, sourceLang, targetLang)` 冲突时
 *   返回 `null`（对应 ent 的唯一索引；Go 侧吞掉 constraint error）；
 * - `id` 由存储分配且单调递增。
 */
export interface TmStore {
  find(query: TmQuery): TmEntry[]
  create(input: TmCreateInput): TmEntry | null
  updateText(id: number, sourceText: string, targetText: string): void
  incrementUsage(ids: readonly number[]): void
  /** 全量快照（按 id 升序的副本），测试/诊断用。 */
  snapshot(): TmEntry[]
}

/** 翻译记忆能力（Go `tm.TranslationMemory` 接口）。 */
export interface TranslationMemory {
  /** 查询完全相等的命中；无命中返回 `[]`。 */
  search(src: string, srcLang: string, tgtLang: string): Result<TmMatch[]>
  /** 写入一条（已有则更新文本）；空字段静默忽略。 */
  add(src: string, tgt: string, srcLang: string, tgtLang: string): Result<void>
}
