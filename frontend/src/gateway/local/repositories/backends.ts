/**
 * AI 后端 Repository（对应后端 `service/backend.go`）。
 *
 * 后端本身**不保存** API Key：密钥在 `credential_vault`（密文）里，
 * `Backend` 只保存 `credential: {id, version}` 绑定关系。
 * 本地模式沿用同一模型：`backends.credential_id` 指向 `credential_vault` 行。
 */
import type { LinguaFlowDatabase } from '@/infrastructure/indexeddb/db'
import { casWrite, getDeviceId, newRow, softDelete } from '@/infrastructure/indexeddb/repo'
import type { BackendRow, BaseRow } from '@/infrastructure/indexeddb/types'

import { RepositoryNotFoundError, RepositoryValidationError } from './errors'

/** 后端 DTO。 */
export interface BackendDto {
  id: number
  name: string
  type: 'openai' | 'anthropic' | 'google'
  scope: 'user' | 'org'
  options: Record<string, unknown>
  rate_limit_per_minute: number
  has_secret: boolean
  credential: { id: number; version: number }
  owner_user_id?: number
  owner_org_id?: number
}

/** 后端业务字段。 */
type BackendFields = Omit<BackendRow, keyof BaseRow>

/** 读取后端行。 */
async function findRow(
  db: LinguaFlowDatabase,
  backendId: number,
): Promise<BackendRow | undefined> {
  return db.backends.where('localId').equals(backendId).first()
}

/** 列出未删除后端。 */
export async function listBackends(db: LinguaFlowDatabase): Promise<BackendRow[]> {
  return db.backends
    .orderBy('localId')
    .filter((row) => row.deletedAt === null)
    .toArray()
}

/** 读取未删除后端。 */
export async function getBackend(
  db: LinguaFlowDatabase,
  backendId: number,
): Promise<BackendRow | undefined> {
  const row = await findRow(db, backendId)
  return row && row.deletedAt === null ? row : undefined
}

/** 后端行 → DTO。 */
export function toBackendDto(row: BackendRow): BackendDto {
  return {
    id: row.localId,
    name: row.name,
    type: row.backend_type as BackendDto['type'],
    scope: 'user',
    options: row.options,
    rate_limit_per_minute: row.rate_limit_per_minute,
    has_secret: row.credential_id !== null,
    credential: {
      id: row.credential_id ?? 0,
      version: 1,
    },
  }
}

/** 创建后端。 */
export async function createBackend(
  db: LinguaFlowDatabase,
  body: Record<string, unknown>,
): Promise<BackendRow> {
  const name = readName(body.name)
  const type = readType(body.type)
  const options = readOptions(body.options)
  const credentialId = readOptionalNumber(body.credential_id)
  const rateLimit = readOptionalNumber(body.rate_limit_per_minute) ?? 0
  const deviceId = await getDeviceId(db)

  return db.transaction('rw', db.backends, db.sequences, async () => {
    const row = await newRow<BackendFields>(db, {
      sequence: 'backend',
      deviceId,
      fields: {
        name,
        backend_type: type,
        options,
        credential_id: credentialId,
        rate_limit_per_minute: rateLimit,
        enabled: true,
      },
    })
    await db.backends.put(row)
    return row
  })
}

/** 更新后端。 */
export async function updateBackend(
  db: LinguaFlowDatabase,
  backendId: number,
  body: Record<string, unknown>,
): Promise<BackendRow> {
  return db.transaction('rw', db.backends, async () => {
    const current = await findRow(db, backendId)
    if (!current || current.deletedAt !== null) {
      throw new RepositoryNotFoundError('后端', backendId)
    }
    await casWrite(
      async () => current,
      async (touched) => {
        await db.backends.put({
          ...touched,
          name: body.name === undefined ? current.name : readName(body.name),
          backend_type: body.type === undefined ? current.backend_type : readType(body.type),
          options: body.options === undefined ? current.options : readOptions(body.options),
          credential_id:
            body.credential_id === undefined
              ? current.credential_id
              : readOptionalNumber(body.credential_id),
          rate_limit_per_minute:
            body.rate_limit_per_minute === undefined
              ? current.rate_limit_per_minute
              : (readOptionalNumber(body.rate_limit_per_minute) ?? 0),
        })
      },
      { entity: 'backend' },
    )
    return (await findRow(db, backendId)) as BackendRow
  })
}

/** 删除后端（软删）。 */
export async function deleteBackend(
  db: LinguaFlowDatabase,
  backendId: number,
): Promise<void> {
  const deviceId = await getDeviceId(db)
  await db.transaction('rw', db.backends, async () => {
    const current = await findRow(db, backendId)
    if (!current || current.deletedAt !== null) {
      throw new RepositoryNotFoundError('后端', backendId)
    }
    await db.backends.put(softDelete(current, deviceId))
  })
}

// ── 输入归一化 ──

function readName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RepositoryValidationError('name 不能为空')
  }
  return value.trim()
}

function readType(value: unknown): BackendRow['backend_type'] {
  if (value !== 'openai' && value !== 'anthropic' && value !== 'google') {
    throw new RepositoryValidationError('type 必须是 openai / anthropic / google')
  }
  return value
}

function readOptions(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new RepositoryValidationError('options 必须是对象')
  }
  return { ...(value as Record<string, unknown>) }
}

function readOptionalNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RepositoryValidationError('字段必须是数字')
  }
  return value
}
