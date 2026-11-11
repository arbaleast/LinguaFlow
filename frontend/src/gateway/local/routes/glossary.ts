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

import { loadFile } from '@/domain/glossary/file'

import {
  createGlossaryEntry,
  deleteGlossaryEntry,
  exportGlossaryCsv,
  listGlossary,
  toGlossaryDto,
  updateGlossaryEntry,
} from '../repositories/glossary'
import { requireProject } from '../repositories/projects'
import { RepositoryValidationError } from '../repositories/errors'
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

/**
 * CSV 导入端点。
 *
 * 请求体是 `multipart/form-data`（`file` 字段），与 `api/glossary.ts` 的
 * `importGlossaryCSV` 一致。为了让本地模式也能用纯文本调试，这里同时接受
 * `{ content: string }` 形态的 JSON 请求体。
 *
 * 解析复用 Phase 1 的 `domain/glossary`（与 Go `glossary.LoadFile` 逐字节等价），
 * 写入复用本包的 `createGlossaryEntry`（因此条件唯一约束与 409 语义一致）。
 */
export const glossaryImportRoutes: LocalRoute[] = [
  {
    method: 'POST',
    path: '/projects/{projectId}/glossary/import',
    handler: (ctx) =>
      route(async () => {
        const projectId = pathId(ctx, 'projectId')
        const content = await readUploadContent(ctx.body)
        const parsed = loadFile(content, 'import.csv')
        if (!parsed.ok) {
          throw new RepositoryValidationError(parsed.error.message)
        }
        const glossary = parsed.value

        const added: number[] = []
        const skipped: Array<{ line?: number; source?: string; reason?: string }> = []
        const entries = glossary.snapshotEntries()
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i]
          if (!entry) continue
          try {
            await createGlossaryEntry(ctx.db, projectId, {
              source: entry.source,
              target: entry.target,
              case_sensitive: entry.caseSensitive,
              forbidden: entry.forbidden,
              mandatory: entry.mandatory,
              notes: entry.notes,
            } as CreateGlossaryEntryRequest)
            added.push(i)
          } catch (error) {
            skipped.push({
              line: i + 1,
              source: entry.source,
              reason: error instanceof Error ? error.message : String(error),
            })
          }
        }

        const result: ApiSchemas['GlossaryImportResult'] = {
          added: added.length,
          ...(skipped.length > 0 ? { skipped } : {}),
        }
        return json(result)
      }),
  },
]

/** 从 multipart 表单或 JSON 请求体中读出 CSV 文本。 */
async function readUploadContent(body: unknown): Promise<string> {
  if (body && typeof body === 'object' && 'get' in body) {
    const form = body as FormData
    const file = form.get('file')
    if (file && typeof file === 'object' && 'text' in file) {
      return await (file as File).text()
    }
    throw new RepositoryValidationError('上传文件缺少 file 字段')
  }
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const content = (body as Record<string, unknown>).content
    if (typeof content === 'string') return content
  }
  throw new RepositoryValidationError('请求体必须是 multipart 表单或包含 CSV 文本')
}
