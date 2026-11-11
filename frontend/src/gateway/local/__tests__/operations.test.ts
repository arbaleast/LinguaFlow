/**
 * 本地「操作」投影与用户直通端点的测试。
 *
 * 覆盖：`GET /operations`、`GET /operations/summary`、
 * `POST /operations/batch-delete`、`GET /users/me`，
 * 以及术语 CSV 导入端点。
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDatabase, openDatabase, type LinguaFlowDatabase } from '@/infrastructure/indexeddb/db'

import { operationRoutes } from '../routes/operations'
import { glossaryImportRoutes } from '../routes/glossary'
import { userRoutes } from '../routes/users'
import { context, invoke } from './helpers'

let db: LinguaFlowDatabase

/** 造一个项目行。 */
function projectRow(id: string, name: string, localId: number) {
  return {
    id,
    localId,
    name,
    source_lang: 'en',
    target_lang: 'zh',
    glossary_enabled: true,
    config: {},
    storage_space_id: null,
    storage_generation: 1,
    output_generation: 1,
    storage_state: 'active',
    owner_user_id: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    revision: 1,
    deletedAt: null,
    deviceId: 'device-1',
    dirty: false,
  }
}

/** 造一个任务行。 */
function jobRow(id: string, localId: number, projectId: number, status: string, updatedAt: string) {
  return {
    id,
    localId,
    project_id: projectId,
    status,
    trigger_type: 'manual',
    retry_epoch: 0,
    pause_requested: false,
    execution_plan_id: null,
    execution_config: null,
    progress_total: 10,
    progress_completed: status === 'completed' ? 10 : 2,
    resource_count: 1,
    resource_completed: 0,
    resource_failed: 0,
    error_message: null,
    retention_anchor_at: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
    revision: 1,
    deletedAt: null,
    deviceId: 'device-1',
    dirty: false,
  }
}

beforeEach(async () => {
  await closeDatabase()
  db = await openDatabase(`ops-test-${Math.random().toString(36).slice(2)}`)
})

afterEach(async () => {
  await closeDatabase()
})

describe('本地操作投影', () => {
  it('GET /operations 默认只返回活动任务', async () => {
    await db.projects.put(projectRow('p1', '项目一', 1) as never)
    await db.jobs.put(jobRow('j1', 1, 1, 'running', '2026-01-02T00:00:00.000Z') as never)
    await db.jobs.put(jobRow('j2', 2, 1, 'completed', '2026-01-03T00:00:00.000Z') as never)

    const res = await invoke(operationRoutes, 'GET', '/operations', context({}, null, {}, db))

    expect(res.response.status).toBe(200)
    const items = (res.data as { items: Array<{ task_type: string; task_id: string }> }).items
    expect(items).toHaveLength(1)
    expect(items[0]?.task_type).toBe('translation')
    expect(items[0]?.task_id).toBe('1')
  })

  it('GET /operations?state=all 包含终态任务，并按 updated_at 降序', async () => {
    await db.projects.put(projectRow('p1', '项目一', 1) as never)
    await db.jobs.put(jobRow('j1', 1, 1, 'running', '2026-01-02T00:00:00.000Z') as never)
    await db.jobs.put(jobRow('j2', 2, 1, 'completed', '2026-01-05T00:00:00.000Z') as never)

    const res = await invoke(
      operationRoutes,
      'GET',
      '/operations',
      context({}, null, { state: 'all' }, db),
    )

    const items = (res.data as { items: Array<{ task_id: string }> }).items
    expect(items.map((i) => i.task_id)).toEqual(['2', '1'])
  })

  it('GET /operations?project_id= 过滤项目', async () => {
    await db.projects.put(projectRow('p1', '项目一', 1) as never)
    await db.projects.put(projectRow('p2', '项目二', 2) as never)
    await db.jobs.put(jobRow('j1', 1, 1, 'running', '2026-01-02T00:00:00.000Z') as never)
    await db.jobs.put(jobRow('j2', 2, 2, 'running', '2026-01-02T00:00:00.000Z') as never)

    const res = await invoke(
      operationRoutes,
      'GET',
      '/operations',
      context({}, null, { project_id: '2' }, db),
    )

    const items = (res.data as { items: Array<{ project_id: number }> }).items
    expect(items).toHaveLength(1)
    expect(items[0]?.project_id).toBe(2)
  })

  it('GET /operations/summary 固定返回四类计数', async () => {
    await db.projects.put(projectRow('p1', '项目一', 1) as never)
    await db.jobs.put(jobRow('j1', 1, 1, 'running', '2026-01-02T00:00:00.000Z') as never)
    await db.jobs.put(jobRow('j2', 2, 1, 'pending', '2026-01-02T00:00:00.000Z') as never)

    const res = await invoke(operationRoutes, 'GET', '/operations/summary', context({}, null, {}, db))

    expect(res.response.status).toBe(200)
    const data = res.data as {
      total: { running: number; pending: number }
      by_type: Record<string, { running: number; pending: number }>
      recent_failed_since: string
      as_of: string
    }
    expect(data.total.running).toBe(1)
    expect(data.total.pending).toBe(1)
    expect(Object.keys(data.by_type).sort()).toEqual([
      'glossary_sync',
      'storage',
      'storage_retirement',
      'translation',
    ])
    expect(data.by_type.translation?.running).toBe(1)
    expect(data.by_type.storage?.running).toBe(0)
    expect(typeof data.recent_failed_since).toBe('string')
  })

  it('POST /operations/batch-delete 删除终态任务，非终态返回 not_terminal', async () => {
    await db.projects.put(projectRow('p1', '项目一', 1) as never)
    await db.jobs.put(jobRow('j1', 1, 1, 'completed', '2026-01-02T00:00:00.000Z') as never)
    await db.jobs.put(jobRow('j2', 2, 1, 'running', '2026-01-02T00:00:00.000Z') as never)

    const res = await invoke(
      operationRoutes,
      'POST',
      '/operations/batch-delete',
      context(
        {},
        {
          items: [
            { kind: 'translation', id: '1', project_id: 1 },
            { kind: 'translation', id: '2', project_id: 1 },
            { kind: 'translation', id: '999', project_id: 1 },
          ],
        },
        {},
        db,
      ),
    )

    expect(res.response.status).toBe(200)
    const items = (res.data as { items: Array<{ status: string }> }).items
    expect(items.map((i) => i.status)).toEqual(['deleted', 'not_terminal', 'not_found'])
    expect(await db.jobs.count()).toBe(1)
  })

  it('POST /operations/batch-delete 项目不匹配返回 forbidden', async () => {
    await db.projects.put(projectRow('p1', '项目一', 1) as never)
    await db.jobs.put(jobRow('j1', 1, 1, 'completed', '2026-01-02T00:00:00.000Z') as never)

    const res = await invoke(
      operationRoutes,
      'POST',
      '/operations/batch-delete',
      context({}, { items: [{ kind: 'translation', id: '1', project_id: 2 }] }, {}, db),
    )

    const items = (res.data as { items: Array<{ status: string }> }).items
    expect(items[0]?.status).toBe('forbidden')
  })

  it('POST /operations/batch-delete 结构非法 → 400', async () => {
    const res = await invoke(
      operationRoutes,
      'POST',
      '/operations/batch-delete',
      context({}, { items: [] }, {}, db),
    )

    expect(res.response.status).toBe(400)
  })

  it('GET /users/me 返回本地默认用户', async () => {
    const res = await invoke(userRoutes, 'GET', '/users/me', context({}, null, {}, db))

    expect(res.response.status).toBe(200)
    expect(res.data).toMatchObject({ role: 'admin', active: true })
  })
})

describe('术语 CSV 导入', () => {
  it('导入 CSV 并统计新增与跳过', async () => {
    await db.projects.put(projectRow('p1', '项目一', 1) as never)

    const res = await invoke(glossaryImportRoutes, 'POST', '/projects/{projectId}/glossary/import', {
      db,
      blobs: undefined as never,
      vault: undefined as never,
      path: { projectId: '1' },
      query: {},
      body: { content: 'source,target\nFoo,福\nBar,吧\n' },
    })

    expect(res.response.status).toBe(200)
    expect(res.data).toMatchObject({ added: 2 })
    expect(await db.glossary_entries.count()).toBe(2)
  })

  it('重复导入时冲突条目被跳过', async () => {
    await db.projects.put(projectRow('p1', '项目一', 1) as never)

    const ctx = context(
      { projectId: '1' },
      { content: 'source,target\nFoo,福\n' },
      {},
      db,
    )
    await invoke(glossaryImportRoutes, 'POST', '/projects/{projectId}/glossary/import', ctx)
    const again = await invoke(
      glossaryImportRoutes,
      'POST',
      '/projects/{projectId}/glossary/import',
      ctx,
    )

    expect(again.data).toMatchObject({ added: 0 })
    expect(await db.glossary_entries.count()).toBe(1)
  })

  it('请求体缺少内容 → 400', async () => {
    await db.projects.put(projectRow('p1', '项目一', 1) as never)
    const res = await invoke(
      glossaryImportRoutes,
      'POST',
      '/projects/{projectId}/glossary/import',
      context({ projectId: '1' }, null, {}, db),
    )
    expect(res.response.status).toBe(400)
  })
})
