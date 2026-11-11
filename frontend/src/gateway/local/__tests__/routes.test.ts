/**
 * 本地路由层测试：验证 `LocalRoute[]` 的注册路径、状态码、响应外壳与
 * Repository 错误 → Problem 的映射（400 / 404 / 409）。
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeDatabase, openDatabase, type LinguaFlowDatabase } from '@/infrastructure/indexeddb/db'
import { getDeviceId, newRow } from '@/infrastructure/indexeddb/repo'
import type { BaseRow, ResourceRow } from '@/infrastructure/indexeddb/types'

import type { GatewayResult } from '@/gateway/contracts'
import { glossaryRoutes } from '../routes/glossary'
import { projectRoutes } from '../routes/projects'
import { resourceRoutes } from '../routes/resources'
import { localRoutes } from '../routes'
import type { LocalRequestContext, LocalRoute } from '../router'

let db: LinguaFlowDatabase

beforeEach(async () => {
  await closeDatabase()
  db = await openDatabase(`lf-routes-${Math.random().toString(36).slice(2)}`)
})

afterEach(async () => {
  await closeDatabase()
})

function context(
  path: Record<string, string> = {},
  body: unknown = undefined,
): LocalRequestContext {
  return {
    db,
    blobs: {} as LocalRequestContext['blobs'],
    vault: {} as LocalRequestContext['vault'],
    path,
    query: {},
    body,
  }
}

async function invoke(
  routes: readonly LocalRoute[],
  method: LocalRoute['method'],
  path: string,
  requestContext: LocalRequestContext,
): Promise<GatewayResult<unknown>> {
  const matched = routes.find((route) => route.method === method && route.path === path)
  if (!matched) throw new Error(`未注册路由：${method} ${path}`)
  return matched.handler(requestContext)
}

describe('local routes — 路由表', () => {
  it('聚合表覆盖全部已实现端点', () => {
    expect(localRoutes.map((route) => `${route.method} ${route.path}`).sort()).toEqual(
      [
        'DELETE /backends/{backendId}',
        'DELETE /bootstrap-prompt-templates/{bootstrapPromptTemplateId}',
        'DELETE /execution-plan-templates/{executionPlanTemplateId}',
        'DELETE /execution-profiles/{executionProfileId}',
        'DELETE /jobs/{jobId}',
        'DELETE /projects/{projectId}',
        'DELETE /projects/{projectId}/glossary/{entryId}',
        'DELETE /projects/{projectId}/resources/{resourceId}',
        'DELETE /prune-prompt-templates/{prunePromptTemplateId}',
        'DELETE /translation-prompt-templates/{translationPromptTemplateId}',
        'GET /activity',
        'GET /backends',
        'GET /backends/{backendId}',
        'GET /bootstrap-prompt-templates',
        'GET /bootstrap-prompt-templates/{bootstrapPromptTemplateId}',
        'GET /credentials',
        'GET /credentials/{credentialId}/versions',
        'GET /execution-plan-templates',
        'GET /execution-plan-templates/{executionPlanTemplateId}',
        'GET /execution-profiles',
        'GET /execution-profiles/{executionProfileId}',
        'GET /jobs/{jobId}',
        'GET /jobs/{jobId}/events',
        'GET /operations',
        'GET /operations/summary',
        'GET /projects',
        'GET /projects/{projectId}',
        'GET /projects/{projectId}/glossary',
        'GET /projects/{projectId}/glossary/export',
        'GET /projects/{projectId}/jobs',
        'GET /projects/{projectId}/resources',
        'GET /projects/{projectId}/resources/tree',
        'GET /projects/{projectId}/resources/{resourceId}',
        'GET /projects/{projectId}/resources/{resourceId}/download',
        'GET /projects/{projectId}/resources/{resourceId}/download-translated',
        'GET /projects/{projectId}/resources/{resourceId}/segments',
        'GET /projects/{projectId}/resources/{resourceId}/segments/groups',
        'GET /projects/{projectId}/storage',
        'GET /prune-prompt-templates',
        'GET /prune-prompt-templates/{prunePromptTemplateId}',
        'GET /stats/summary',
        'GET /translation-prompt-templates',
        'GET /translation-prompt-templates/{translationPromptTemplateId}',
        'GET /users/me',
        'GET /users/me/login-methods',
        'PATCH /projects/{projectId}/resources/{resourceId}/segments/{segmentId}',
        'POST /backends',
        'POST /bootstrap-prompt-templates',
        'POST /credentials',
        'POST /credentials/{credentialId}/collect',
        'POST /credentials/{credentialId}/versions',
        'POST /credentials/{credentialId}/versions/{version}/revoke',
        'POST /execution-plan-templates',
        'POST /execution-profiles',
        'POST /jobs/{jobId}/cancel',
        'POST /jobs/{jobId}/pause',
        'POST /jobs/{jobId}/resume',
        'POST /jobs/{jobId}/retry',
        'POST /operations/batch-delete',
        'POST /projects',
        'POST /projects/{projectId}/glossary',
        'POST /projects/{projectId}/glossary/import',
        'POST /projects/{projectId}/qa-recheck',
        'POST /projects/{projectId}/resources/{resourceId}/segments/approve-all',
        'POST /projects/{projectId}/resources/{resourceId}/segments/batch-review',
        'POST /projects/{projectId}/resources/{resourceId}/segments/search-replace/apply',
        'POST /projects/{projectId}/resources/{resourceId}/segments/search-replace/preview',
        'POST /projects/{projectId}/resources/{resourceId}/segments/search-replace/{operationId}/undo',
        'POST /projects/{projectId}/resources/{resourceId}/segments/{segmentId}/issues/disposition',
        'POST /prune-prompt-templates',
        'POST /translation-prompt-templates',
        'PUT /backends/{backendId}',
        'PUT /bootstrap-prompt-templates/{bootstrapPromptTemplateId}',
        'PUT /execution-plan-templates/{executionPlanTemplateId}',
        'PUT /execution-profiles/{executionProfileId}',
        'PUT /projects/{projectId}',
        'PUT /projects/{projectId}/glossary/{entryId}',
        'PUT /prune-prompt-templates/{prunePromptTemplateId}',
        'PUT /translation-prompt-templates/{translationPromptTemplateId}',
        'PUT /users/me',
        'PUT /users/me/password',
      ].sort(),
    )
  })
})

describe('local routes — 项目', () => {
  it('POST/GET/PUT/DELETE 全流程与状态码', async () => {
    const created = await invoke(projectRoutes, 'POST', '/projects', context({}, { name: 'Route' }))
    expect(created.response.status).toBe(201)
    const project = created.data as { id: number; name: string; output_generation: number }
    expect(project.name).toBe('Route')
    expect(project.output_generation).toBe(1)

    const listed = await invoke(projectRoutes, 'GET', '/projects', context())
    expect(listed.response.status).toBe(200)
    expect((listed.data as { items: unknown[] }).items).toHaveLength(1)

    const fetched = await invoke(
      projectRoutes,
      'GET',
      '/projects/{projectId}',
      context({ projectId: String(project.id) }),
    )
    expect((fetched.data as { name: string }).name).toBe('Route')

    const updated = await invoke(
      projectRoutes,
      'PUT',
      '/projects/{projectId}',
      context({ projectId: String(project.id) }, { name: 'Renamed' }),
    )
    expect(updated.response.status).toBe(200)
    expect(updated.data).toMatchObject({ name: 'Renamed', output_generation: 2 })

    const removed = await invoke(
      projectRoutes,
      'DELETE',
      '/projects/{projectId}',
      context({ projectId: String(project.id) }),
    )
    expect(removed.response.status).toBe(204)

    const missing = await invoke(
      projectRoutes,
      'GET',
      '/projects/{projectId}',
      context({ projectId: String(project.id) }),
    )
    expect(missing.response.status).toBe(404)
    expect(missing.error).toMatchObject({ status: 404 })
    expect(missing.data).toBeUndefined()
  })

  it('非法路径参数 → 400 Problem', async () => {
    const invalid = await invoke(
      projectRoutes,
      'GET',
      '/projects/{projectId}',
      context({ projectId: 'abc' }),
    )
    expect(invalid.response.status).toBe(400)
    expect(invalid.error).toMatchObject({ status: 400, error_code: 'invalid_request' })
  })

  it('空 name → 400 Problem', async () => {
    const invalid = await invoke(projectRoutes, 'POST', '/projects', context({}, { name: '  ' }))
    expect(invalid.response.status).toBe(400)
  })
})

describe('local routes — 资源', () => {
  async function seedResource(projectId: number, path: string): Promise<ResourceRow> {
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
        total_segments: 1,
        translated_segments: 0,
        approved_segments: 0,
        current_source_revision_id: null,
        source_generation: 1,
        translation_generation: 1,
        opfs_path: null,
      },
    })
    await db.resources.put(row)
    return row
  }

  it('资源列表 / 树 / 单查 / 删除', async () => {
    const project = await invoke(projectRoutes, 'POST', '/projects', context({}, { name: 'R' }))
    const projectId = (project.data as { id: number }).id
    const resource = await seedResource(projectId, 'dir/file.txt')

    const listed = await invoke(
      resourceRoutes,
      'GET',
      '/projects/{projectId}/resources',
      context({ projectId: String(projectId) }),
    )
    expect(listed.response.status).toBe(200)
    expect((listed.data as { items: { path: string }[] }).items[0]?.path).toBe('dir/file.txt')

    const tree = await invoke(
      resourceRoutes,
      'GET',
      '/projects/{projectId}/resources/tree',
      context({ projectId: String(projectId) }),
    )
    const root = (tree.data as { root: { type: string; children?: unknown[] } }).root
    expect(root.type).toBe('directory')
    expect(root.children).toHaveLength(1)

    const fetched = await invoke(
      resourceRoutes,
      'GET',
      '/projects/{projectId}/resources/{resourceId}',
      context({ projectId: String(projectId), resourceId: String(resource.localId) }),
    )
    expect((fetched.data as { id: number }).id).toBe(resource.localId)

    const removed = await invoke(
      resourceRoutes,
      'DELETE',
      '/projects/{projectId}/resources/{resourceId}',
      context({ projectId: String(projectId), resourceId: String(resource.localId) }),
    )
    expect(removed.response.status).toBe(204)
  })

  it('资源不存在 → 404', async () => {
    const project = await invoke(projectRoutes, 'POST', '/projects', context({}, { name: 'R' }))
    const projectId = (project.data as { id: number }).id
    const missing = await invoke(
      resourceRoutes,
      'GET',
      '/projects/{projectId}/resources/{resourceId}',
      context({ projectId: String(projectId), resourceId: '999' }),
    )
    expect(missing.response.status).toBe(404)
  })
})

describe('local routes — 术语表', () => {
  it('CRUD + 条件唯一 409 + CSV 导出（Blob + text/csv）', async () => {
    const project = await invoke(projectRoutes, 'POST', '/projects', context({}, { name: 'G' }))
    const projectId = (project.data as { id: number }).id

    const created = await invoke(
      glossaryRoutes,
      'POST',
      '/projects/{projectId}/glossary',
      context({ projectId: String(projectId) }, { source: 'API', target: '接口' }),
    )
    expect(created.response.status).toBe(201)
    const entry = created.data as { id: number; mandatory: boolean }
    expect(entry.mandatory).toBe(true)

    const duplicate = await invoke(
      glossaryRoutes,
      'POST',
      '/projects/{projectId}/glossary',
      context({ projectId: String(projectId) }, { source: 'api', target: '另一个' }),
    )
    expect(duplicate.response.status).toBe(409)
    expect(duplicate.error).toMatchObject({ status: 409, error_code: 'conflict' })

    const updated = await invoke(
      glossaryRoutes,
      'PUT',
      '/projects/{projectId}/glossary/{entryId}',
      context(
        { projectId: String(projectId), entryId: String(entry.id) },
        {
          source: 'API',
          target: '接口2',
        },
      ),
    )
    expect(updated.response.status).toBe(200)
    expect(updated.data).toMatchObject({ target: '接口2', target_changed: true })

    const exported = await invoke(
      glossaryRoutes,
      'GET',
      '/projects/{projectId}/glossary/export',
      context({ projectId: String(projectId) }),
    )
    expect(exported.response.status).toBe(200)
    expect(exported.response.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(exported.data).toBeInstanceOf(Blob)
    await expect((exported.data as Blob).text()).resolves.toBe(
      'source,target,case_sensitive,forbidden,mandatory,notes\n' + 'API,接口2,false,false,true,\n',
    )

    const removed = await invoke(
      glossaryRoutes,
      'DELETE',
      '/projects/{projectId}/glossary/{entryId}',
      context({ projectId: String(projectId), entryId: String(entry.id) }),
    )
    expect(removed.response.status).toBe(204)
  })

  it('项目不存在 → 404', async () => {
    const missing = await invoke(
      glossaryRoutes,
      'GET',
      '/projects/{projectId}/glossary',
      context({ projectId: '999' }),
    )
    expect(missing.response.status).toBe(404)
  })
})
