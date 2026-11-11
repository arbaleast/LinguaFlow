/**
 * 术语表 Repository（对应后端 `service/glossary.go` + `handler_glossary.go`）。
 *
 * ## 条件唯一约束
 *
 * 与后端完全一致（`createGlossaryEntry` / `UpdateEntry`）：
 *
 * - 非禁译条目：`(project_id, source_key)` 唯一；
 * - 禁译条目：`(project_id, source_key, target)` 唯一。
 *
 * `source_key` 是 `strings.ToLower(strings.TrimSpace(source))` 的等价物，
 * 因此 `Term` / ` term ` 会命中同一条唯一键。
 *
 * **检查与写入必须落在同一个 Dexie 事务里**：Dexie 对同一张表的读写事务
 * 串行化，避免两个并发创建都读到「不存在」后同时写入。
 *
 * ## CSV 导出
 *
 * 直接复用 `domain/glossary` 的 `serializeCSV`（Go `encoding/csv` 的逐字节移植），
 * 行顺序对齐后端 `ExportCSV` → `ListEntries`：`source_key` 升序、`localId` 升序。
 */
import type { ApiSchemas } from '@/gateway/contracts'
import type { LinguaFlowDatabase } from '@/infrastructure/indexeddb/db'
import { getDeviceId, newRow, softDelete, touch } from '@/infrastructure/indexeddb/repo'
import type { BaseRow, GlossaryEntryRow } from '@/infrastructure/indexeddb/types'
import { goToLower, goTrimSpace, serializeCSV } from '@/domain/glossary'

import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  RepositoryValidationError,
} from './errors'
import { compareUtf8 } from './order'
import { requireProject } from './projects'

type CreateGlossaryEntryRequest = ApiSchemas['CreateGlossaryEntryRequest']
type UpdateGlossaryEntryRequest = ApiSchemas['UpdateGlossaryEntryRequest']
type GlossaryEntry = ApiSchemas['GlossaryEntry']

/** 术语业务字段（`newRow` 的 `fields` 参数）。 */
type GlossaryFields = Omit<GlossaryEntryRow, keyof BaseRow>

/** 归一化后的术语输入（唯一约束检查的入参）。 */
interface NormalizedGlossaryInput {
  source: string
  target: string
  sourceKey: string
  caseSensitive: boolean
  forbidden: boolean
  mandatory: boolean
  notes: string
}

/** 更新结果：行 + 后端语义的 `target_changed`。 */
export interface GlossaryUpdateResult {
  row: GlossaryEntryRow
  /** 驼峰别名（Repository 内部惯用）。 */
  targetChanged: boolean
  /** 后端 DTO 字段名，路由层可直接展开到响应体。 */
  target_changed: boolean
}

/** 列出项目下未删除术语，按 `localId` 升序。 */
export async function listGlossary(
  db: LinguaFlowDatabase,
  projectId: number,
): Promise<GlossaryEntryRow[]> {
  return db.glossary_entries
    .where('project_id')
    .equals(projectId)
    .filter((row) => row.deletedAt === null)
    .sortBy('localId')
}

/** 创建术语条目；违反条件唯一约束时抛 `RepositoryConflictError`（409）。 */
export async function createGlossaryEntry(
  db: LinguaFlowDatabase,
  projectId: number,
  body: CreateGlossaryEntryRequest,
): Promise<GlossaryEntryRow> {
  const input = normalizeCreateInput(body)
  const deviceId = await getDeviceId(db)

  return db.transaction('rw', db.projects, db.glossary_entries, db.sequences, async () => {
    await requireProject(db, projectId)
    const conflict = await findConflict(db, projectId, input)
    if (conflict) throw new RepositoryConflictError('术语条目已存在')

    const row = await newRow<GlossaryFields>(db, {
      sequence: 'glossary_entry',
      deviceId,
      fields: {
        project_id: projectId,
        source: input.source,
        target: input.target,
        source_key: input.sourceKey,
        case_sensitive: input.caseSensitive,
        forbidden: input.forbidden,
        mandatory: input.mandatory,
        notes: input.notes,
      },
    })
    await db.glossary_entries.put(row)
    return row
  })
}

/**
 * 更新术语条目。
 *
 * 字段缺省语义对齐后端 handler:
 * - `forbidden` / `mandatory` 缺省 → 保留行上的原值；
 * - `case_sensitive` / `notes` 缺省 → 重置为 Go 零值（`false` / `''`），
 *   因为后端请求结构体里它们是值类型而非指针。
 *
 * 候选项的唯一键若被其他行占用（墓碑除外）则抛 409。
 */
export async function updateGlossaryEntry(
  db: LinguaFlowDatabase,
  projectId: number,
  entryId: number,
  body: UpdateGlossaryEntryRequest,
): Promise<GlossaryUpdateResult> {
  return db.transaction('rw', db.projects, db.glossary_entries, async () => {
    await requireProject(db, projectId)
    const current = await db.glossary_entries.where('localId').equals(entryId).first()
    if (!current || current.project_id !== projectId || current.deletedAt !== null) {
      throw new RepositoryNotFoundError('术语条目', entryId)
    }

    const input = normalizeUpdateInput(body, current)
    const conflict = await findConflict(db, projectId, input, current.localId)
    if (conflict) throw new RepositoryConflictError('术语条目已存在')

    const updated: GlossaryEntryRow = {
      ...touch(current, current.deviceId),
      source: input.source,
      target: input.target,
      source_key: input.sourceKey,
      case_sensitive: input.caseSensitive,
      forbidden: input.forbidden,
      mandatory: input.mandatory,
      notes: input.notes,
    }
    await db.glossary_entries.put(updated)
    const targetChanged = current.target !== input.target
    return { row: updated, targetChanged, target_changed: targetChanged }
  })
}

/** 删除术语条目（软删墓碑）；不存在时抛 404。 */
export async function deleteGlossaryEntry(
  db: LinguaFlowDatabase,
  projectId: number,
  entryId: number,
): Promise<void> {
  await db.transaction('rw', db.projects, db.glossary_entries, async () => {
    await requireProject(db, projectId)
    const current = await db.glossary_entries.where('localId').equals(entryId).first()
    if (!current || current.project_id !== projectId || current.deletedAt !== null) {
      throw new RepositoryNotFoundError('术语条目', entryId)
    }
    await db.glossary_entries.put(softDelete(current, current.deviceId))
  })
}

/**
 * 导出 CSV 文本。
 *
 * 输出与后端 `GET /projects/{projectId}/glossary/export` 一致：表头
 * `source,target,case_sensitive,forbidden,mandatory,notes`，`\n` 行尾，
 * 仅必要时加引号（Go `encoding/csv` 规则）。
 */
export async function exportGlossaryCsv(
  db: LinguaFlowDatabase,
  projectId: number,
): Promise<string> {
  await requireProject(db, projectId)
  const rows = await listGlossary(db, projectId)
  // 后端 ExportCSV 走 ListEntries：source_key ASC, id ASC。
  rows.sort((left, right) => {
    const bySourceKey = compareUtf8(left.source_key, right.source_key)
    return bySourceKey !== 0 ? bySourceKey : left.localId - right.localId
  })

  return serializeCSV(
    rows.map((row) => ({
      source: row.source,
      target: row.target,
      caseSensitive: row.case_sensitive,
      forbidden: row.forbidden,
      mandatory: row.mandatory,
      notes: row.notes,
    })),
  )
}

/** 术语行 → OpenAPI `GlossaryEntry` DTO。 */
export function toGlossaryDto(row: GlossaryEntryRow): GlossaryEntry {
  return {
    id: row.localId,
    source: row.source,
    target: row.target,
    case_sensitive: row.case_sensitive,
    forbidden: row.forbidden,
    mandatory: row.mandatory,
    ...(row.notes === '' ? {} : { notes: row.notes }),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

/**
 * 在事务内查找唯一键冲突行（墓碑与自身不参与）。
 *
 * 索引 `[project_id+source_key]` 先缩小到同源词，再按 forbidden（及禁译的
 * target）精确过滤——与后端 existsQuery 的条件一一对应。
 */
async function findConflict(
  db: LinguaFlowDatabase,
  projectId: number,
  input: NormalizedGlossaryInput,
  excludeLocalId?: number,
): Promise<GlossaryEntryRow | undefined> {
  return db.glossary_entries
    .where('[project_id+source_key]')
    .equals([projectId, input.sourceKey])
    .filter(
      (row) =>
        row.deletedAt === null &&
        row.forbidden === input.forbidden &&
        (excludeLocalId === undefined || row.localId !== excludeLocalId) &&
        (!input.forbidden || row.target === input.target),
    )
    .first()
}

function normalizeCreateInput(body: CreateGlossaryEntryRequest): NormalizedGlossaryInput {
  const source = goTrimSpace(readString(body.source, 'source'))
  const target = goTrimSpace(readString(body.target, 'target'))
  if (source === '' || target === '') {
    throw new RepositoryValidationError('source 与 target 不能为空')
  }
  return {
    source,
    target,
    sourceKey: goToLower(source),
    caseSensitive: readBoolean(body.case_sensitive, 'case_sensitive') ?? false,
    forbidden: readBoolean(body.forbidden, 'forbidden') ?? false,
    // OpenAPI 默认 mandatory=true；与后端 normalizeGlossaryEntryInput 一致。
    mandatory: readBoolean(body.mandatory, 'mandatory') ?? true,
    notes: goTrimSpace(readOptionalString(body.notes, 'notes') ?? ''),
  }
}

function normalizeUpdateInput(
  body: UpdateGlossaryEntryRequest,
  current: GlossaryEntryRow,
): NormalizedGlossaryInput {
  const source = goTrimSpace(readString(body.source, 'source'))
  const target = goTrimSpace(readString(body.target, 'target'))
  if (source === '' || target === '') {
    throw new RepositoryValidationError('source 与 target 不能为空')
  }
  return {
    source,
    target,
    sourceKey: goToLower(source),
    // 后端 update 请求里 case_sensitive / notes 是值类型：缺省即零值。
    caseSensitive: readBoolean(body.case_sensitive, 'case_sensitive') ?? false,
    forbidden: readBoolean(body.forbidden, 'forbidden') ?? current.forbidden,
    mandatory: readBoolean(body.mandatory, 'mandatory') ?? current.mandatory,
    notes: goTrimSpace(readOptionalString(body.notes, 'notes') ?? ''),
  }
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new RepositoryValidationError(`${field} 必须是字符串`)
  }
  return value
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  return readString(value, field)
}

function readBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new RepositoryValidationError(`${field} 必须是布尔值`)
  }
  return value
}
