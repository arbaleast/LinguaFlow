/**
 * 本地「项目存储」端点（对齐 OpenAPI `/projects/{projectId}/storage`）。
 *
 * 浏览器本地模式只有一个逻辑存储空间，该端点直接返回「始终就绪、可写、无维护」
 * 的快照，使 `stores/projectWorkspace.ts` 的 `prepareStorageWrite` 在本地模式下顺畅通过。
 */
import { getProjectStorage } from '../repositories/storage'
import { json } from '../responses'
import type { LocalRoute } from '../router'
import { pathId, route } from './support'

export const storageRoutes: LocalRoute[] = [
  {
    method: 'GET',
    path: '/projects/{projectId}/storage',
    handler: (ctx) =>
      route(async () => {
        const projectId = pathId(ctx, 'projectId')
        return json(await getProjectStorage(ctx.db, projectId))
      }),
  },
]
