/**
 * 凭据 Repository（对应后端 `service/credential.go`）。
 *
 * **安全纪律**（对齐 `stores/credentials.ts:59`）：
 *
 * - API Key **只以密文**落盘（AES-GCM 256，见 `infrastructure/crypto/vault.ts`）；
 * - 任何**列表 / 详情 / 版本**响应都**不含** secret（后端同样如此：
 *   「读取永不返回真实 secret」）；
 * - `reveal()` 只供本地执行引擎内部调用，路由层**不暴露**明文端点。
 */
import type { CredentialVault } from '@/infrastructure/crypto/vault'
import type { LinguaFlowDatabase } from '@/infrastructure/indexeddb/db'
import { getDeviceId, nowIso } from '@/infrastructure/indexeddb/repo'
import type { CredentialVaultRow } from '@/infrastructure/indexeddb/types'

import { RepositoryNotFoundError, RepositoryValidationError } from './errors'

/** provider 的默认端点（留空 endpoint 时代入）。 */
const DEFAULT_ENDPOINTS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
}

/** 凭据 DTO（与后端 `service.Credential` 对齐）。 */
export interface CredentialDto {
  id: number
  scope: 'user' | 'org'
  owner_id: number
  provider: 'openai' | 'anthropic' | 'google'
  endpoint: string
  current_version: number
}

/** 凭据版本 DTO。 */
export interface CredentialVersionDto {
  version: number
  revoked: boolean
  created_at: string
}

/** 读取凭据行。 */
async function findRow(
  db: LinguaFlowDatabase,
  credentialId: number,
): Promise<CredentialVaultRow | undefined> {
  return db.credential_vault.where('localId').equals(credentialId).first()
}

/** 列出未删除凭据（按 `localId` 升序）。 */
export async function listCredentials(db: LinguaFlowDatabase): Promise<CredentialVaultRow[]> {
  return db.credential_vault
    .orderBy('localId')
    .filter((row) => row.deletedAt === null)
    .toArray()
}

/** 凭据行 → DTO（**不含** secret）。 */
export function toCredentialDto(row: CredentialVaultRow): CredentialDto {
  return {
    id: row.localId,
    scope: 'user',
    owner_id: 0,
    provider: row.provider as CredentialDto['provider'],
    endpoint: row.endpoint,
    current_version: row.current_version,
  }
}

/** 创建凭据（secret 立即加密）。 */
export async function createCredential(
  db: LinguaFlowDatabase,
  vault: CredentialVault,
  body: Record<string, unknown>,
): Promise<CredentialDto> {
  const provider = readProvider(body.provider)
  const secret = readSecret(body.secret)
  const endpoint = readEndpoint(body.endpoint, provider)
  const { localId } = await vault.put({
    provider,
    name: provider,
    secret,
    endpoint,
  })
  const row = await findRow(db, localId)
  if (!row) throw new RepositoryNotFoundError('凭据', localId)
  return toCredentialDto(row)
}

/** 列出凭据版本（**不含**密文）。 */
export async function listCredentialVersions(
  db: LinguaFlowDatabase,
  credentialId: number,
): Promise<CredentialVersionDto[]> {
  const row = await findRow(db, credentialId)
  if (!row || row.deletedAt !== null) {
    throw new RepositoryNotFoundError('凭据', credentialId)
  }
  return [...row.versions]
    .sort((a, b) => a.version - b.version)
    .map((v) => ({ version: v.version, revoked: v.revoked, created_at: v.created_at }))
}

/** 轮换凭据（新增版本；旧版本标记为已吊销）。 */
export async function rotateCredential(
  db: LinguaFlowDatabase,
  vault: CredentialVault,
  credentialId: number,
  body: Record<string, unknown>,
): Promise<{ id: number; version: number }> {
  const row = await findRow(db, credentialId)
  if (!row || row.deletedAt !== null) {
    throw new RepositoryNotFoundError('凭据', credentialId)
  }
  const secret = readSecret(body.secret)
  const result = await vault.put({
    provider: row.provider,
    name: row.name,
    secret,
    id: row.id,
    endpoint: row.endpoint,
  })
  return { id: result.localId, version: result.version }
}

/** 吊销指定版本。 */
export async function revokeCredentialVersion(
  db: LinguaFlowDatabase,
  credentialId: number,
  version: number,
): Promise<void> {
  const deviceId = await getDeviceId(db)
  await db.transaction('rw', db.credential_vault, async () => {
    const row = await findRow(db, credentialId)
    if (!row || row.deletedAt !== null) {
      throw new RepositoryNotFoundError('凭据', credentialId)
    }
    const target = row.versions.find((v) => v.version === version)
    if (!target) {
      throw new RepositoryNotFoundError('凭据版本', version)
    }
    if (target.revoked) return
    await db.credential_vault.put({
      ...row,
      versions: row.versions.map((v) => (v.version === version ? { ...v, revoked: true } : v)),
      revision: row.revision + 1,
      updatedAt: nowIso(),
      deviceId,
      dirty: true,
    })
  })
}

/**
 * 回收非当前版本的凭据密文（对齐后端 `collect` 语义）。
 *
 * 后端只回收「非当前且无 Job 引用、无执行 lease」的版本；浏览器本地模式没有
 * 运行中的任务引擎，故回收**全部非当前版本**。
 */
export async function collectCredentialVersions(
  db: LinguaFlowDatabase,
  credentialId: number,
): Promise<{ deleted_versions: number }> {
  const deviceId = await getDeviceId(db)
  return db.transaction('rw', db.credential_vault, async () => {
    const row = await findRow(db, credentialId)
    if (!row || row.deletedAt !== null) {
      throw new RepositoryNotFoundError('凭据', credentialId)
    }
    const keep = row.versions.filter((v) => v.version === row.current_version)
    const deleted = row.versions.length - keep.length
    if (deleted === 0) return { deleted_versions: 0 }
    await db.credential_vault.put({
      ...row,
      versions: keep,
      revision: row.revision + 1,
      updatedAt: nowIso(),
      deviceId,
      dirty: true,
    })
    return { deleted_versions: deleted }
  })
}

// ── 输入归一化 ──

function readProvider(value: unknown): 'openai' | 'anthropic' | 'google' {
  if (value !== 'openai' && value !== 'anthropic' && value !== 'google') {
    throw new RepositoryValidationError('provider 必须是 openai / anthropic / google')
  }
  return value
}

function readSecret(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RepositoryValidationError('secret 不能为空')
  }
  return value
}

/** 规范化端点：留空则用 provider 默认值。 */
function readEndpoint(value: unknown, provider: string): string {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_ENDPOINTS[provider] ?? ''
  }
  if (typeof value !== 'string') {
    throw new RepositoryValidationError('endpoint 必须是字符串')
  }
  return value.replace(/\/+$/, '')
}
