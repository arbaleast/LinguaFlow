<script setup lang="ts">
/**
 * 执行配置（统一入口）：执行策略与执行计划合并到同一页面。
 *
 * - Tab 与路由 Query 双向同步（?tab=profiles|plans，默认 profiles）；
 * - 两个 Tab 各自保留原有 Store、字段、校验规则与依赖加载流程；
 * - 执行计划仍按需拉取「AI 后端 / 提示词 / 执行策略」依赖，两个数据模型互不合并。
 */
import { useI18n } from 'vue-i18n'

import SectionTabs from '@/components/common/SectionTabs.vue'
import type { SectionTabItem } from '@/components/common/section-tabs'
import ExecutionPlanTemplatesPanel from '@/components/templates/ExecutionPlanTemplatesPanel.vue'
import ExecutionProfilesPanel from '@/components/templates/ExecutionProfilesPanel.vue'
import { useRouteTab } from '@/composables/useRouteTab'

type ExecutionConfigTab = 'profiles' | 'plans'

const { t } = useI18n()

const tabs = computed<SectionTabItem<ExecutionConfigTab>[]>(() => [
  {
    key: 'profiles',
    label: t('executionConfiguration.tabs.profiles'),
    panel: ExecutionProfilesPanel,
  },
  {
    key: 'plans',
    label: t('executionConfiguration.tabs.plans'),
    panel: ExecutionPlanTemplatesPanel,
  },
])

const { activeTab, setTab } = useRouteTab<ExecutionConfigTab>(
  [{ value: 'profiles' }, { value: 'plans' }],
  'profiles',
)
</script>

<template>
  <div class="lf-page lf-content-narrow">
    <PageHeader
      :title="t('executionConfiguration.title')"
      :subtitle="t('executionConfiguration.subtitle')"
    />

    <SectionTabs :tabs="tabs" :model-value="activeTab" @update:model-value="setTab" />
  </div>
</template>
