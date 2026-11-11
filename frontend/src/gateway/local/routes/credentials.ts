/**
 * 凭据与 AI 后端端点（对齐 OpenAPI `/credentials...`、`/backends...`）。
 *
 * | 方法 | 路径 | 响应 |
 * |---|---|---|
 * | GET | `/credentials` | `Credential[]` |
 * | POST | `/credentials` | `Credential`（201） |
 * | GET | `/credentials/{credentialId}/versions` | `CredentialVersion[]` |
 * | POST | `/credentials/{credentialId}/versions` | `{ id, version }`（201） |
 * | POST | `/credentials/{credentialId}/versions/{version}/revoke` | 204 |
 * | POST | `/credentials/{credentialId}/collect` | `{ deleted_versions }` |
 * | GET | `/backends` | `Backend[]` |
 * | POST | `/backends` | `Backend`（201） |
 * | GET | `/backends/{backendId}` | `Backend` |
 * | PUT | `/backends/{backendId}` | `Backend` |
 * | DELETE | `/backends/{backendId}` | 204 |
 *
 * **安全**：任何响应都**不含** API Key 明文（secret 只以 AES-GCM 密文落盘）。
 */
import { json, noContent } from '../responses'
import type { LocalRoute } from '../router'
import {
  collectCredentialVersions,
  createCredential,
  listCredentialVersions,
  listCredentials,
  revokeCredentialVersion,
  rotateCredential,
  toCredentialDto,
} from '../repositories/credentials'
import {
  createBackend,
  deleteBackend,
  getBackend,
  listBackends,
  toBackendDto,
  updateBackend,
} from '../repositories/backends'
import { RepositoryNotFoundError } from '../repositories/errors'
import { bodyObject, pathId, route } from './support'

export const credentialRoutes: LocalRoute[] = [
  {
    method: 'GET',
    path: '/credentials',
    handler: (ctx) =>
      route(async () => {
        const rows = await listCredentials(ctx.db)
        return json(rows.map(toCredentialDto))
      }),
  },
  {
    method: 'POST',
    path: '/credentials',
    handler: (ctx) =>
      route(async () => {
        const dto = await createCredential(ctx.db, ctx.vault, bodyObject(ctx))
        return json(dto, 201)
      }),
  },
  {
    method: 'GET',
    path: '/credentials/{credentialId}/versions',
    handler: (ctx) =>
      route(async () => {
        const credentialId = pathId(ctx, 'credentialId')
        return json(await listCredentialVersions(ctx.db, credentialId))
      }),
  },
  {
    method: 'POST',
    path: '/credentials/{credentialId}/versions',
    handler: (ctx) =>
      route(async () => {
        const credentialId = pathId(ctx, 'credentialId')
        const result = await rotateCredential(ctx.db, ctx.vault, credentialId, bodyObject(ctx))
        return json(result, 201)
      }),
  },
  {
    method: 'POST',
    path: '/credentials/{credentialId}/versions/{version}/revoke',
    handler: (ctx) =>
      route(async () => {
        const credentialId = pathId(ctx, 'credentialId')
        const version = pathId(ctx, 'version')
        await revokeCredentialVersion(ctx.db, credentialId, version)
        return noContent()
      }),
  },
  {
    method: 'POST',
    path: '/credentials/{credentialId}/collect',
    handler: (ctx) =>
      route(async () => {
        const credentialId = pathId(ctx, 'credentialId')
        return json(await collectCredentialVersions(ctx.db, credentialId))
      }),
  },
]

export const backendRoutes: LocalRoute[] = [
  {
    method: 'GET',
    path: '/backends',
    handler: (ctx) =>
      route(async () => {
        const rows = await listBackends(ctx.db)
        return json(rows.map(toBackendDto))
      }),
  },
  {
    method: 'POST',
    path: '/backends',
    handler: (ctx) =>
      route(async () => {
        const row = await createBackend(ctx.db, bodyObject(ctx))
        return json(toBackendDto(row), 201)
      }),
  },
  {
    method: 'GET',
    path: '/backends/{backendId}',
    handler: (ctx) =>
      route(async () => {
        const backendId = pathId(ctx, 'backendId')
        const row = await getBackend(ctx.db, backendId)
        if (!row) throw new RepositoryNotFoundError('后端', backendId)
        return json(toBackendDto(row))
      }),
  },
  {
    method: 'PUT',
    path: '/backends/{backendId}',
    handler: (ctx) =>
      route(async () => {
        const backendId = pathId(ctx, 'backendId')
        const row = await updateBackend(ctx.db, backendId, bodyObject(ctx))
        return json(toBackendDto(row))
      }),
  },
  {
    method: 'DELETE',
    path: '/backends/{backendId}',
    handler: (ctx) =>
      route(async () => {
        const backendId = pathId(ctx, 'backendId')
        await deleteBackend(ctx.db, backendId)
        return noContent()
      }),
  },
]
