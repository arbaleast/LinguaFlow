/**
 * 本地「项目存储」快照端点的测试（fake-indexeddb）。
 *
 * 浏览器本地模式只有一个逻辑存储空间，快照必须恒为「就绪 / 可写 / 无维护」，
 * 否则 `stores/projectWorkspace.ts` 的 `prepareStorageWrite` 会一直返回 409，
 * 本地模式下的上传与删除就完全不可用。
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDatabase, openDatabase, type LinguaFlowDatabase } from '@/infrastructure/indexeddb/db'

import { createProject } from '../repositories/projects'
import { projectRoutes } from '../routes/projects'
import { storageRoutes } from '../routes/storage'
import { context, invoke } from './helpers'

let db: LinguaFlowDatabase

beforeEach(async () => {
  await closeDatabase()
  db = await openDatabase(`lf-storage-${Math.random().toString(36).slice(2)}`)
})

afterEach(async () => {
  await closeDatabase()
})

describe('local routes — 项目存储快照', () => {
  it('返回始终就绪、可写、无维护的本地快照', async () => {
    const row = await createProject(db, { name: '本地空间' })
    const res = await invoke(
      storageRoutes,
      'GET',
      '/projects/{projectId}/storage',
      context({ projectId: String(row.localId) }, undefined, {}, db),
    )
    expect(res.response.status).toBe(200)
    expect(res.data).toMatchObject({
      project_id: row.localId,
      storage_generation: row.storage_generation,
      storage_state: 'active',
      migration_task_id: null,
      reason_codes: [],
    })

    const snapshot = res.data as {
      runtime: {
        deployment_enabled: boolean
        maintenance: boolean
        retirement: {
          contract_version: number
          unused_removal: { allowed: boolean; reason_codes: string[] }
          in_use_retirement: { allowed: boolean; reason_codes: string[] }
        }
      }
      binding: { space_id: number; scope: string; status: string; historical: boolean }
    }
    // 本地写入必须被允许：`prepareStorageWrite` 依赖 `deployment_enabled`。
    expect(snapshot.runtime.deployment_enabled).toBe(true)
    expect(snapshot.runtime.maintenance).toBe(false)
    expect(snapshot.runtime.retirement.contract_version).toBe(1)
    expect(snapshot.runtime.retirement.unused_removal.allowed).toBe(false)
    expect(snapshot.runtime.retirement.unused_removal.reason_codes).toEqual([
      'storage_capability_unsupported',
    ])
    expect(snapshot.runtime.retirement.in_use_retirement.allowed).toBe(false)
    expect(snapshot.runtime.retirement.in_use_retirement.reason_codes).toEqual([
      'storage_capability_unsupported',
    ])
    expect(snapshot.binding.scope).toBe('user')
    expect(snapshot.binding.status).toBe('active')
    expect(snapshot.binding.historical).toBe(false)
    expect(snapshot.binding.space_id).toBeGreaterThan(0)
  })

  it('项目不存在 → 404', async () => {
    const res = await invoke(
      storageRoutes,
      'GET',
      '/projects/{projectId}/storage',
      context({ projectId: '4242' }, undefined, {}, db),
    )
    expect(res.response.status).toBe(404)
  })

  it('路径参数非法 → 400', async () => {
    const res = await invoke(
      storageRoutes,
      'GET',
      '/projects/{projectId}/storage',
      context({ projectId: 'abc' }, undefined, {}, db),
    )
    expect(res.response.status).toBe(400)
  })

  it('项目路由仍可正常创建（回归）', async () => {
    const res = await invoke(projectRoutes, 'POST', '/projects', context({}, { name: 'X' }, {}, db))
    expect(res.response.status).toBe(201)
  })
})
