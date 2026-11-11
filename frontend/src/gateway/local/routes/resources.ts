/**
 * 资源端点（对齐 OpenAPI `/projects/{projectId}/resources...`）。
 *
 * | 方法 | 路径 | 响应 |
 * |---|---|---|
 * | GET | `/projects/{projectId}/resources` | `{ items: Resource[] }` |
 * | GET | `/projects/{projectId}/resources/tree` | `{ root: ResourceTreeNode }` |
 * | GET | `/projects/{projectId}/resources/{resourceId}` | `Resource` |
 * | DELETE | `/projects/{projectId}/resources/{resourceId}` | 204 |
 *
 * 注意树响应外壳是 `{ root }`（不是 `{ items }`）：`api/types.d.ts` 的
 * `ResourceTreeResponse` 只声明了一个根节点，前端 Store 直接消费 `response.root`。
 */
import {
  deleteResource,
  getResource,
  listResources,
  resourceTree,
  toResourceDto,
} from '../repositories/resources'
import { requireProject } from '../repositories/projects'
import { RepositoryNotFoundError } from '../repositories/errors'
import { json, noContent } from '../responses'
import type { LocalRoute } from '../router'
import { pathId, route } from './support'

export const resourceRoutes: LocalRoute[] = [
  {
    method: 'GET',
    path: '/projects/{projectId}/resources',
    handler: (ctx) =>
      route(async () => {
        const projectId = pathId(ctx, 'projectId')
        await requireProject(ctx.db, projectId)
        const rows = await listResources(ctx.db, projectId)
        return json({ items: rows.map(toResourceDto) })
      }),
  },
  {
    method: 'GET',
    path: '/projects/{projectId}/resources/tree',
    handler: (ctx) =>
      route(async () => {
        const projectId = pathId(ctx, 'projectId')
        return json({ root: await resourceTree(ctx.db, projectId) })
      }),
  },
  {
    method: 'GET',
    path: '/projects/{projectId}/resources/{resourceId}',
    handler: (ctx) =>
      route(async () => {
        const projectId = pathId(ctx, 'projectId')
        const resourceId = pathId(ctx, 'resourceId')
        await requireProject(ctx.db, projectId)
        const row = await getResource(ctx.db, projectId, resourceId)
        if (!row) throw new RepositoryNotFoundError('资源', resourceId)
        return json(toResourceDto(row))
      }),
  },
  {
    method: 'DELETE',
    path: '/projects/{projectId}/resources/{resourceId}',
    handler: (ctx) =>
      route(async () => {
        const projectId = pathId(ctx, 'projectId')
        const resourceId = pathId(ctx, 'resourceId')
        await requireProject(ctx.db, projectId)
        await deleteResource(ctx.db, projectId, resourceId)
        return noContent()
      }),
  },
]
