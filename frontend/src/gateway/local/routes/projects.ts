/**
 * 项目端点（对齐 OpenAPI `/projects` 与 `/projects/{projectId}`）。
 *
 * | 方法 | 路径 | 响应 |
 * |---|---|---|
 * | GET | `/projects` | `{ items: Project[] }` |
 * | POST | `/projects` | `Project`（201） |
 * | GET | `/projects/{projectId}` | `Project` |
 * | PUT | `/projects/{projectId}` | `Project` |
 * | DELETE | `/projects/{projectId}` | 204 |
 */
import type { ApiSchemas } from '@/gateway/contracts'

import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  toProjectDto,
  updateProject,
} from '../repositories/projects'
import { RepositoryNotFoundError } from '../repositories/errors'
import { json, noContent } from '../responses'
import type { LocalRoute } from '../router'
import { bodyObject, pathId, route } from './support'

type CreateProjectRequest = ApiSchemas['CreateProjectRequest']
type UpdateProjectRequest = ApiSchemas['UpdateProjectRequest']

export const projectRoutes: LocalRoute[] = [
  {
    method: 'GET',
    path: '/projects',
    handler: (ctx) =>
      route(async () => {
        const rows = await listProjects(ctx.db)
        return json({ items: rows.map(toProjectDto) })
      }),
  },
  {
    method: 'POST',
    path: '/projects',
    handler: (ctx) =>
      route(async () => {
        const body = bodyObject(ctx) as unknown as CreateProjectRequest
        const row = await createProject(ctx.db, body)
        return json(toProjectDto(row), 201)
      }),
  },
  {
    method: 'GET',
    path: '/projects/{projectId}',
    handler: (ctx) =>
      route(async () => {
        const projectId = pathId(ctx, 'projectId')
        const row = await getProject(ctx.db, projectId)
        if (!row) throw new RepositoryNotFoundError('项目', projectId)
        return json(toProjectDto(row))
      }),
  },
  {
    method: 'PUT',
    path: '/projects/{projectId}',
    handler: (ctx) =>
      route(async () => {
        const projectId = pathId(ctx, 'projectId')
        const body = bodyObject(ctx) as unknown as UpdateProjectRequest
        const row = await updateProject(ctx.db, projectId, body)
        return json(toProjectDto(row))
      }),
  },
  {
    method: 'DELETE',
    path: '/projects/{projectId}',
    handler: (ctx) =>
      route(async () => {
        const projectId = pathId(ctx, 'projectId')
        await deleteProject(ctx.db, projectId)
        return noContent()
      }),
  },
]
