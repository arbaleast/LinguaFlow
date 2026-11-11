/**
 * 本地数据恢复（导入）。
 *
 * 恢复语义：
 *
 * - **Schema 版本校验**：备份的 `schemaVersion` 必须 ≤ 当前版本；
 *   高于当前版本说明备份来自更新的应用，**拒绝**导入（避免写坏库）。
 * - **事务级恢复**：全部表在**同一个 Dexie 事务**内写入，
 *   任一表失败 → 整体回滚，原数据不受影响。
 * - **凭据保险库**：备份为 `skipped` 时**保留**本地既有保险库不动；
 *   备份为 `encrypted` 时必须提供口令，解密成功后写入。
 */
import { SCHEMA_VERSION, TABLE_NAMES, type LinguaFlowDatabase } from '@/infrastructure/indexeddb/db'
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BackupError,
  type BackupBundle,
  type BackupImportOptions,
  type BackupImportResult,
  type BackupManifest,
} from './types'
import { decryptCredentialPayload } from './export'
import { readZip } from './zip'

/** 校验并规范化备份清单。 */
export function validateManifest(manifest: BackupManifest): BackupManifest {
  if (!manifest || manifest.format !== BACKUP_FORMAT) {
    throw new BackupError('invalid_format', '不是 LinguaFlow 本地备份文件')
  }
  if (manifest.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new BackupError(
      'unsupported_format_version',
      `备份格式版本 ${manifest.formatVersion} 高于当前支持的 ${BACKUP_FORMAT_VERSION}`,
    )
  }
  if (manifest.schemaVersion > SCHEMA_VERSION) {
    throw new BackupError(
      'schema_version_mismatch',
      `备份的 Schema 版本 ${manifest.schemaVersion} 高于当前应用的 ${SCHEMA_VERSION}，请先升级应用`,
    )
  }
  return manifest
}

/**
 * 恢复备份。
 *
 * @param db 目标数据库
 * @param bundle 备份包
 * @param options 恢复选项
 */
export async function importBackup(
  db: LinguaFlowDatabase,
  bundle: BackupBundle,
  options: BackupImportOptions = {},
): Promise<BackupImportResult> {
  const manifest = validateManifest(bundle.manifest)
  const replace = options.replace ?? true
  const counts: Record<string, number> = {}
  const skipped: Array<{ table: string; reason: string }> = []

  // 先在事务外解密（避免在事务里做异步密码学运算导致事务提前结束）。
  let credentialRows: unknown[] | null = null
  if (manifest.credentialVault === 'encrypted') {
    if (!bundle.credentialVault) {
      throw new BackupError('corrupt_payload', '备份清单声明了加密凭据，但没有凭据负载')
    }
    const plaintext = await decryptCredentialPayload(bundle.credentialVault, options.passphrase ?? '')
    try {
      credentialRows = JSON.parse(plaintext) as unknown[]
    } catch {
      throw new BackupError('corrupt_payload', '凭据负载解密后不是合法 JSON')
    }
  } else {
    skipped.push({ table: 'credential_vault', reason: '备份未包含凭据保险库，保留本地既有数据' })
  }

  const tables = manifest.tables.filter((table) => table !== 'credential_vault')

  await db.transaction('rw', db.tables, async () => {
    for (const table of tables) {
      const rows = bundle.data[table] ?? []
      const target = db.table(table)
      if (replace) {
        await target.clear()
      }
      if (rows.length > 0) {
        await target.bulkPut(rows as never[])
      }
      counts[table] = rows.length
    }
    if (credentialRows) {
      if (replace) {
        await db.credential_vault.clear()
      }
      if (credentialRows.length > 0) {
        await db.credential_vault.bulkPut(credentialRows as never[])
      }
      counts.credential_vault = credentialRows.length
    }
  })

  return {
    counts,
    credentialsRestored: credentialRows !== null,
    skipped,
  }
}

/**
 * 从 ZIP 归档恢复。
 *
 * 归档结构见 `exportBackupZip`。
 */
export async function importBackupZip(
  db: LinguaFlowDatabase,
  zip: Uint8Array,
  options: BackupImportOptions = {},
): Promise<BackupImportResult> {
  const entries = await readZip(zip)
  const decoder = new TextDecoder()
  let manifest: BackupManifest | null = null
  const data: Record<string, unknown[]> = {}
  let credentialVault: BackupBundle['credentialVault']

  for (const entry of entries) {
    if (entry.name === 'manifest.json') {
      manifest = JSON.parse(decoder.decode(entry.data)) as BackupManifest
      continue
    }
    if (entry.name === 'credential_vault.json') {
      credentialVault = JSON.parse(decoder.decode(entry.data)) as BackupBundle['credentialVault']
      continue
    }
    if (entry.name.startsWith('data/') && entry.name.endsWith('.json')) {
      const table = entry.name.slice('data/'.length, -'.json'.length)
      data[table] = JSON.parse(decoder.decode(entry.data)) as unknown[]
    }
  }

  if (!manifest) {
    throw new BackupError('corrupt_payload', 'ZIP 归档中缺少 manifest.json')
  }

  const bundle: BackupBundle = { manifest, data }
  if (credentialVault) {
    bundle.credentialVault = credentialVault
  }
  return importBackup(db, bundle, options)
}

/** 清空全部业务表（保留 `kv_meta` 里的设备号与序列发号器）。 */
export async function clearLocalData(db: LinguaFlowDatabase): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    for (const table of TABLE_NAMES) {
      if (table === 'kv_meta' || table === 'sequences') continue
      await db.table(table).clear()
    }
  })
}
