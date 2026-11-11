<script setup lang="ts">
/**
 * 提示词模板面板（AI 配置 → 提示词模板 Tab）。
 *
 * 承接原「提示词管理」页面的三个分类：翻译 / 术语抽取 / 术语精简。
 *
 * - 内层分类 Tab 与 `?promptTab=` 双向同步（一级 Tab 用 `?tab=`，互不冲突）；
 * - 各分类继续使用各自原有的 Store 与 API，数据模型与接口契约不变；
 * - 面板按需挂载并由 KeepAlive 保活，切换分类不丢搜索条件与未保存的表单。
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
  { queryKey: 'promptTab' },
)
</script>

<template>
  <SectionTabs :tabs="tabs" :model-value="activeTab" @update:model-value="setTab" />
</template>
