/**
 * 资源 Repository（对应后端 `service/resource.go` + `handler_resource.go`）。
 *
 * 资源本体（EPUB/DOCX/…）存在 OPFS，业务表只保存路径、格式、代际与段落计数。
 * 本文件只做元数据的读、树构建、软删与 DTO 映射；上传解析由负责存储/解析的
 * 同事实现，段落级 CAS 也不在这里。
 *
 * 目录树语义与后端 `buildResourceTreeResponse` 完全一致：
 *
 * - 根节点 `{ type: 'directory', name: '', path: '' }`；
 * - 按 `path` 的 `/` 分段逐级建目录；
 * - 叶子是 `{ type: 'resource', name, path, resource }`；
 * - 子节点排序：**目录优先**，同类型按 `name` 的 UTF-8 字节序升序；
 * - 空 `children` 不输出（对齐 Go 的 `omitempty`）。
 */
import type { ApiSchemas } from '@/gateway/contracts'
import type { LinguaFlowDatabase } from '@/infrastructure/indexeddb/db'
import { softDelete } from '@/infrastructure/indexeddb/repo'
import type { ResourceRow } from '@/infrastructure/indexeddb/types'

import { RepositoryNotFoundError } from './errors'
import { compareUtf8 } from './order'
import { requireProject } from './projects'

type Resource = ApiSchemas['Resource']
type ResourceTreeNode = ApiSchemas['ResourceTreeNode']

/** 列出项目下未删除资源，按 `localId` 升序。 */
export async function listResources(
  db: LinguaFlowDatabase,
  projectId: number,
): Promise<ResourceRow[]> {
  return db.resources
    .where('project_id')
    .equals(projectId)
    .filter((row) => row.deletedAt === null)
    .sortBy('localId')
}

/** 读取项目下的单个资源；不存在、已软删或不属于该项目返回 `undefined`。 */
export async function getResource(
  db: LinguaFlowDatabase,
  projectId: number,
  resourceId: number,
): Promise<ResourceRow | undefined> {
  const row = await db.resources.where('localId').equals(resourceId).first()
  if (!row || row.project_id !== projectId || row.deletedAt !== null) return undefined
  return row
}

/** 删除资源（软删墓碑）；不存在时抛 `RepositoryNotFoundError`。 */
export async function deleteResource(
  db: LinguaFlowDatabase,
  projectId: number,
  resourceId: number,
): Promise<void> {
  await db.transaction('rw', db.resources, async () => {
    const row = await db.resources.where('localId').equals(resourceId).first()
    if (!row || row.project_id !== projectId || row.deletedAt !== null) {
      throw new RepositoryNotFoundError('资源', resourceId)
    }
    await db.resources.put(softDelete(row, row.deviceId))
  })
}

/**
 * 构建项目资源目录树。
 *
 * 项目不存在时抛 `RepositoryNotFoundError`（路由层映射 404），与后端
 * `requireProjectAccess` 一致。
 */
export async function resourceTree(
  db: LinguaFlowDatabase,
  projectId: number,
): Promise<ResourceTreeNode> {
  await requireProject(db, projectId)
  const rows = await listResources(db, projectId)

  const root: ResourceTreeNode = { type: 'directory', name: '', path: '', children: [] }
  for (const row of rows) {
    const resource = toResourceDto(row)
    const parts = resource.path.split('/')
    let current = root

    for (let index = 0; index < parts.length; index++) {
      const part = parts[index] as string
      const currentPath = parts.slice(0, index + 1).join('/')
      if (index === parts.length - 1) {
        current.children?.push({
          type: 'resource',
          name: resource.name,
          path: resource.path,
          resource,
        })
        continue
      }
      const children = current.children ?? (current.children = [])
      let directory = children.find(
        (child) => child.type === 'directory' && child.path === currentPath,
      )
      if (!directory) {
        directory = { type: 'directory', name: part, path: currentPath, children: [] }
        children.push(directory)
      }
      current = directory
    }
  }

  sortTree(root)
  pruneEmptyChildren(root)
  return root
}

/** 资源行 → OpenAPI `Resource` DTO。 */
export function toResourceDto(row: ResourceRow): Resource {
  const path = row.path.trim()
  return {
    id: row.localId,
    current_source_revision_id: row.current_source_revision_id,
    source_generation: row.source_generation,
    translation_generation: row.translation_generation,
    path,
    name: resourceNameFromPath(path),
    directory: resourceDirectoryFromPath(path),
    format: row.format,
    total_segments: row.total_segments,
    translated_segments: row.translated_segments,
    approved_segments: row.approved_segments,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

/** 等价 Go `filepath.Base`（含 `.` / 根路径 → `resource` 的兜底）。 */
export function resourceNameFromPath(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  const trimmed = base.trim()
  if (trimmed === '' || base === '.' || base === '/') return 'resource'
  return base
}

/** 等价 Go `filepath.Dir` + `ToSlash`（`.` → 空串）。 */
export function resourceDirectoryFromPath(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const index = normalized.lastIndexOf('/')
  if (index < 0) return ''
  const directory = normalized.slice(0, index)
  return directory === '.' || directory === '' ? '' : directory
}

/** 目录优先、同类型按名称 UTF-8 字节序排序（递归）。 */
function sortTree(node: ResourceTreeNode): void {
  const children = node.children
  if (!children || children.length === 0) return
  children.sort((left, right) => {
    if (left.type !== right.type) return left.type === 'directory' ? -1 : 1
    return compareUtf8(left.name, right.name)
  })
  for (const child of children) sortTree(child)
}

/** 删除空的 `children`（Go `json:"children,omitempty"`）。 */
function pruneEmptyChildren(node: ResourceTreeNode): void {
  if (!node.children || node.children.length === 0) {
    delete node.children
    return
  }
  for (const child of node.children) pruneEmptyChildren(child)
}
