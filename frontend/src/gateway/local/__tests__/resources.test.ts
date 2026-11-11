/**
 * 资源 Repository 单元测试（fake-indexeddb）。
 *
 * 覆盖：列表 / 单查 / 软删、多级目录树、空目录（无资源项目）、
 * 目录优先与名称排序、DTO 字段对齐。
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeDatabase, openDatabase, type LinguaFlowDatabase } from '@/infrastructure/indexeddb/db'
import { getDeviceId, newRow } from '@/infrastructure/indexeddb/repo'
import type { BaseRow, ResourceRow } from '@/infrastructure/indexeddb/types'

import { RepositoryNotFoundError } from '../repositories/errors'
import { createProject } from '../repositories/projects'
import {
  deleteResource,
  getResource,
  listResources,
  resourceDirectoryFromPath,
  resourceNameFromPath,
  resourceTree,
  toResourceDto,
} from '../repositories/resources'

let db: LinguaFlowDatabase

beforeEach(async () => {
  await closeDatabase()
  db = await openDatabase(`lf-resource-${Math.random().toString(36).slice(2)}`)
})

afterEach(async () => {
  await closeDatabase()
})

/** 直接造一条资源行（上传/解析由其他同事负责，这里只测元数据语义）。 */
async function insertResource(
  projectId: number,
  path: string,
  overrides: Partial<Omit<ResourceRow, keyof BaseRow>> = {},
): Promise<ResourceRow> {
  const deviceId = await getDeviceId(db)
  const row = await newRow<Omit<ResourceRow, keyof BaseRow>>(db, {
    sequence: 'resource',
    deviceId,
    fields: {
      project_id: projectId,
      path,
      name: path.split('/').pop() ?? path,
      directory: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
      format: 'txt',
      total_segments: 3,
      translated_segments: 1,
      approved_segments: 0,
      current_source_revision_id: null,
      source_generation: 1,
      translation_generation: 1,
      opfs_path: null,
      ...overrides,
    },
  })
  await db.resources.put(row)
  return row
}

describe('resources Repository', () => {
  it('listResources 按 localId 升序、过滤墓碑并按项目隔离', async () => {
    const project = await createProject(db, { name: 'p1' })
    const other = await createProject(db, { name: 'p2' })

    const first = await insertResource(project.localId, 'b.txt')
    const second = await insertResource(project.localId, 'a.txt')
    await insertResource(other.localId, 'other.txt')

    expect((await listResources(db, project.localId)).map((row) => row.localId)).toEqual([
      first.localId,
      second.localId,
    ])

    await deleteResource(db, project.localId, first.localId)
    expect((await listResources(db, project.localId)).map((row) => row.localId)).toEqual([
      second.localId,
    ])
  })

  it('getResource 只返回同项目且未删除的资源', async () => {
    const project = await createProject(db, { name: 'p1' })
    const other = await createProject(db, { name: 'p2' })
    const row = await insertResource(project.localId, 'a.txt')

    expect((await getResource(db, project.localId, row.localId))?.id).toBe(row.id)
    expect(await getResource(db, other.localId, row.localId)).toBeUndefined()
    expect(await getResource(db, project.localId, 999)).toBeUndefined()

    await deleteResource(db, project.localId, row.localId)
    expect(await getResource(db, project.localId, row.localId)).toBeUndefined()
  })

  it('deleteResource 写墓碑并递增 revision', async () => {
    const project = await createProject(db, { name: 'p' })
    const row = await insertResource(project.localId, 'a.txt')

    await deleteResource(db, project.localId, row.localId)

    const tombstone = await db.resources.where('localId').equals(row.localId).first()
    expect(tombstone?.deletedAt).not.toBeNull()
    expect(tombstone?.revision).toBe(row.revision + 1)
  })

  it('deleteResource 对不存在 / 跨项目资源抛 404 语义错误', async () => {
    const project = await createProject(db, { name: 'p' })
    const other = await createProject(db, { name: 'other' })
    const row = await insertResource(project.localId, 'a.txt')

    await expect(deleteResource(db, project.localId, 999)).rejects.toBeInstanceOf(
      RepositoryNotFoundError,
    )
    await expect(deleteResource(db, other.localId, row.localId)).rejects.toBeInstanceOf(
      RepositoryNotFoundError,
    )
  })

  it('resourceTree 按 path 构建多级目录树并保持目录优先 + 名称升序', async () => {
    const project = await createProject(db, { name: 'tree' })
    const rootResource = await insertResource(project.localId, 'a.txt')
    await insertResource(project.localId, 'dir/b.txt')
    await insertResource(project.localId, 'dir/sub/c.txt')
    await insertResource(project.localId, 'dir2/d.txt')
    await insertResource(project.localId, 'dir2/Z.txt')

    const root = await resourceTree(db, project.localId)

    expect(root).toMatchObject({ type: 'directory', name: '', path: '' })
    const rootChildren = root.children ?? []
    // 目录优先，然后才是根目录下的资源。
    expect(rootChildren.map((node) => [node.type, node.name, node.path])).toEqual([
      ['directory', 'dir', 'dir'],
      ['directory', 'dir2', 'dir2'],
      ['resource', 'a.txt', 'a.txt'],
    ])

    const dir = rootChildren[0]!
    expect(dir.children?.map((node) => [node.type, node.name])).toEqual([
      ['directory', 'sub'],
      ['resource', 'b.txt'],
    ])
    expect(dir.children?.[0]?.children?.map((node) => [node.type, node.name])).toEqual([
      ['resource', 'c.txt'],
    ])

    // 同层资源按 UTF-8 字节序：'Z'(0x5A) < 'd'(0x64)。
    expect(rootChildren[1]?.children?.map((node) => node.name)).toEqual(['Z.txt', 'd.txt'])

    const leaf = rootChildren[2]!
    expect(leaf.type).toBe('resource')
    expect(leaf.resource).toMatchObject({
      id: rootResource.localId,
      path: 'a.txt',
      name: 'a.txt',
      directory: '',
    })
  })

  it('resourceTree 对无资源项目返回空根目录（children 省略，对齐 omitempty）', async () => {
    const project = await createProject(db, { name: 'empty' })

    const root = await resourceTree(db, project.localId)

    expect(root).toEqual({ type: 'directory', name: '', path: '' })
    expect(root.children).toBeUndefined()
  })

  it('resourceTree 对不存在的项目抛 404 语义错误', async () => {
    await expect(resourceTree(db, 404)).rejects.toBeInstanceOf(RepositoryNotFoundError)
  })

  it('toResourceDto 逐字段映射，name / directory 由 path 派生', async () => {
    const project = await createProject(db, { name: 'dto' })
    const row = await insertResource(project.localId, '  folder/sub/file.docx  ', {
      name: 'stale-name',
      directory: 'stale-directory',
      format: 'docx',
      total_segments: 10,
      translated_segments: 4,
      approved_segments: 2,
      current_source_revision_id: 9,
      source_generation: 3,
      translation_generation: 5,
    })

    const dto = toResourceDto(row)

    expect(dto).toEqual({
      id: row.localId,
      current_source_revision_id: 9,
      source_generation: 3,
      translation_generation: 5,
      path: 'folder/sub/file.docx',
      name: 'file.docx',
      directory: 'folder/sub',
      format: 'docx',
      total_segments: 10,
      translated_segments: 4,
      approved_segments: 2,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    })
  })

  it('path 派生函数对齐 Go filepath.Base / Dir 的兜底', () => {
    expect(resourceNameFromPath('')).toBe('resource')
    expect(resourceNameFromPath('a.txt')).toBe('a.txt')
    expect(resourceNameFromPath('dir/a.txt')).toBe('a.txt')
    expect(resourceDirectoryFromPath('a.txt')).toBe('')
    expect(resourceDirectoryFromPath('dir/a.txt')).toBe('dir')
    expect(resourceDirectoryFromPath('a/b/c.txt')).toBe('a/b')
  })
})
