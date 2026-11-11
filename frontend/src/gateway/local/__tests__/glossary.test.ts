/**
 * 术语表 Repository 单元测试（fake-indexeddb）。
 *
 * 覆盖：条件唯一约束（非禁译 source_key / 禁译 source_key+target）、
 * 并发创建只允许一个成功、更新 target_changed 与字段缺省语义、
 * 软删后可重建、CSV 导出逐字节格式。
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeDatabase, openDatabase, type LinguaFlowDatabase } from '@/infrastructure/indexeddb/db'

import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  RepositoryValidationError,
} from '../repositories/errors'
import { createProject } from '../repositories/projects'
import {
  createGlossaryEntry,
  deleteGlossaryEntry,
  exportGlossaryCsv,
  listGlossary,
  toGlossaryDto,
  updateGlossaryEntry,
} from '../repositories/glossary'

let db: LinguaFlowDatabase
let projectId: number

beforeEach(async () => {
  await closeDatabase()
  db = await openDatabase(`lf-glossary-${Math.random().toString(36).slice(2)}`)
  projectId = (await createProject(db, { name: 'glossary' })).localId
})

afterEach(async () => {
  await closeDatabase()
})

describe('glossary Repository — 创建与唯一约束', () => {
  it('createGlossaryEntry 归一化输入并应用 mandatory=true 默认值', async () => {
    const row = await createGlossaryEntry(db, projectId, {
      source: '  API Key  ',
      target: '  接口密钥  ',
      notes: '  keep it  ',
    })

    expect(row.source).toBe('API Key')
    expect(row.target).toBe('接口密钥')
    expect(row.source_key).toBe('api key')
    expect(row.case_sensitive).toBe(false)
    expect(row.forbidden).toBe(false)
    expect(row.mandatory).toBe(true)
    expect(row.notes).toBe('keep it')
    expect(row.localId).toBe(1)
    expect(row.revision).toBe(1)
  })

  it('非禁译条目按 [projectId+sourceKey] 唯一（大小写/空白归一）', async () => {
    await createGlossaryEntry(db, projectId, { source: 'Term', target: '术语' })

    await expect(
      createGlossaryEntry(db, projectId, { source: '  term  ', target: '另一个译法' }),
    ).rejects.toBeInstanceOf(RepositoryConflictError)
    expect(await listGlossary(db, projectId)).toHaveLength(1)
  })

  it('禁译条目按 [projectId+sourceKey+target] 唯一，不同 target 允许', async () => {
    await createGlossaryEntry(db, projectId, {
      source: 'API',
      target: '接口',
      forbidden: true,
    })

    await expect(
      createGlossaryEntry(db, projectId, { source: 'api', target: '接口', forbidden: true }),
    ).rejects.toBeInstanceOf(RepositoryConflictError)

    const allowed = await createGlossaryEntry(db, projectId, {
      source: 'API',
      target: 'API 接口',
      forbidden: true,
    })
    expect(allowed.target).toBe('API 接口')
    expect(await listGlossary(db, projectId)).toHaveLength(2)
  })

  it('同 source 的禁译与非禁译条目可以共存', async () => {
    await createGlossaryEntry(db, projectId, { source: 'API', target: '接口' })
    const forbidden = await createGlossaryEntry(db, projectId, {
      source: 'API',
      target: '接口',
      forbidden: true,
    })

    expect(forbidden.forbidden).toBe(true)
    expect(await listGlossary(db, projectId)).toHaveLength(2)
  })

  it('并发创建同一唯一键时只有一个成功（检查 + 写入在同一事务）', async () => {
    const results = await Promise.allSettled([
      createGlossaryEntry(db, projectId, { source: 'Race', target: 'a' }),
      createGlossaryEntry(db, projectId, { source: 'race', target: 'b' }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(
      RepositoryConflictError,
    )
  })

  it('空 source / target 抛 400 语义错误', async () => {
    await expect(
      createGlossaryEntry(db, projectId, { source: '   ', target: 'x' }),
    ).rejects.toBeInstanceOf(RepositoryValidationError)
    await expect(
      createGlossaryEntry(db, projectId, { source: 'x', target: '   ' }),
    ).rejects.toBeInstanceOf(RepositoryValidationError)
  })

  it('项目不存在时创建抛 404 语义错误', async () => {
    await expect(createGlossaryEntry(db, 999, { source: 'x', target: 'y' })).rejects.toBeInstanceOf(
      RepositoryNotFoundError,
    )
  })
})

describe('glossary Repository — 更新与删除', () => {
  it('target 变更时 target_changed=true，并递增 revision', async () => {
    const created = await createGlossaryEntry(db, projectId, { source: 'Term', target: '旧译' })

    const changed = await updateGlossaryEntry(db, projectId, created.localId, {
      source: 'Term',
      target: '新译',
    })
    expect(changed.targetChanged).toBe(true)
    expect(changed.row.target).toBe('新译')
    expect(changed.row.revision).toBe(created.revision + 1)

    const unchanged = await updateGlossaryEntry(db, projectId, created.localId, {
      source: 'Term',
      target: '新译',
    })
    expect(unchanged.targetChanged).toBe(false)
    expect(unchanged.row.revision).toBe(created.revision + 2)
  })

  it('更新时 forbidden / mandatory 缺省保留原值，case_sensitive / notes 缺省重置零值', async () => {
    const created = await createGlossaryEntry(db, projectId, {
      source: 'API',
      target: '接口',
      forbidden: true,
      mandatory: false,
      case_sensitive: true,
      notes: 'old note',
    })

    const updated = await updateGlossaryEntry(db, projectId, created.localId, {
      source: 'API',
      target: '接口2',
    })

    expect(updated.row.forbidden).toBe(true)
    expect(updated.row.mandatory).toBe(false)
    expect(updated.row.case_sensitive).toBe(false)
    expect(updated.row.notes).toBe('')

    const explicit = await updateGlossaryEntry(db, projectId, created.localId, {
      source: 'API',
      target: '接口2',
      forbidden: false,
      mandatory: true,
      case_sensitive: true,
      notes: '  new note  ',
    })
    expect(explicit.row.forbidden).toBe(false)
    expect(explicit.row.mandatory).toBe(true)
    expect(explicit.row.case_sensitive).toBe(true)
    expect(explicit.row.notes).toBe('new note')
  })

  it('更新源词撞上其他条目的唯一键时抛 409；撞自己允许', async () => {
    const first = await createGlossaryEntry(db, projectId, { source: 'Term', target: 'a' })
    const second = await createGlossaryEntry(db, projectId, { source: 'Other', target: 'b' })

    await expect(
      updateGlossaryEntry(db, projectId, second.localId, { source: ' term ', target: 'b' }),
    ).rejects.toBeInstanceOf(RepositoryConflictError)

    const selfRename = await updateGlossaryEntry(db, projectId, first.localId, {
      source: 'TERM',
      target: 'a',
    })
    expect(selfRename.row.source).toBe('TERM')
    expect(selfRename.row.source_key).toBe('term')
  })

  it('deleteGlossaryEntry 写墓碑，随后可用同一 source 重建', async () => {
    const created = await createGlossaryEntry(db, projectId, { source: 'Term', target: 'a' })

    await deleteGlossaryEntry(db, projectId, created.localId)

    expect(await listGlossary(db, projectId)).toEqual([])
    const tombstone = await db.glossary_entries.where('localId').equals(created.localId).first()
    expect(tombstone?.deletedAt).not.toBeNull()

    const recreated = await createGlossaryEntry(db, projectId, { source: 'Term', target: 'b' })
    expect(recreated.localId).not.toBe(created.localId)
    expect(await listGlossary(db, projectId)).toHaveLength(1)
  })

  it('更新 / 删除不存在的条目抛 404', async () => {
    await expect(
      updateGlossaryEntry(db, projectId, 999, { source: 'x', target: 'y' }),
    ).rejects.toBeInstanceOf(RepositoryNotFoundError)
    await expect(deleteGlossaryEntry(db, projectId, 999)).rejects.toBeInstanceOf(
      RepositoryNotFoundError,
    )
  })
})

describe('glossary Repository — DTO 与 CSV', () => {
  it('toGlossaryDto 字段对齐，空 notes 省略', async () => {
    const row = await createGlossaryEntry(db, projectId, {
      source: 'Term',
      target: '术语',
      case_sensitive: true,
      forbidden: true,
      mandatory: false,
    })

    expect(toGlossaryDto(row)).toEqual({
      id: row.localId,
      source: 'Term',
      target: '术语',
      case_sensitive: true,
      forbidden: true,
      mandatory: false,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    })
  })

  it('exportGlossaryCsv 生成与后端一致的 CSV（表头、source_key 排序、Go 引号规则）', async () => {
    await createGlossaryEntry(db, projectId, {
      source: 'B',
      target: 'line,with,comma',
      notes: 'say "hi"',
    })
    await createGlossaryEntry(db, projectId, { source: 'a', target: 'x' })

    const csv = await exportGlossaryCsv(db, projectId)

    expect(csv).toBe(
      'source,target,case_sensitive,forbidden,mandatory,notes\n' +
        'a,x,false,false,true,\n' +
        'B,"line,with,comma",false,false,true,"say ""hi"""\n',
    )
  })

  it('空术语表只输出表头行', async () => {
    expect(await exportGlossaryCsv(db, projectId)).toBe(
      'source,target,case_sensitive,forbidden,mandatory,notes\n',
    )
  })

  it('项目不存在时导出抛 404', async () => {
    await expect(exportGlossaryCsv(db, 999)).rejects.toBeInstanceOf(RepositoryNotFoundError)
  })
})
