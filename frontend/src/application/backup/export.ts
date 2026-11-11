/**
 * 本地数据导出。
 *
 * 导出内容 = 全部业务表 + 基础设施表的**行数据**（JSON 可表达的部分）。
 *
 * 二进制（OPFS / `raw_blobs` 的本体）**默认不内联**——它们体积大且不属于
 * 「配置与文本」；需要完整迁移时可打开 `includeBlobs`。
 */
import { SCHEMA_VERSION, TABLE_NAMES, type LinguaFlowDatabase } from '@/infrastructure/indexeddb/db'
import { nowIso } from '@/infrastructure/indexeddb/repo'
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BackupError,
  type BackupBundle,
  type BackupExportOptions,
  type BackupManifest,
  type EncryptedCredentialPayload,
} from './types'
import { createZip, type ZipEntry } from './zip'

/** PBKDF2 迭代次数（与 Web Crypto 建议量级一致）。 */
export const BACKUP_KDF_ITERATIONS = 210_000

/** 把字节数组编码为 base64。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number)
  }
  return btoa(binary)
}

/** 把 base64 解码回字节数组。 */
export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/** 口令 → AES-GCM 密钥（PBKDF2-HMAC-SHA256）。 */
async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** 用口令加密凭据保险库负载。 */
export async function encryptCredentialPayload(
  plaintext: string,
  passphrase: string,
): Promise<EncryptedCredentialPayload> {
  if (!passphrase) {
    throw new BackupError('missing_passphrase', '导出凭据保险库必须提供口令')
  }
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(passphrase, salt, BACKUP_KDF_ITERATIONS)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext),
  )
  return {
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    kdf: { iterations: BACKUP_KDF_ITERATIONS, hash: 'SHA-256' },
  }
}

/** 用口令解密凭据保险库负载。 */
export async function decryptCredentialPayload(
  payload: EncryptedCredentialPayload,
  passphrase: string,
): Promise<string> {
  if (!passphrase) {
    throw new BackupError('missing_passphrase', '恢复凭据保险库必须提供口令')
  }
  const salt = base64ToBytes(payload.salt)
  const iv = base64ToBytes(payload.iv)
  const key = await deriveKey(passphrase, salt, payload.kdf.iterations)
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      base64ToBytes(payload.ciphertext) as BufferSource,
    )
    return new TextDecoder().decode(plaintext)
  } catch {
    throw new BackupError('invalid_passphrase', '口令错误或凭据密文已损坏')
  }
}

/** 导出选项的内部默认值。 */
function resolveOptions(options: BackupExportOptions): Required<BackupExportOptions> {
  const includeSecrets = options.includeSecrets ?? false
  if (includeSecrets && !options.passphrase) {
    throw new BackupError('missing_passphrase', '导出凭据保险库必须提供口令')
  }
  return {
    includeSecrets,
    passphrase: options.passphrase ?? '',
    includeBlobs: options.includeBlobs ?? false,
  }
}

/**
 * 导出本地数据为备份包（JSON 形态）。
 *
 * @param db 本地数据库
 * @param options 导出选项
 */
export async function exportBackup(
  db: LinguaFlowDatabase,
  options: BackupExportOptions = {},
): Promise<BackupBundle> {
  const resolved = resolveOptions(options)
  const data: Record<string, unknown[]> = {}
  const counts: Record<string, number> = {}
  const tables: typeof TABLE_NAMES[number][] = []

  for (const table of TABLE_NAMES) {
    if (table === 'credential_vault') continue
    if (table === 'raw_blobs' && !resolved.includeBlobs) continue
    const rows = await db.table(table).toArray()
    data[table] = rows
    counts[table] = rows.length
    tables.push(table)
  }

  let credentialVault: EncryptedCredentialPayload | undefined
  const credentialRows = await db.credential_vault.toArray()
  if (resolved.includeSecrets) {
    credentialVault = await encryptCredentialPayload(JSON.stringify(credentialRows), resolved.passphrase)
    counts.credential_vault = credentialRows.length
    tables.push('credential_vault')
  }

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    createdAt: nowIso(),
    tables,
    counts,
    credentialVault: resolved.includeSecrets ? 'encrypted' : 'skipped',
    blobs: resolved.includeBlobs ? 'inline' : 'skipped',
  }

  return { manifest, data, credentialVault }
}

/**
 * 导出本地数据为 ZIP 归档。
 *
 * 归档结构：
 *
 * ```text
 * manifest.json          # 备份清单
 * data/<table>.json      # 每张表的行数据
 * credential_vault.json  # 仅在被口令加密时存在
 * ```
 *
 * @returns ZIP 字节流（可直接 `new Blob([bytes])` 后触发下载）
 */
export async function exportBackupZip(
  db: LinguaFlowDatabase,
  options: BackupExportOptions = {},
): Promise<Uint8Array> {
  const bundle = await exportBackup(db, options)
  const encoder = new TextEncoder()
  const entries: ZipEntry[] = [
    { name: 'manifest.json', data: encoder.encode(JSON.stringify(bundle.manifest, null, 2)) },
  ]
  for (const table of bundle.manifest.tables) {
    const rows = bundle.data[table] ?? []
    entries.push({
      name: `data/${table}.json`,
      data: encoder.encode(JSON.stringify(rows)),
    })
  }
  if (bundle.credentialVault) {
    entries.push({
      name: 'credential_vault.json',
      data: encoder.encode(JSON.stringify(bundle.credentialVault)),
    })
  }
  return createZip(entries, true)
}
