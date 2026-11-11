/**
 * 术语表端点（对齐 OpenAPI `/projects/{projectId}/glossary...`）。
 *
 * | 方法 | 路径 | 响应 |
 * |---|---|---|
 * | GET | `/projects/{projectId}/glossary` | `{ items: GlossaryEntry[] }` |
 * | POST | `/projects/{projectId}/glossary` | `GlossaryEntry`（201） |
 * | PUT | `/projects/{projectId}/glossary/{entryId}` | `GlossaryEntry & { target_changed }` |
 * | DELETE | `/projects/{projectId}/glossary/{entryId}` | 204 |
 * | GET | `/projects/{projectId}/glossary/export` | `text/csv; charset=utf-8` |
 *
 * CSV 响应没有复用 `responses.ts`（该文件已冻结且只有 JSON 构造器），
 * 这里按后端 handler 的字节形态就地构造 `Response` + `Blob`：
 * 前端 `api/glossary.ts` 用 `parseAs: 'blob'` 读取，Store 直接喂给
 * `URL.createObjectURL`，因此 `data` 必须是 `Blob`，`response` 是文本响应。
 */
import type { ApiSchemas, GatewayResult } from '@/gateway/contracts'

import {
  createGlossaryEntry,
  deleteGlossaryEntry,
  exportGlossaryCsv,
  listGlossary,
  toGlossaryDto,
  updateGlossaryEntry,
} from '../repositories/glossary'
import { requireProject } from '../repositories/projects'
import { json, noContent } from '../responses'
import type { LocalRoute } from '../router'
import { bodyObject, pathId, route } from './support'

type CreateGlossaryEntryRequest = ApiSchemas['CreateGlossaryEntryRequest']
type UpdateGlossaryEntryRequest = ApiSchemas['UpdateGlossaryEntryRequest']

/** 后端 `handleExportGlossaryCSV` 的 Content-Type。 */
const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8'

/**
 * 构造 CSV 成功响应。
 *
 * `data` 为 Blob（与 openapi-fetch `parseAs:'blob'` 的产物同型），
 * `response` 为等价的文本 Response，便于非 fetch 调用方直接读取。
 */
function csvResponse(text: string): GatewayResult<Blob> {
  const headers = new Headers({
    'content-type': CSV_CONTENT_TYPE,
    'content-disposition': 'attachment; filename="glossary.csv"',
  })
  return {
    data: new Blob([text], { type: CSV_CONTENT_TYPE }),
    error: undefined,
    response: new Response(text, { status: 200, headers }),
  }
}

export const glossaryRoutes: LocalRoute[] = [
  {
    method: 'GET',
    path: '/projects/{projectId}/glossary',
    handler: (ctx) =>
      route(async () => {
        const projectId = pathId(ctx, 'projectId')
        await requireProject(ctx.db, projectId)
        const rows = await listGlossary(ctx.db, projectId)
        return json({ items: rows.map(toGlossaryDto) })
      }),
  },
  {
    method: 'POST',
    path: '/projects/{projectId}/glossary',
    handler: (ctx) =>
      route(async () => {
        const projectId = pathId(ctx, 'projectId')
        const body = bodyObject(ctx) as unknown as CreateGlossaryEntryRequest
        const row = await createGlossaryEntry(ctx.db, projectId, body)
        return json(toGlossaryDto(row), 201)
      }),
  },
  {
    method: 'PUT',
    path: '/projects/{projectId}/glossary/{entryId}',
    handler: (ctx) =>
      route(async () => {
        const projectId = pathId(ctx, 'projectId')
        const entryId = pathId(ctx, 'entryId')
        const body = bodyObject(ctx) as unknown as UpdateGlossaryEntryRequest
        const result = await updateGlossaryEntry(ctx.db, projectId, entryId, body)
        return json({ ...toGlossaryDto(result.row), target_changed: result.target_changed })
      }),
  },
  {
    method: 'DELETE',
    path: '/projects/{projectId}/glossary/{entryId}',
    handler: (ctx) =>
      route(async () => {
        const projectId = pathId(ctx, 'projectId')
        const entryId = pathId(ctx, 'entryId')
        await deleteGlossaryEntry(ctx.db, projectId, entryId)
        return noContent()
      }),
  },
  {
    method: 'GET',
    path: '/projects/{projectId}/glossary/export',
    handler: (ctx) =>
      route(async () => {
        const projectId = pathId(ctx, 'projectId')
        return csvResponse(await exportGlossaryCsv(ctx.db, projectId))
      }),
  },
]
