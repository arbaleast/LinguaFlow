<script setup lang="ts">
/**
 * 提示词管理（统一入口）：翻译 / 术语抽取 / 术语精简三类提示词合并到同一页面。
 *
 * - Tab 与路由 Query 双向同步（?tab=translation|bootstrap|prune，默认 translation）；
 * - 各 Tab 继续使用各自原有的 Store 与 API，底层数据模型与接口契约保持不变；
 * - 面板按需挂载并由 KeepAlive 保活，切换 Tab 不丢搜索条件与未保存的表单。
 */
import { useI18n } from 'vue-i18n'

import SectionTabs from '@/components/common/SectionTabs.vue'
import type { SectionTabItem } from '@/components/common/section-tabs'
import BootstrapPromptTemplatesPanel from '@/components/templates/BootstrapPromptTemplatesPanel.vue'
import PrunePromptTemplatesPanel from '@/components/templates/PrunePromptTemplatesPanel.vue'
import TranslationPromptTemplatesPanel from '@/components/templates/TranslationPromptTemplatesPanel.vue'
import { useRouteTab } from '@/composables/useRouteTab'

type PromptTemplateTab = 'translation' | 'bootstrap' | 'prune'

const { t } = useI18n()

const tabs = computed<SectionTabItem<PromptTemplateTab>[]>(() => [
  {
    key: 'translation',
    label: t('promptTemplateManagement.tabs.translation'),
    panel: TranslationPromptTemplatesPanel,
  },
  {
    key: 'bootstrap',
    label: t('promptTemplateManagement.tabs.bootstrap'),
    panel: BootstrapPromptTemplatesPanel,
  },
  {
    key: 'prune',
    label: t('promptTemplateManagement.tabs.prune'),
    panel: PrunePromptTemplatesPanel,
  },
])

const { activeTab, setTab } = useRouteTab<PromptTemplateTab>(
  [{ value: 'translation' }, { value: 'bootstrap' }, { value: 'prune' }],
  'translation',
)
</script>

<template>
  <div class="lf-page lf-content-narrow">
    <PageHeader
      :title="t('promptTemplateManagement.title')"
      :subtitle="t('promptTemplateManagement.subtitle')"
    />

    <SectionTabs :tabs="tabs" :model-value="activeTab" @update:model-value="setTab" />
  </div>
</template>
