/**
 * 翻译记忆的领域逻辑（对应 Go `backend/internal/tm/tm.go` + `sqlite.go`）。
 *
 * 与 Go 的架构差异：`sqlite.go` 把「作用域 + 查询 + 写入」直接绑在 ent 上；
 * 这里把它拆成两层：
 * - `ScopedTranslationMemory`：纯领域逻辑（trim、哈希、匹配、排序契约、回写计数）；
 * - `TmStore`（见 `types.ts`）：最小存储接口，Phase 2 由 IndexedDB 实现。
 *
 * `source_hash` 必须与后端逐字节一致，故固定使用 `shared/hash.ts` 的
 * `fullHash()`（等价 Go `internal/hash.Full`，SHA-256 全 64 位十六进制），
 * 且哈希输入是 **trim 后的原文**（Go 在 `Add` / `baseQuery` 里都先 TrimSpace）。
 */
import { domainError, err, ok, type Result } from '../shared/result'
import { fullHash } from '../shared/hash'
import { goTrimSpace } from './text'
import type { TmEntry, TmMatch, TmScope, TmStore, TranslationMemory } from './types'

/** `tm.Match.Score` 恒为 1（完全相等匹配，不做相似度）。 */
const EXACT_MATCH_SCORE = 1

/**
 * 生成 `source_hash`：`fullHash(TrimSpace(src))`。
 *
 * 与 Go `hash.Full(strings.TrimSpace(src))` 一致；调用方传入原始查询串即可。
 */
export function sourceHash(src: string): string {
  return fullHash(goTrimSpace(src))
}

/** 作用域的存储 key（Go `Scope.key`）：`project:<id>`，`id === 0` 非法。 */
export function scopeKey(scope: TmScope): Result<string> {
  if (scope.projectId === 0) {
    return err(domainError('tm.empty_scope', 'tm: empty scope'))
  }
  return ok(`project:${scope.projectId}`)
}

/**
 * 绑定到某个作用域的翻译记忆（Go `SQLite` 的领域部分）。
 *
 * 所有输入先 trim；空字段的 `add` 静默忽略（与 Go 相同的 fail-open）。
 */
export class ScopedTranslationMemory implements TranslationMemory {
  constructor(
    private readonly store: TmStore,
    private readonly scope: TmScope,
  ) {}

  /**
   * 查询完全相等的命中（Go `Search`）。
   *
   * 无命中返回 `[]`（Go 返回 nil slice）；命中后把每行的 `usage_count` +1，
   * 因此下一次查询的排序可能变化。空作用域返回失败分支。
   */
  search(src: string, srcLang: string, tgtLang: string): Result<TmMatch[]> {
    const key = scopeKey(this.scope)
    if (!key.ok) return err(key.error)

    const rows = this.store.find({
      projectId: this.scope.projectId,
      sourceHash: sourceHash(src),
      sourceLang: goTrimSpace(srcLang),
      targetLang: goTrimSpace(tgtLang),
    })
    if (rows.length === 0) return ok([])

    const matches: TmMatch[] = rows.map((row) => ({
      source: row.sourceText,
      target: row.targetText,
      score: EXACT_MATCH_SCORE,
    }))
    this.store.incrementUsage(rows.map((row) => row.id))
    return ok(matches)
  }

  /**
   * 写入一条记忆（Go `Add`）。
   *
   * - 任一字段 trim 后为空 → 静默 noop（且**先于**作用域校验，与 Go 顺序一致）；
   * - 无同 key 行 → 新建（usage_count=0，id 由存储分配）；
   * - 恰好一行且文本完全相同 → noop；不同 → 更新原文/译文；
   * - 多行同 key（历史脏数据，ent `Only` 会报错）→ 失败分支。
   */
  add(src: string, tgt: string, srcLang: string, tgtLang: string): Result<void> {
    const source = goTrimSpace(src)
    const target = goTrimSpace(tgt)
    const sourceLang = goTrimSpace(srcLang)
    const targetLang = goTrimSpace(tgtLang)
    if (source === '' || target === '' || sourceLang === '' || targetLang === '') {
      return ok(undefined)
    }

    const key = scopeKey(this.scope)
    if (!key.ok) return err(key.error)

    const hash = fullHash(source)
    const rows = this.store.find({
      projectId: this.scope.projectId,
      sourceHash: hash,
      sourceLang,
      targetLang,
    })
    if (rows.length === 0) {
      this.store.create({
        projectId: this.scope.projectId,
        sourceHash: hash,
        sourceText: source,
        targetText: target,
        sourceLang,
        targetLang,
      })
      return ok(undefined)
    }
    if (rows.length > 1) {
      return err(
        domainError('tm.multiple_entries', `tm: multiple entries for ${JSON.stringify(source)}`),
      )
    }
    const existing = rows[0] as TmEntry
    if (existing.targetText === target && existing.sourceText === source) {
      return ok(undefined)
    }
    this.store.updateText(existing.id, source, target)
    return ok(undefined)
  }
}

/**
 * Go `tm.Nop` 的等价物：永不命中，Add 为 no-op。
 *
 * 用于 `enabled=false` 或尚未接入存储的场景。
 */
export const nopTranslationMemory: TranslationMemory = {
  search: () => ok([]),
  add: () => ok(undefined),
}
