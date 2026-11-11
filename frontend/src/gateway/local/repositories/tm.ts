/**
 * 翻译记忆 Repository（对应后端 `internal/tm` 的 SQLite 部分）。
 *
 * ## 为什么没有路由文件
 *
 * `frontend/src/api/` 中**不存在任何 TM 端点**（已 grep 全量确认）：
 * TM 只由后端在翻译流水线内部查询/写入，前端没有对应的 REST 契约。
 * 因此本文件只提供 Repository，供 Phase 2 的本地翻译 Worker 直接调用，
 * 不注册 `LocalRoute`。
 *
 * ## 匹配语义
 *
 * 完全复用 `domain/tm`：
 *
 * - `source_hash = sourceHash(source) = fullHash(goTrimSpace(source))`；
 * - 语言对精确相等（仅 trim，不做大小写归一）；
 * - 结果为 `usage_count DESC, localId ASC`；
 * - 命中后每个命中行的 `usage_count += 1` 并落库。
 *
 * 写入语义对齐 `ScopedTranslationMemory.add`：空字段静默忽略、完全一致 noop、
 * 同键多行视为历史脏数据（抛 409）。
 */
import type { LinguaFlowDatabase } from '@/infrastructure/indexeddb/db'
import { getDeviceId, newRow, touch } from '@/infrastructure/indexeddb/repo'
import type { BaseRow, TmEntryRow } from '@/infrastructure/indexeddb/types'
import { goTrimSpace, sourceHash } from '@/domain/tm'

import { RepositoryConflictError } from './errors'
import { requireProject } from './projects'

/**
 * `searchTm` 的查询条件。
 *
 * 同时接受行字段（snake_case）与领域层字段（camelCase），便于 Worker 直接
 * 复用 `domain/tm` 的调用习惯；两者都提供时 snake_case 优先。
 */
export interface SearchTmOptions {
  /** 待查原文（内部会 trim 后哈希）。 */
  source: string
  /** 源语言。 */
  source_lang?: string
  /** 源语言（camelCase 别名）。 */
  sourceLang?: string
  /** 目标语言。 */
  target_lang?: string
  /** 目标语言（camelCase 别名）。 */
  targetLang?: string
}

/**
 * `addTm` 的写入内容。
 *
 * 字段命名同 `SearchTmOptions`：snake_case 为主，camelCase 为兼容别名。
 */
export interface AddTmInput {
  source_text?: string
  target_text?: string
  source_lang?: string
  target_lang?: string
  sourceText?: string
  targetText?: string
  sourceLang?: string
  targetLang?: string
}

/** 翻译记忆业务字段（`newRow` 的 `fields` 参数）。 */
type TmFields = Omit<TmEntryRow, keyof BaseRow>

/**
 * 精确匹配查询。
 *
 * 无命中返回空数组；有命中时按 `usage_count DESC, localId ASC` 返回，
 * 并在**同一事务**内把每行的 `usage_count` +1。
 *
 * 返回的是自增计数后的行副本（已落库），便于调用方直接读取最新计数。
 */
export async function searchTm(
  db: LinguaFlowDatabase,
  projectId: number,
  options: SearchTmOptions,
): Promise<TmEntryRow[]> {
  const hash = sourceHash(options.source)
  const sourceLang = goTrimSpace(options.source_lang ?? options.sourceLang ?? '')
  const targetLang = goTrimSpace(options.target_lang ?? options.targetLang ?? '')

  return db.transaction('rw', db.tm_entries, async () => {
    const rows = await db.tm_entries
      .where('[project_id+source_hash]')
      .equals([projectId, hash])
      .filter(
        (row) =>
          row.deletedAt === null &&
          row.source_lang === sourceLang &&
          row.target_lang === targetLang,
      )
      .toArray()
    if (rows.length === 0) return []

    // 后端 SQL：ORDER BY usage_count DESC, id ASC。
    const hits = [...rows].sort(
      (left, right) => right.usage_count - left.usage_count || left.localId - right.localId,
    )
    const updated = hits.map((row) => ({
      ...touch(row, row.deviceId),
      usage_count: row.usage_count + 1,
    }))
    await db.tm_entries.bulkPut(updated)
    return updated
  })
}

/**
 * 新建 / 更新 / noop。
 *
 * - 任一字段 trim 后为空 → 返回 `null`（静默忽略，对齐 Go 的 fail-open）；
 * - 同键无行 → 新建（`usage_count = 0`）；
 * - 同键恰好一行且原文/译文完全一致 → 原样返回（noop）；
 * - 同键恰好一行但文本不同 → 更新原文/译文并返回；
 * - 同键多行（历史脏数据）→ 抛 409。
 */
export async function addTm(
  db: LinguaFlowDatabase,
  projectId: number,
  input: AddTmInput,
): Promise<TmEntryRow | null> {
  const source = goTrimSpace(input.source_text ?? input.sourceText ?? '')
  const target = goTrimSpace(input.target_text ?? input.targetText ?? '')
  const sourceLang = goTrimSpace(input.source_lang ?? input.sourceLang ?? '')
  const targetLang = goTrimSpace(input.target_lang ?? input.targetLang ?? '')
  if (source === '' || target === '' || sourceLang === '' || targetLang === '') {
    return null
  }

  const hash = sourceHash(source)
  const deviceId = await getDeviceId(db)

  return db.transaction('rw', db.projects, db.tm_entries, db.sequences, async () => {
    await requireProject(db, projectId)
    const rows = await db.tm_entries
      .where('[project_id+source_hash]')
      .equals([projectId, hash])
      .filter(
        (row) =>
          row.deletedAt === null &&
          row.source_lang === sourceLang &&
          row.target_lang === targetLang,
      )
      .toArray()

    if (rows.length === 0) {
      const row = await newRow<TmFields>(db, {
        sequence: 'tm_entry',
        deviceId,
        fields: {
          project_id: projectId,
          source_text: source,
          target_text: target,
          source_lang: sourceLang,
          target_lang: targetLang,
          source_hash: hash,
          usage_count: 0,
        },
      })
      await db.tm_entries.put(row)
      return row
    }

    if (rows.length > 1) {
      throw new RepositoryConflictError(`翻译记忆存在多条相同键的记录：${source}`)
    }

    const existing = rows[0] as TmEntryRow
    if (existing.source_text === source && existing.target_text === target) {
      return existing
    }
    const updated: TmEntryRow = {
      ...touch(existing, existing.deviceId),
      source_text: source,
      target_text: target,
    }
    await db.tm_entries.put(updated)
    return updated
  })
}
