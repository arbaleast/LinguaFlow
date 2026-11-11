/**
 * 模板 Repository：5 类模板的通用 CRUD（对应后端 `service/template.go` 系列）。
 *
 * 5 类模板在后端是 5 张独立的表 + 5 组 DTO，但语义高度同构：
 *
 * | 种类 | 表 | 端点前缀 | 正文字段 |
 * |---|---|---|---|
 * | 翻译提示词 | `translation_prompt_templates` | `/translation-prompt-templates` | `system_prompt_content` |
 * | 术语抽取提示词 | `bootstrap_prompt_templates` | `/bootstrap-prompt-templates` | `content` |
 * | 术语精简提示词 | `prune_prompt_templates` | `/prune-prompt-templates` | `content` |
 * | 执行计划模板 | `execution_plan_templates` | `/execution-plan-templates` | `rounds` + `ruby_retry` + `profile_id` |
 * | 执行策略 | `execution_profiles` | `/execution-profiles` | `config` |
 *
 * 本模块用**一张泛型实现**覆盖 5 类，靠 `TemplateKind` 描述差异，
 * 避免 5 份几乎相同的代码。
 *
 * 语义要点：
 *
 * - **内置条目不可改**：`scope === 'system'` 的行由 `seedBuiltins` 写入，
 *   更新 / 删除一律 409（对齐后端 `ErrBuiltinImmutable`）。
 * - **CAS 写入**：每次写入 `revision += 1`。
 * - **软删**：删除写墓碑，列表按 `deletedAt === null` 过滤。
 */
import type { ApiSchemas } from '@/gateway/contracts'
import type { LinguaFlowDatabase } from '@/infrastructure/indexeddb/db'
import { casWrite, getDeviceId, newRow, softDelete } from '@/infrastructure/indexeddb/repo'
import type { BaseRow, TemplateRow } from '@/infrastructure/indexeddb/types'
import type { Table } from 'dexie'

import { RepositoryConflictError, RepositoryNotFoundError, RepositoryValidationError } from './errors'

/** 模板种类。 */
export type TemplateKind =
  | 'translation_prompt_template'
  | 'bootstrap_prompt_template'
  | 'prune_prompt_template'
  | 'execution_plan_template'
  | 'execution_profile'

/** 模板种类 → 本地表。 */
export function templateTable(
  db: LinguaFlowDatabase,
  kind: TemplateKind,
): Table<TemplateRow, string> {
  switch (kind) {
    case 'translation_prompt_template':
      return db.translation_prompt_templates as unknown as Table<TemplateRow, string>
    case 'bootstrap_prompt_template':
      return db.bootstrap_prompt_templates as unknown as Table<TemplateRow, string>
    case 'prune_prompt_template':
      return db.prune_prompt_templates as unknown as Table<TemplateRow, string>
    case 'execution_plan_template':
      return db.execution_plan_templates as unknown as Table<TemplateRow, string>
    case 'execution_profile':
      return db.execution_profiles as unknown as Table<TemplateRow, string>
  }
}

/** 模板种类 → 自增序列名。 */
function sequenceOf(kind: TemplateKind): string {
  return kind
}

/** 模板种类 → 正文 DTO 字段名。 */
function contentFieldOf(kind: TemplateKind): 'system_prompt_content' | 'content' | null {
  switch (kind) {
    case 'translation_prompt_template':
      return 'system_prompt_content'
    case 'bootstrap_prompt_template':
    case 'prune_prompt_template':
      return 'content'
    default:
      return null
  }
}

/** 模板业务字段。 */
type TemplateFields = Omit<TemplateRow, keyof BaseRow>

/** 按 `localId` 查找模板行（含墓碑）。 */
async function findRow(
  db: LinguaFlowDatabase,
  kind: TemplateKind,
  id: number,
): Promise<TemplateRow | undefined> {
  return templateTable(db, kind).where('localId').equals(id).first()
}

/** 列出未删除模板（按 `localId` 升序，对齐后端 `Order(Asc(FieldID))`）。 */
export async function listTemplates(
  db: LinguaFlowDatabase,
  kind: TemplateKind,
): Promise<TemplateRow[]> {
  return templateTable(db, kind)
    .orderBy('localId')
    .filter((row) => row.deletedAt === null)
    .toArray()
}

/** 读取未删除模板。 */
export async function getTemplate(
  db: LinguaFlowDatabase,
  kind: TemplateKind,
  id: number,
): Promise<TemplateRow | undefined> {
  const row = await findRow(db, kind, id)
  return row && row.deletedAt === null ? row : undefined
}

/** 创建模板。 */
export async function createTemplate(
  db: LinguaFlowDatabase,
  kind: TemplateKind,
  body: Record<string, unknown>,
): Promise<TemplateRow> {
  const name = readName(body.name)
  const description = readOptionalString(body.description) ?? ''
  const deviceId = await getDeviceId(db)

  return db.transaction('rw', templateTable(db, kind), db.sequences, async () => {
    const row = await newRow<TemplateFields>(db, {
      sequence: sequenceOf(kind),
      deviceId,
      fields: {
        name,
        description,
        scope: 'user',
        owner_user_id: null,
        content: readOptionalString(body[contentFieldOf(kind) ?? 'content']) ?? '',
        config: readObject(body.config),
        schema_version: 1,
        profile_id: readOptionalNumber(body.profile_id),
        rounds: readRounds(body.rounds),
        ruby_retry: readObject(body.ruby_retry),
        builtin_id: null,
      },
    })
    await templateTable(db, kind).put(row)
    return row
  })
}

/**
 * 更新模板。
 *
 * 内置条目（`scope === 'system'`）不可修改 → 409。
 */
export async function updateTemplate(
  db: LinguaFlowDatabase,
  kind: TemplateKind,
  id: number,
  body: Record<string, unknown>,
): Promise<TemplateRow> {
  return db.transaction('rw', templateTable(db, kind), async () => {
    const current = await findRow(db, kind, id)
    if (!current || current.deletedAt !== null) {
      throw new RepositoryNotFoundError('模板', id)
    }
    if (current.scope === 'system') {
      throw new RepositoryConflictError('内置模板不可修改')
    }

    const contentField = contentFieldOf(kind)
    const content =
      contentField === null
        ? current.content
        : (readOptionalString(body[contentField]) ?? current.content)

    await casWrite(
      async () => current,
      async (touched) => {
        await templateTable(db, kind).put({
          ...touched,
          name: body.name === undefined ? current.name : readName(body.name),
          description:
            body.description === undefined
              ? current.description
              : (readOptionalString(body.description) ?? current.description),
          content,
          config: body.config === undefined ? current.config : readObject(body.config),
          profile_id:
            body.profile_id === undefined ? current.profile_id : readOptionalNumber(body.profile_id),
          rounds: body.rounds === undefined ? current.rounds : readRounds(body.rounds),
          ruby_retry:
            body.ruby_retry === undefined ? current.ruby_retry : readObject(body.ruby_retry),
        })
      },
      { entity: 'template' },
    )
    return (await findRow(db, kind, id)) as TemplateRow
  })
}

/** 删除模板（软删）。内置条目不可删 → 409。 */
export async function deleteTemplate(
  db: LinguaFlowDatabase,
  kind: TemplateKind,
  id: number,
): Promise<void> {
  const deviceId = await getDeviceId(db)
  await db.transaction('rw', templateTable(db, kind), async () => {
    const current = await findRow(db, kind, id)
    if (!current || current.deletedAt !== null) {
      throw new RepositoryNotFoundError('模板', id)
    }
    if (current.scope === 'system') {
      throw new RepositoryConflictError('内置模板不可删除')
    }
    await templateTable(db, kind).put(softDelete(current, deviceId))
  })
}

/**
 * 模板行 → DTO。
 *
 * 5 类模板的 DTO 字段略有差异：
 *
 * - 翻译提示词用 `system_prompt_content`，另两类提示词用 `content`；
 * - 执行计划模板用 `profile_id` / `rounds` / `ruby_retry`，无正文；
 * - 执行策略用 `config`，无正文。
 */
export function toTemplateDto(
  kind: TemplateKind,
  row: TemplateRow,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: row.localId,
    name: row.name,
    description: row.description,
    scope: row.scope,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
  const contentField = contentFieldOf(kind)
  if (contentField !== null) {
    base[contentField] = row.content
  }
  if (kind === 'execution_plan_template') {
    base.profile_id = row.profile_id ?? -1
    base.rounds = row.rounds ?? []
    if (row.ruby_retry !== null) base.ruby_retry = row.ruby_retry
  }
  if (kind === 'execution_profile') {
    base.config = row.config ?? {}
  }
  return base
}

// ── 输入归一化 ──

function readName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new RepositoryValidationError('name 必须是字符串')
  }
  const name = value.trim()
  if (name === '') throw new RepositoryValidationError('name 不能为空')
  return name
}

function readOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new RepositoryValidationError('字段必须是字符串')
  }
  return value
}

function readOptionalNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RepositoryValidationError('字段必须是数字')
  }
  return value
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new RepositoryValidationError('字段必须是对象')
  }
  return { ...(value as Record<string, unknown>) }
}

/**
 * 读取执行计划模板的轮次列表。
 *
 * `rounds` 的合法类型是**数组**（`ExecutionRoundConfig[]`），
 * 不能用对象读取器（那会把合法输入判为非法）。
 */
function readRounds(value: unknown): unknown[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) {
    throw new RepositoryValidationError('rounds 必须是数组')
  }
  return value.map((item) => ({ ...(item as Record<string, unknown>) }))
}

/** 供路由层使用的 DTO 类型别名（避免在路由文件里重复 import 具体 schema）。 */
export type TemplateDto = ApiSchemas['TranslationPromptTemplate']
