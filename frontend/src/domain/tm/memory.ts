/**
 * 纯内存翻译记忆存储（`TmStore` 的默认实现）。
 *
 * 语义与 `backend/internal/tm/sqlite.go` 的 SQL 完全对齐：
 *
 * ```sql
 * WHERE scope_key = ? AND source_hash = ? AND source_lang = ? AND target_lang = ?
 * ORDER BY usage_count DESC, id ASC
 * ```
 *
 * 唯一键 `(project_id, source_hash, source_lang, target_lang)` 由 `create` 检查；
 * 冲突时返回 `null`（对应 Go 侧吞掉的 ent constraint error）。
 *
 * 浏览器侧 Phase 2 会用 IndexedDB 实现同一接口；本类同时用于单元测试与
 * 「纯内存预览」场景。
 */
import type { TmCreateInput, TmEntry, TmQuery, TmStore } from './types'

/** 按 id 升序的浅拷贝。 */
function byID(entries: readonly TmEntry[]): TmEntry[] {
  return entries.slice().sort((a, b) => a.id - b.id)
}

export class MemoryTmStore implements TmStore {
  private entries: TmEntry[] = []
  private nextId = 0

  /** 用一批已有记录初始化（`sourceHash` 必须由调用方算好）。 */
  constructor(seed: Iterable<TmEntry> = []) {
    for (const entry of seed) {
      this.entries.push({ ...entry })
      if (entry.id > this.nextId) this.nextId = entry.id
    }
  }

  /** 精确查询，结果按 `usageCount DESC, id ASC` 排序（返回副本）。 */
  find(query: TmQuery): TmEntry[] {
    const rows = this.entries.filter(
      (entry) =>
        entry.projectId === query.projectId &&
        entry.sourceHash === query.sourceHash &&
        entry.sourceLang === query.sourceLang &&
        entry.targetLang === query.targetLang,
    )
    rows.sort((a, b) => (a.usageCount === b.usageCount ? a.id - b.id : b.usageCount - a.usageCount))
    return rows.map((entry) => ({ ...entry }))
  }

  /** 新建一行；唯一键冲突返回 `null`。 */
  create(input: TmCreateInput): TmEntry | null {
    const existing = this.entries.some(
      (entry) =>
        entry.projectId === input.projectId &&
        entry.sourceHash === input.sourceHash &&
        entry.sourceLang === input.sourceLang &&
        entry.targetLang === input.targetLang,
    )
    if (existing) return null
    this.nextId += 1
    const entry: TmEntry = {
      id: this.nextId,
      projectId: input.projectId,
      sourceHash: input.sourceHash,
      sourceText: input.sourceText,
      targetText: input.targetText,
      sourceLang: input.sourceLang,
      targetLang: input.targetLang,
      usageCount: 0,
    }
    this.entries.push(entry)
    return { ...entry }
  }

  /** 更新原文/译文（不改变语言、hash 与计数）。 */
  updateText(id: number, sourceText: string, targetText: string): void {
    const entry = this.entries.find((candidate) => candidate.id === id)
    if (!entry) return
    entry.sourceText = sourceText
    entry.targetText = targetText
  }

  /** 对命中的每一行 `usage_count += 1`。 */
  incrementUsage(ids: readonly number[]): void {
    const bumped = new Set(ids)
    for (const entry of this.entries) {
      if (bumped.has(entry.id)) entry.usageCount += 1
    }
  }

  /** 全量快照（按 id 升序的副本）。 */
  snapshot(): TmEntry[] {
    return byID(this.entries).map((entry) => ({ ...entry }))
  }
}
