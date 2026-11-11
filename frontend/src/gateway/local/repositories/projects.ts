/**
 * 项目 Repository（对应后端 `service/project.go` + `handler_project.go`）。
 *
 * 设计要点：
 *
 * - **行 → DTO 单向映射**：Repository 内部只读写 `ProjectRow`，所有 HTTP 可见的
 *   字段名/时间格式由 `toProjectDto` 统一转换（snake_case、ISO 字符串、数字 ID）。
 * - **CAS 写入**：`updateProject` 走 `casWrite`，每次写入 `revision += 1`；
 *   与后端 `UpdateProject` 一致，更新同时 `output_generation += 1`。
 * - **软删级联**：删除项目写墓碑，并在**同一 Dexie 事务**内把该项目下的
 *   资源 / 术语 / TM 一并写墓碑（对齐后端 `cascadeDeleteProject` 的删除范围；
 *   段落表由另一位同事负责，此处不触碰）。
 * - **本地默认存储空间**：浏览器本地模式没有服务端 storage_space 表，项目统一
 *   绑定到本地默认空间（ID 见 `LOCAL_DEFAULT_STORAGE_SPACE_ID`），与后端
 *   `selectSpace` 的「未指定则用默认空间」语义对应。
 */
import type { ApiSchemas } from '@/gateway/contracts'
import type { LinguaFlowDatabase } from '@/infrastructure/indexeddb/db'
import { casWrite, getDeviceId, newRow, softDelete } from '@/infrastructure/indexeddb/repo'
import type { BaseRow, ProjectRow } from '@/infrastructure/indexeddb/types'
import type { Table } from 'dexie'

import { RepositoryNotFoundError, RepositoryValidationError } from './errors'

type CreateProjectRequest = ApiSchemas['CreateProjectRequest']
type UpdateProjectRequest = ApiSchemas['UpdateProjectRequest']
type Project = ApiSchemas['Project']

/**
 * 浏览器本地模式的默认存储空间 ID。
 *
 * 后端在创建项目时若未显式指定空间，会落到站点默认空间；浏览器本地模式
 * 只有一个逻辑空间，统一使用 1，使 `Project.storage_space_id` 保持非空，
 * 避免依赖存储空间的 UI 进入「未绑定」分支。
 */
export const LOCAL_DEFAULT_STORAGE_SPACE_ID = 1

/** 项目业务字段（`newRow` 的 `fields` 参数）。 */
type ProjectFields = Omit<ProjectRow, keyof BaseRow>

/** 按 `localId` 查找项目行（**包含墓碑**，供内部存在性判断）。 */
async function findProjectRow(
  db: LinguaFlowDatabase,
  projectId: number,
): Promise<ProjectRow | undefined> {
  return db.projects.where('localId').equals(projectId).first()
}

/** 列出未删除项目，按 `localId` 升序（对齐后端 `Order(Asc(FieldID))`）。 */
export async function listProjects(db: LinguaFlowDatabase): Promise<ProjectRow[]> {
  return db.projects
    .orderBy('localId')
    .filter((row) => row.deletedAt === null)
    .toArray()
}

/** 按 `localId` 读取未删除项目；不存在或已软删返回 `undefined`。 */
export async function getProject(
  db: LinguaFlowDatabase,
  projectId: number,
): Promise<ProjectRow | undefined> {
  const row = await findProjectRow(db, projectId)
  return row && row.deletedAt === null ? row : undefined
}

/** 读取项目，不存在时抛 `RepositoryNotFoundError`（路由层映射 404）。 */
export async function requireProject(
  db: LinguaFlowDatabase,
  projectId: number,
): Promise<ProjectRow> {
  const row = await getProject(db, projectId)
  if (!row) throw new RepositoryNotFoundError('项目', projectId)
  return row
}

/**
 * 创建项目。
 *
 * 默认值对齐后端 `normalizeCreateInput` 与 `CreateProject`：
 * `source_lang` 缺省 `auto`、`target_lang` 缺省 `zh`、术语开关缺省 false、
 * 配置缺省空对象；`storage_generation` / `output_generation` 从 1 开始，
 * `storage_state` 为 `active`。
 */
export async function createProject(
  db: LinguaFlowDatabase,
  body: CreateProjectRequest,
): Promise<ProjectRow> {
  const name = readRequiredName(body.name)
  const sourceLang = normalizeLang(body.source_lang, 'auto')
  const targetLang = normalizeLang(body.target_lang, 'zh')
  const config = readConfig(body.config) ?? {}
  const glossaryEnabled = readOptionalBoolean(body.glossary_enabled, 'glossary_enabled') ?? false
  const deviceId = await getDeviceId(db)

  return db.transaction('rw', db.projects, db.sequences, async () => {
    const row = await newRow<ProjectFields>(db, {
      sequence: 'project',
      deviceId,
      fields: {
        name,
        source_lang: sourceLang,
        target_lang: targetLang,
        glossary_enabled: glossaryEnabled,
        config,
        storage_space_id: LOCAL_DEFAULT_STORAGE_SPACE_ID,
        storage_generation: 1,
        output_generation: 1,
        storage_state: 'active',
        owner_user_id: null,
      },
    })
    await db.projects.put(row)
    return row
  })
}

/**
 * 更新项目。
 *
 * 字段归一化对齐后端 `normalizeUpdateInput`：
 *
 * - `name` 缺失或 trim 后为空 → 保留原值；
 * - `config` 缺失或空对象 → 保留原值；
 * - `glossary_enabled` 缺失 → 保留原值；
 * - `source_lang` / `target_lang` 缺失或为空 → 保留原值。
 *
 * 无论是否有字段实际变化，`output_generation` 都 +1（后端 `AddOutputGeneration(1)`）。
 */
export async function updateProject(
  db: LinguaFlowDatabase,
  projectId: number,
  body: UpdateProjectRequest,
): Promise<ProjectRow> {
  return db.transaction('rw', db.projects, async () => {
    const current = await findProjectRow(db, projectId)
    if (!current || current.deletedAt !== null) {
      throw new RepositoryNotFoundError('项目', projectId)
    }

    const name = readUpdatedName(body.name, current.name)
    const config = readConfig(body.config) ?? { ...current.config }
    const glossaryEnabled =
      readOptionalBoolean(body.glossary_enabled, 'glossary_enabled') ?? current.glossary_enabled
    const sourceLang = normalizeLang(body.source_lang, current.source_lang)
    const targetLang = normalizeLang(body.target_lang, current.target_lang)
    const outputGeneration = current.output_generation + 1

    await casWrite(
      async () => current,
      async (touched) => {
        await db.projects.put({
          ...touched,
          name,
          config: Object.keys(config).length === 0 ? { ...current.config } : config,
          glossary_enabled: glossaryEnabled,
          source_lang: sourceLang,
          target_lang: targetLang,
          output_generation: outputGeneration,
        })
      },
      { entity: 'project' },
    )

    return (await findProjectRow(db, projectId)) as ProjectRow
  })
}

/**
 * 删除项目（软删墓碑 + 级联软删）。
 *
 * 与后端级联删除范围一致：resources / glossary_entries / tm_entries。
 * 段落、任务等表不属于本 Repository 的职责，保持原样。
 */
export async function deleteProject(db: LinguaFlowDatabase, projectId: number): Promise<void> {
  const deviceId = await getDeviceId(db)
  await db.transaction(
    'rw',
    db.projects,
    db.resources,
    db.glossary_entries,
    db.tm_entries,
    async () => {
      const current = await findProjectRow(db, projectId)
      if (!current || current.deletedAt !== null) {
        throw new RepositoryNotFoundError('项目', projectId)
      }
      await db.projects.put(softDelete(current, deviceId))
      await tombstoneProjectRows(db.resources, projectId, deviceId)
      await tombstoneProjectRows(db.glossary_entries, projectId, deviceId)
      await tombstoneProjectRows(db.tm_entries, projectId, deviceId)
    },
  )
}

/** 项目行 → OpenAPI `Project` DTO（字段名、时间格式与后端逐项一致）。 */
export function toProjectDto(row: ProjectRow): Project {
  return {
    id: row.localId,
    name: row.name,
    source_lang: row.source_lang,
    target_lang: row.target_lang,
    glossary_enabled: row.glossary_enabled,
    storage_space_id: row.storage_space_id,
    storage_generation: row.storage_generation,
    output_generation: row.output_generation,
    storage_state: row.storage_state,
    ...(row.owner_user_id === null ? {} : { owner_user_id: row.owner_user_id }),
    ...(Object.keys(row.config).length === 0 ? {} : { config: { ...row.config } }),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

/** 该项目下的行统一写墓碑（查询已过滤墓碑，无需重复处理）。 */
async function tombstoneProjectRows<T extends BaseRow & { project_id: number }>(
  table: Table<T, string>,
  projectId: number,
  deviceId: string,
): Promise<void> {
  const rows = await table
    .where('project_id')
    .equals(projectId)
    .filter((row) => row.deletedAt === null)
    .toArray()
  if (rows.length === 0) return
  await table.bulkPut(rows.map((row) => softDelete(row, deviceId)))
}

// ── 输入归一化（运行时校验，防止调用方绕过 TS 类型） ──

function readRequiredName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new RepositoryValidationError('name 必须是字符串')
  }
  const name = value.trim()
  if (name === '') throw new RepositoryValidationError('name 不能为空')
  return name
}

function readUpdatedName(value: unknown, fallback: string): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string') {
    throw new RepositoryValidationError('name 必须是字符串')
  }
  const name = value.trim()
  return name === '' ? fallback : name
}

function normalizeLang(value: unknown, fallback: string): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string') {
    throw new RepositoryValidationError('语言代码必须是字符串')
  }
  const lang = value.trim()
  return lang === '' ? fallback : lang
}

function readOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new RepositoryValidationError(`${field} 必须是布尔值`)
  }
  return value
}

function readConfig(value: unknown): Record<string, unknown> | undefined {
  // Go 把 JSON null 解码成 nil map，等价于「未提供」。
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new RepositoryValidationError('config 必须是对象')
  }
  return { ...(value as Record<string, unknown>) }
}
