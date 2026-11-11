<script setup lang="ts">
/**
 * 术语精简提示词面板（提示词管理 → 术语精简提示词 Tab）。
 *
 * 仅做「视图配置」：注入术语精简提示词专属的 store、请求字段名、变量集与保存适配器，
 * 列表、筛选、分页、抽屉与校验逻辑全部复用 PromptTemplateListPage。
 */
import type { ApiSchemas } from '@/api/client'

import PromptTemplateListPage, {
  type TemplateFormPayload,
} from '@/components/templates/PromptTemplateListPage.vue'
import { usePrunePromptTemplatesStore } from '@/stores/prunePromptTemplates'

type CreateRequest = ApiSchemas['CreatePrunePromptTemplateRequest']

const store = usePrunePromptTemplatesStore()

/** 归一化表单 → 术语精简提示词请求（内容字段为 content） */
const save = (payload: TemplateFormPayload, id?: number): Promise<unknown> => {
  const request: CreateRequest = { name: payload.name }
  if (payload.description) request.description = payload.description
  if (payload.content) request.content = payload.content

  return id === undefined ? store.createTemplate(request) : store.updateTemplate(id, request)
}
</script>

<template>
  <PromptTemplateListPage
    embedded
    :store="store"
    i18n-prefix="prunePromptTemplates"
    content-field="content"
    variable-set="prune"
    :save="save"
  />
</template>
