/**
 * 项目 Repository 单元测试（fake-indexeddb）。
 *
 * 覆盖：CRUD、默认值、CAS revision、output_generation 递增、软删墓碑、
 * DTO 字段逐项对齐（snake_case / ISO 时间 / 数字 id / null storage_space_id）。
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeDatabase, openDatabase, type LinguaFlowDatabase } from '@/infrastructure/indexeddb/db'
import { getDeviceId, newRow } from '@/infrastructure/indexeddb/repo'
import type { BaseRow, ProjectRow } from '@/infrastructure/indexeddb/types'

import { RepositoryNotFoundError, RepositoryValidationError } from '../repositories/errors'
import {
  LOCAL_DEFAULT_STORAGE_SPACE_ID,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  toProjectDto,
  updateProject,
} from '../repositories/projects'

let db: LinguaFlowDatabase

beforeEach(async () => {
  await closeDatabase()
  db = await openDatabase(`lf-project-${Math.random().toString(36).slice(2)}`)
})

afterEach(async () => {
  await closeDatabase()
})

describe('projects Repository', () => {
  it('createProject 应用后端默认值并生成完整同步元字段', async () => {
    const row = await createProject(db, {
      name: '  Demo Project  ',
      glossary_enabled: true,
      config: { theme: 'dark' },
    })

    expect(row.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(row.localId).toBe(1)
    expect(row.name).toBe('Demo Project')
    expect(row.source_lang).toBe('auto')
    expect(row.target_lang).toBe('zh')
    expect(row.glossary_enabled).toBe(true)
    expect(row.config).toEqual({ theme: 'dark' })
    expect(row.storage_space_id).toBe(LOCAL_DEFAULT_STORAGE_SPACE_ID)
    expect(row.storage_space_id).toBe(1)
    expect(row.storage_generation).toBe(1)
    expect(row.output_generation).toBe(1)
    expect(row.storage_state).toBe('active')
    expect(row.owner_user_id).toBeNull()
    expect(row.revision).toBe(1)
    expect(row.deletedAt).toBeNull()
    expect(row.deviceId).toBe(await getDeviceId(db))
    expect(row.dirty).toBe(true)
    expect(new Date(row.createdAt).toISOString()).toBe(row.createdAt)
    expect(new Date(row.updatedAt).toISOString()).toBe(row.updatedAt)
  })

  it('createProject 拒绝空 name', async () => {
    await expect(createProject(db, { name: '   ' })).rejects.toBeInstanceOf(
      RepositoryValidationError,
    )
  })

  it('listProjects 按 localId 升序且过滤墓碑', async () => {
    const first = await createProject(db, { name: 'first' })
    const second = await createProject(db, { name: 'second' })
    const third = await createProject(db, { name: 'third' })

    await deleteProject(db, second.localId)

    const rows = await listProjects(db)
    expect(rows.map((row) => row.localId)).toEqual([first.localId, third.localId])
  })

  it('getProject 过滤墓碑，删除后返回 undefined', async () => {
    const row = await createProject(db, { name: 'to delete' })
    expect((await getProject(db, row.localId))?.name).toBe('to delete')

    await deleteProject(db, row.localId)

    expect(await getProject(db, row.localId)).toBeUndefined()
    expect(await listProjects(db)).toEqual([])
    // 墓碑仍在表中，等待云同步确认。
    const tombstone = await db.projects.where('localId').equals(row.localId).first()
    expect(tombstone?.deletedAt).not.toBeNull()
    expect(tombstone?.revision).toBe(row.revision + 1)
  })

  it('deleteProject 对不存在的项目抛 404 语义错误', async () => {
    await expect(deleteProject(db, 999)).rejects.toBeInstanceOf(RepositoryNotFoundError)
    await expect(updateProject(db, 999, { name: 'x' })).rejects.toBeInstanceOf(
      RepositoryNotFoundError,
    )
  })

  it('updateProject 递增 revision 与 output_generation，并保留未提供的字段', async () => {
    const created = await createProject(db, {
      name: 'before',
      source_lang: 'en',
      target_lang: 'ja',
      glossary_enabled: true,
      config: { keep: true },
    })

    const updated = await updateProject(db, created.localId, {
      name: '  after  ',
      config: { changed: 1 },
    })

    expect(updated.localId).toBe(created.localId)
    expect(updated.name).toBe('after')
    expect(updated.config).toEqual({ changed: 1 })
    expect(updated.source_lang).toBe('en')
    expect(updated.target_lang).toBe('ja')
    expect(updated.glossary_enabled).toBe(true)
    expect(updated.revision).toBe(created.revision + 1)
    expect(updated.output_generation).toBe(created.output_generation + 1)
    expect(updated.storage_generation).toBe(created.storage_generation)
    expect(updated.updatedAt >= created.updatedAt).toBe(true)
  })

  it('updateProject 对齐后端：空 name / 空 config / 缺省开关都回落到原值', async () => {
    const created = await createProject(db, {
      name: 'stable',
      glossary_enabled: true,
      config: { a: 1 },
      source_lang: 'en',
      target_lang: 'zh',
    })

    const updated = await updateProject(db, created.localId, {
      name: '   ',
      config: {},
      source_lang: '',
      target_lang: '',
    })

    expect(updated.name).toBe('stable')
    expect(updated.config).toEqual({ a: 1 })
    expect(updated.glossary_enabled).toBe(true)
    expect(updated.source_lang).toBe('en')
    expect(updated.target_lang).toBe('zh')
    expect(updated.output_generation).toBe(2)
  })

  it('toProjectDto 逐字段映射为后端 DTO（snake_case、ISO 时间、数字 id）', async () => {
    const row = await createProject(db, {
      name: 'DTO',
      source_lang: 'en',
      target_lang: 'de',
      glossary_enabled: false,
      config: { nested: { ok: true } },
    })

    const dto = toProjectDto(row)

    expect(dto).toEqual({
      id: row.localId,
      name: 'DTO',
      source_lang: 'en',
      target_lang: 'de',
      glossary_enabled: false,
      storage_space_id: 1,
      storage_generation: 1,
      output_generation: 1,
      storage_state: 'active',
      config: { nested: { ok: true } },
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    })
    expect(dto).not.toHaveProperty('owner_user_id')
    expect(dto).not.toHaveProperty('owner_org_id')
    expect(typeof dto.id).toBe('number')
  })

  it('toProjectDto 保留 storage_space_id=null 与 owner_user_id', async () => {
    const deviceId = await getDeviceId(db)
    const row = await newRow<Omit<ProjectRow, keyof BaseRow>>(db, {
      sequence: 'project',
      deviceId,
      fields: {
        name: 'legacy',
        source_lang: 'auto',
        target_lang: 'zh',
        glossary_enabled: false,
        config: {},
        storage_space_id: null,
        storage_generation: 1,
        output_generation: 1,
        storage_state: 'active',
        owner_user_id: 7,
      },
    })

    const dto = toProjectDto(row)
    expect(dto.storage_space_id).toBeNull()
    expect(dto.owner_user_id).toBe(7)
    expect(dto).not.toHaveProperty('config')
  })
})

