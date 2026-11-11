/**
 * 本地数据库（Dexie / IndexedDB）单元测试。
 *
 * 使用 `fake-indexeddb` 在 Vitest 的 node 环境下提供 IndexedDB 实现。
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  closeDatabase,
  getDatabase,
  openDatabase,
  SCHEMA_VERSION,
  type LinguaFlowDatabase,
} from '../db'
import { casWrite, ConflictError, getDeviceId, nextLocalId, newRow, softDelete } from '../repo'
import { seedBuiltins } from '../seed'
import { estimateStorage, isQuotaExceeded, QuotaExceededError } from '../quota'

let db: LinguaFlowDatabase

beforeEach(async () => {
  await closeDatabase()
  db = await openDatabase(`lf-test-${Math.random().toString(36).slice(2)}`)
})

afterEach(async () => {
  await closeDatabase()
})

describe('本地数据库 Schema', () => {
  it('覆盖 Phase 0 §5.1 设计的全部业务表与基础设施表', () => {
    const tables = db.tables.map((t) => t.name).sort()
    expect(tables).toEqual(
      [
        'activity_logs',
        'backend' in {} ? '' : 'backends',
        'blob' in {} ? '' : 'blobs',
        'bootstrap_prompt_templates',
        'credential_vault',
        'execution_plan_templates',
        'execution_profiles',
        'export_artifacts',
        'glossary_entries',
        'job_events',
        'job_resources',
        'job_round_segments',
        'job_rounds',
        'jobs',
        'kv_meta',
        'preferences',
        'prune_prompt_templates',
        'projects',
        'raw_blobs',
        'resources',
        'segment_revisions',
        'segments',
        'sequences',
        'source_revisions',
        'storage_tasks',
        'tm_entries',
        'translation_prompt_templates',
        'usage_records',
        'work_candidates',
        'work_items',
        'work_requests',
      ].sort(),
    )
  })

  it('schema 版本号为 1', () => {
    expect(SCHEMA_VERSION).toBe(1)
    expect(db.verno).toBe(1)
  })

  it('segments 表具备窗口分页所需的复合索引', () => {
    const indexNames = db.segments.schema.indexes.map((i) => i.name)
    expect(indexNames).toContain('[resource_id+segment_index]')
    expect(indexNames).toContain('status')
    expect(indexNames).toContain('group_key')
    expect(indexNames).toContain('content_version')
  })

  it('glossary_entries 具备 [project_id+source_key] 复合索引（条件唯一约束的查询基础）', () => {
    const indexNames = db.glossary_entries.schema.indexes.map((i) => i.name)
    expect(indexNames).toContain('[project_id+source_key]')
  })

  it('tm_entries 具备 [project_id+source_hash] 复合索引', () => {
    const indexNames = db.tm_entries.schema.indexes.map((i) => i.name)
    expect(indexNames).toContain('[project_id+source_hash]')
  })

  it('raw_blobs 与业务表物理隔离（只以 key 为主键）', () => {
    expect(db.raw_blobs.schema.primKey.keyPath).toBe('key')
    expect(db.raw_blobs.schema.indexes.map((i) => i.name)).toEqual([])
  })
})

describe('同步元字段与自增 localId', () => {
  it('设备标识持久化且稳定', async () => {
    const first = await getDeviceId(db)
    const second = await getDeviceId(db)
    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('localId 自增发号器在事务内单调递增', async () => {
    const a = await nextLocalId(db, 'project')
    const b = await nextLocalId(db, 'project')
    const c = await nextLocalId(db, 'resource')
    expect(a).toBe(1)
    expect(b).toBe(2)
    expect(c).toBe(1)
  })

  it('新行携带完整同步元字段', async () => {
    const deviceId = await getDeviceId(db)
    const row = await newRow(db, {
      sequence: 'project',
      deviceId,
      fields: {
        name: 'demo',
        source_lang: 'en',
        target_lang: 'zh',
        glossary_enabled: false,
        config: {},
        storage_space_id: null,
        storage_generation: 1,
        output_generation: 1,
        storage_state: 'active',
        owner_user_id: null,
      },
    })
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(row.localId).toBe(1)
    expect(row.revision).toBe(1)
    expect(row.deletedAt).toBeNull()
    expect(row.deviceId).toBe(deviceId)
    expect(row.dirty).toBe(true)
    expect(row.createdAt).toBe(row.updatedAt)
  })

  it('软删写墓碑而非物理删除', () => {
    const base = {
      id: 'x',
      localId: 1,
      createdAt: 'a',
      updatedAt: 'b',
      revision: 3,
      deletedAt: null,
      deviceId: 'd',
      dirty: false,
    }
    const deleted = softDelete(base, 'd2')
    expect(deleted.deletedAt).not.toBeNull()
    expect(deleted.revision).toBe(4)
    expect(deleted.dirty).toBe(true)
  })
})

describe('乐观锁（CAS）', () => {
  it('revision 匹配时写入成功', async () => {
    const deviceId = await getDeviceId(db)
    const row = await newRow(db, {
      sequence: 'project',
      deviceId,
      fields: {
        name: 'p',
        source_lang: 'en',
        target_lang: 'zh',
        glossary_enabled: false,
        config: {},
        storage_space_id: null,
        storage_generation: 1,
        output_generation: 1,
        storage_state: 'active',
        owner_user_id: null,
      },
    })
    await db.projects.put(row)
    await casWrite(
      () => db.projects.get(row.id),
      async (updated) => {
        await db.projects.put(updated)
      },
      { entity: 'project', expectedRevision: row.revision },
    )
    const after = await db.projects.get(row.id)
    expect(after?.revision).toBe(row.revision + 1)
  })

  it('revision 不匹配时抛 ConflictError', async () => {
    const deviceId = await getDeviceId(db)
    const row = await newRow(db, {
      sequence: 'project',
      deviceId,
      fields: {
        name: 'p',
        source_lang: 'en',
        target_lang: 'zh',
        glossary_enabled: false,
        config: {},
        storage_space_id: null,
        storage_generation: 1,
        output_generation: 1,
        storage_state: 'active',
        owner_user_id: null,
      },
    })
    await db.projects.put(row)
    await expect(
      casWrite(
        () => db.projects.get(row.id),
        async () => undefined,
        { entity: 'project', expectedRevision: row.revision + 5 },
      ),
    ).rejects.toBeInstanceOf(ConflictError)
  })
})

describe('内置模板种子初始化', () => {
  it('首次初始化写入 3 个内置提示词模板与 1 个内置执行策略', async () => {
    const result = await seedBuiltins(db)
    expect(result.inserted).toBe(4)
    expect(result.updated).toBe(0)
    expect(result.unchanged).toBe(0)

    expect(await db.translation_prompt_templates.count()).toBe(1)
    expect(await db.bootstrap_prompt_templates.count()).toBe(1)
    expect(await db.prune_prompt_templates.count()).toBe(1)
    expect(await db.execution_profiles.count()).toBe(1)

    const translation = await db.translation_prompt_templates.toCollection().first()
    expect(translation?.scope).toBe('system')
    expect(translation?.builtin_id).toBe(-1)
    expect(translation?.content).toContain('你是 LinguaFlow')
    expect(translation?.name).toBe('通用翻译提示词')
  })

  it('重复初始化是幂等的（不重复插入）', async () => {
    await seedBuiltins(db)
    const second = await seedBuiltins(db)
    expect(second.inserted).toBe(0)
    expect(second.updated).toBe(0)
    expect(second.unchanged).toBe(4)
    expect(await db.translation_prompt_templates.count()).toBe(1)
    expect(await db.execution_profiles.count()).toBe(1)
  })

  it('内置执行策略携带完整配置', async () => {
    await seedBuiltins(db)
    const profile = await db.execution_profiles.toCollection().first()
    expect(profile?.config).toMatchObject({
      schema_version: 1,
      protect: { enabled: true, rules: ['code', 'link', 'placeholder', 'xml'] },
      ruby: { enabled: true, preserve_kinds: ['creative'] },
    })
  })
})

describe('存储配额', () => {
  it('estimateStorage 在无 StorageManager 时返回缺省值而不抛错', async () => {
    const estimate = await estimateStorage()
    expect(estimate.usage).toBeGreaterThanOrEqual(0)
    expect(typeof estimate.persisted).toBe('boolean')
  })

  it('识别原生 QuotaExceededError 并归一为结构化错误', () => {
    expect(isQuotaExceeded(new QuotaExceededError('file', 10, 5))).toBe(true)
    expect(isQuotaExceeded({ name: 'QuotaExceededError' })).toBe(true)
    expect(isQuotaExceeded(new Error('other'))).toBe(false)
  })
})

describe('数据库句柄管理', () => {
  it('getDatabase 返回同一实例', () => {
    expect(getDatabase()).toBe(getDatabase())
  })
})
