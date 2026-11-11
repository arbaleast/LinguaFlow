/**
 * 本地备份导出 / 恢复的单元测试。
 *
 * 覆盖：清单校验、Schema 版本闸门、事务级恢复、凭据保险库的跳过与口令加密、
 * ZIP 打包 / 解包的往返一致性。
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BACKUP_FORMAT,
  BackupError,
  clearLocalData,
  exportBackup,
  exportBackupZip,
  importBackup,
  importBackupZip,
  type BackupBundle,
} from '../index'
import { SCHEMA_VERSION, closeDatabase, openDatabase, type LinguaFlowDatabase } from '@/infrastructure/indexeddb/db'

let db: LinguaFlowDatabase

/** 造一条最小可用的项目行。 */
function projectRow(id: string, name: string) {
  return {
    id,
    localId: 1,
    name,
    storage_space_id: 'space-1',
    storage_generation: 1,
    output_generation: 1,
    storage_state: 'ready',
    glossary_enabled: true,
    source_lang: 'en',
    target_lang: 'zh',
    config: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    revision: 1,
    deletedAt: null,
    deviceId: 'device-1',
    dirty: false,
  }
}

beforeEach(async () => {
  await closeDatabase()
  db = await openDatabase(`backup-test-${Math.random().toString(36).slice(2)}`)
})

afterEach(async () => {
  await closeDatabase()
})

describe('本地备份 —— 导出', () => {
  it('导出全部表并写明行数', async () => {
    await db.projects.put(projectRow('p1', '项目一') as never)
    await db.projects.put(projectRow('p2', '项目二') as never)

    const bundle = await exportBackup(db)

    expect(bundle.manifest.format).toBe(BACKUP_FORMAT)
    expect(bundle.manifest.schemaVersion).toBe(SCHEMA_VERSION)
    expect(bundle.manifest.counts.projects).toBe(2)
    expect(bundle.manifest.tables).toContain('projects')
    expect(bundle.manifest.tables).toContain('segments')
    expect(bundle.data.projects).toHaveLength(2)
  })

  it('默认跳过凭据保险库与二进制内容', async () => {
    await db.credential_vault.put({
      id: 'c1',
      localId: 1,
      name: 'OpenAI',
      provider: 'openai',
      endpoint: 'https://api.openai.com/v1',
      revoked: false,
      current_version: 1,
      versions: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      revision: 1,
      deletedAt: null,
      deviceId: 'device-1',
      dirty: false,
    } as never)

    const bundle = await exportBackup(db)

    expect(bundle.manifest.credentialVault).toBe('skipped')
    expect(bundle.manifest.blobs).toBe('skipped')
    expect(bundle.manifest.tables).not.toContain('credential_vault')
    expect(bundle.manifest.tables).not.toContain('raw_blobs')
    expect(bundle.credentialVault).toBeUndefined()
  })

  it('显式导出凭据时必须提供口令', async () => {
    await expect(exportBackup(db, { includeSecrets: true })).rejects.toThrow(BackupError)
    await expect(exportBackup(db, { includeSecrets: true })).rejects.toMatchObject({
      code: 'missing_passphrase',
    })
  })

  it('凭据保险库被口令加密，明文不落包', async () => {
    await db.credential_vault.put({
      id: 'c1',
      localId: 1,
      name: 'OpenAI',
      provider: 'openai',
      endpoint: 'https://api.openai.com/v1',
      revoked: false,
      current_version: 1,
      versions: [{ version: 1, ciphertext: 'super-secret', nonce: 'n', key_id: 'k' }],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      revision: 1,
      deletedAt: null,
      deviceId: 'device-1',
      dirty: false,
    } as never)

    const bundle = await exportBackup(db, { includeSecrets: true, passphrase: 'correct horse' })

    expect(bundle.manifest.credentialVault).toBe('encrypted')
    expect(bundle.manifest.counts.credential_vault).toBe(1)
    expect(bundle.credentialVault).toBeDefined()
    expect(JSON.stringify(bundle)).not.toContain('super-secret')
  })
})

describe('本地备份 —— 恢复', () => {
  it('整库替换：目标库原有数据被清空并写入备份内容', async () => {
    await db.projects.put(projectRow('old', '旧项目') as never)
    const bundle = await exportBackup(db)

    // 备份之后新增的两条应当在恢复时被**清掉**。
    await db.projects.put(projectRow('p1', '新项目') as never)
    await db.projects.put(projectRow('p2', '另一个') as never)
    expect(await db.projects.count()).toBe(3)

    const result = await importBackup(db, bundle)

    expect(result.counts.projects).toBe(1)
    expect(await db.projects.count()).toBe(1)
    expect((await db.projects.toArray())[0]?.name).toBe('旧项目')
  })

  it('replace=false 时按主键合并', async () => {
    await db.projects.put(projectRow('p1', '备份里的项目') as never)
    const bundle = await exportBackup(db)

    await db.projects.put(projectRow('p1', '本地的项目') as never)
    await db.projects.put(projectRow('p2', '本地新增') as never)

    const result = await importBackup(db, bundle, { replace: false })

    expect(result.counts.projects).toBe(1)
    const rows = await db.projects.toArray()
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.id === 'p1')?.name).toBe('备份里的项目')
    expect(rows.find((row) => row.id === 'p2')?.name).toBe('本地新增')
  })

  it('恢复带数据的备份后内容一致', async () => {
    await db.projects.put(projectRow('p1', '项目一') as never)
    await db.glossary_entries.put({
      id: 'g1',
      localId: 1,
      project_id: 1,
      source_key: 'foo',
      source: 'Foo',
      target: '福',
      case_sensitive: false,
      forbidden: false,
      mandatory: false,
      notes: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      revision: 1,
      deletedAt: null,
      deviceId: 'device-1',
      dirty: false,
    } as never)
    const bundle = await exportBackup(db)

    await clearLocalData(db)
    expect(await db.projects.count()).toBe(0)

    const result = await importBackup(db, bundle)

    expect(result.counts.projects).toBe(1)
    expect(result.counts.glossary_entries).toBe(1)
    expect(await db.projects.count()).toBe(1)
    expect((await db.glossary_entries.toArray())[0]?.source).toBe('Foo')
  })

  it('Schema 版本高于当前应用时拒绝导入', async () => {
    const bundle = await exportBackup(db)
    const future: BackupBundle = {
      ...bundle,
      manifest: { ...bundle.manifest, schemaVersion: SCHEMA_VERSION + 1 },
    }
    await expect(importBackup(db, future)).rejects.toMatchObject({
      code: 'schema_version_mismatch',
    })
  })

  it('格式标识不符时拒绝导入', async () => {
    const bundle = await exportBackup(db)
    await expect(
      importBackup(db, { ...bundle, manifest: { ...bundle.manifest, format: 'other' as never } }),
    ).rejects.toMatchObject({ code: 'invalid_format' })
  })

  it('备份未含凭据时保留本地既有保险库', async () => {
    await db.credential_vault.put({
      id: 'keep',
      localId: 1,
      name: '本地凭据',
      provider: 'openai',
      endpoint: '',
      revoked: false,
      current_version: 1,
      versions: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      revision: 1,
      deletedAt: null,
      deviceId: 'device-1',
      dirty: false,
    } as never)
    const bundle = await exportBackup(db)

    const result = await importBackup(db, bundle)

    expect(result.credentialsRestored).toBe(false)
    expect(result.skipped.some((s) => s.table === 'credential_vault')).toBe(true)
    expect(await db.credential_vault.count()).toBe(1)
  })

  it('口令正确时可恢复凭据保险库，口令错误时报错', async () => {
    await db.credential_vault.put({
      id: 'c1',
      localId: 1,
      name: 'OpenAI',
      provider: 'openai',
      endpoint: 'https://api.openai.com/v1',
      revoked: false,
      current_version: 1,
      versions: [{ version: 1, ciphertext: 'super-secret', nonce: 'n', key_id: 'k' }],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      revision: 1,
      deletedAt: null,
      deviceId: 'device-1',
      dirty: false,
    } as never)
    const bundle = await exportBackup(db, { includeSecrets: true, passphrase: 'pw-123' })

    await clearLocalData(db)
    const ok = await importBackup(db, bundle, { passphrase: 'pw-123' })
    expect(ok.credentialsRestored).toBe(true)
    expect(await db.credential_vault.count()).toBe(1)

    await expect(importBackup(db, bundle, { passphrase: 'wrong' })).rejects.toMatchObject({
      code: 'invalid_passphrase',
    })
    await expect(importBackup(db, bundle)).rejects.toMatchObject({ code: 'missing_passphrase' })
  })
})

describe('本地备份 —— ZIP 往返', () => {
  it('导出 ZIP 再导入，内容一致', async () => {
    await db.projects.put(projectRow('p1', '项目一') as never)
    const zip = await exportBackupZip(db)

    await clearLocalData(db)
    expect(await db.projects.count()).toBe(0)

    const result = await importBackupZip(db, zip)
    expect(result.counts.projects).toBe(1)
    expect((await db.projects.toArray())[0]?.name).toBe('项目一')
  })

  it('ZIP 内含 manifest 与逐表 JSON', async () => {
    await db.projects.put(projectRow('p1', '项目一') as never)
    const zip = await exportBackupZip(db)
    const text = new TextDecoder().decode(zip)
    expect(text).toContain('manifest.json')
    expect(text).toContain('data/projects.json')
  })

  it('非法 ZIP 抛出 corrupt_payload', async () => {
    const broken = new Uint8Array([1, 2, 3, 4, 5])
    await expect(importBackupZip(db, broken)).rejects.toMatchObject({ code: 'corrupt_payload' })
  })
})
