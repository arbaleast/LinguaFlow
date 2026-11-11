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
import type { GatewayResult } from '@/gateway/contracts'
import type { LocalRequestContext, LocalRoute } from '../router'
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

/**
 * 资源文件下载端点。
 *
 * 源文件本体**不进 IndexedDB**，而是存在 OPFS（或降级的 `raw_blobs`）里，
 * `ResourceRow.opfs_path` 记录对象键。这里按后端 handler 的语义返回二进制：
 *
 * - `/download` 返回源文件本体；
 * - `/download-translated` 返回译文产物（对象键为 `<opfs_path>.translated`，
 *   不存在时返回 404）。
 *
 * 前端 `api/projects.ts` 用 `parseAs: 'blob'` 读取，因此 `data` 必须是 `Blob`。
 */
export const resourceDownloadRoutes: LocalRoute[] = [
  {
    method: 'GET',
    path: '/projects/{projectId}/resources/{resourceId}/download',
    handler: (ctx) =>
      route(async () => {
        const projectId = pathId(ctx, 'projectId')
        const resourceId = pathId(ctx, 'resourceId')
        await requireProject(ctx.db, projectId)
        const row = await getResource(ctx.db, projectId, resourceId)
        if (!row) throw new RepositoryNotFoundError('资源', resourceId)
        return await serveBlob(ctx.blobs, row.opfs_path, row.name, row.format)
      }),
  },
  {
    method: 'GET',
    path: '/projects/{projectId}/resources/{resourceId}/download-translated',
    handler: (ctx) =>
      route(async () => {
        const projectId = pathId(ctx, 'projectId')
        const resourceId = pathId(ctx, 'resourceId')
        await requireProject(ctx.db, projectId)
        const row = await getResource(ctx.db, projectId, resourceId)
        if (!row) throw new RepositoryNotFoundError('资源', resourceId)
        const key = row.opfs_path ? `${row.opfs_path}.translated` : null
        return await serveBlob(ctx.blobs, key, translatedName(row.name), row.format)
      }),
  },
]

/** 译文产物的文件名（`<name>.translated.<ext>`）。 */
function translatedName(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return `${name}.translated`
  return `${name.slice(0, dot)}.translated${name.slice(dot)}`
}

/** 读取对象并构造二进制响应。 */
async function serveBlob(
  blobs: LocalRequestContext['blobs'],
  key: string | null,
  filename: string,
  format: string,
): Promise<GatewayResult<Blob>> {
  if (!key) throw new RepositoryNotFoundError('文件', filename)
  const blob = await blobs.read(key)
  if (!blob) throw new RepositoryNotFoundError('文件', filename)
  return {
    data: blob,
    error: undefined,
    response: new Response(blob, {
      status: 200,
      headers: {
        'content-type': contentTypeFor(format),
        'content-disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      },
    }),
  }
}

/** 由资源格式推断 Content-Type（缺省按二进制流）。 */
function contentTypeFor(format: string): string {
  switch (format.toLowerCase()) {
    case 'epub':
      return 'application/epub+zip'
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case 'txt':
    case 'text':
      return 'text/plain; charset=utf-8'
    case 'json':
      return 'application/json'
    case 'md':
    case 'markdown':
      return 'text/markdown; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}
