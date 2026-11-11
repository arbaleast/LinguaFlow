/**
 * 模板端点（对齐 OpenAPI 的 5 组模板路径）。
 *
 * | 种类 | 列表 | 创建 | 读取 | 更新 | 删除 |
 * |---|---|---|---|---|---|
 * | 翻译提示词 | `/translation-prompt-templates` | POST | — | — | — |
 * | 术语抽取提示词 | `/bootstrap-prompt-templates` | POST | — | — | — |
 * | 术语精简提示词 | `/prune-prompt-templates` | POST | — | — | — |
 * | 执行计划模板 | `/execution-plan-templates` | POST | — | — | — |
 * | 执行策略 | `/execution-profiles` | POST | `/execution-profiles/{executionProfileId}` | PUT | DELETE |
 *
 * 5 组路径的**方法与形态完全同构**，因此用一张表描述差异后批量生成路由。
 */
import type { ApiSchemas } from '@/gateway/contracts'

import {
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  toTemplateDto,
  updateTemplate,
  type TemplateKind,
} from '../repositories/templates'
import { RepositoryNotFoundError } from '../repositories/errors'
import { json, noContent } from '../responses'
import type { LocalRoute } from '../router'
import { bodyObject, pathId, route } from './support'

/** 一组模板端点的描述。 */
interface TemplateEndpoint {
  kind: TemplateKind
  /** 列表 / 创建路径。 */
  path: string
  /** 详情路径（含 `{id}` 占位）；为 `null` 表示该组不支持详情端点。 */
  detailPath: string | null
  /** 路径参数名。 */
  param: string
}

/** 5 组模板端点。 */
const ENDPOINTS: TemplateEndpoint[] = [
  {
    kind: 'translation_prompt_template',
    path: '/translation-prompt-templates',
    detailPath: '/translation-prompt-templates/{translationPromptTemplateId}',
    param: 'translationPromptTemplateId',
  },
  {
    kind: 'bootstrap_prompt_template',
    path: '/bootstrap-prompt-templates',
    detailPath: '/bootstrap-prompt-templates/{bootstrapPromptTemplateId}',
    param: 'bootstrapPromptTemplateId',
  },
  {
    kind: 'prune_prompt_template',
    path: '/prune-prompt-templates',
    detailPath: '/prune-prompt-templates/{prunePromptTemplateId}',
    param: 'prunePromptTemplateId',
  },
  {
    kind: 'execution_plan_template',
    path: '/execution-plan-templates',
    detailPath: '/execution-plan-templates/{executionPlanTemplateId}',
    param: 'executionPlanTemplateId',
  },
  {
    kind: 'execution_profile',
    path: '/execution-profiles',
    detailPath: '/execution-profiles/{executionProfileId}',
    param: 'executionProfileId',
  },
]

/** 为一组模板端点生成路由。 */
function buildRoutes(endpoint: TemplateEndpoint): LocalRoute[] {
  const routes: LocalRoute[] = [
    {
      method: 'GET',
      path: endpoint.path,
      handler: (ctx) =>
        route(async () => {
          const rows = await listTemplates(ctx.db, endpoint.kind)
          return json({ items: rows.map((row) => toTemplateDto(endpoint.kind, row)) })
        }),
    },
    {
      method: 'POST',
      path: endpoint.path,
      handler: (ctx) =>
        route(async () => {
          const body = bodyObject(ctx) as unknown as Record<string, unknown>
          const row = await createTemplate(ctx.db, endpoint.kind, body)
          return json(toTemplateDto(endpoint.kind, row), 201)
        }),
    },
  ]

  if (endpoint.detailPath !== null) {
    routes.push(
      {
        method: 'GET',
        path: endpoint.detailPath,
        handler: (ctx) =>
          route(async () => {
            const id = pathId(ctx, endpoint.param)
            const row = await getTemplate(ctx.db, endpoint.kind, id)
            if (!row) throw new RepositoryNotFoundError('模板', id)
            return json(toTemplateDto(endpoint.kind, row))
          }),
      },
      {
        method: 'PUT',
        path: endpoint.detailPath,
        handler: (ctx) =>
          route(async () => {
            const id = pathId(ctx, endpoint.param)
            const body = bodyObject(ctx) as unknown as Record<string, unknown>
            const row = await updateTemplate(ctx.db, endpoint.kind, id, body)
            return json(toTemplateDto(endpoint.kind, row))
          }),
      },
      {
        method: 'DELETE',
        path: endpoint.detailPath,
        handler: (ctx) =>
          route(async () => {
            const id = pathId(ctx, endpoint.param)
            await deleteTemplate(ctx.db, endpoint.kind, id)
            return noContent()
          }),
      },
    )
  }

  return routes
}

/** 5 组模板的全部端点。 */
export const templateRoutes: LocalRoute[] = ENDPOINTS.flatMap(buildRoutes)

/** 供外部复用的 DTO 类型别名。 */
export type TemplateListResponse = ApiSchemas['TranslationPromptTemplateListResponse']
