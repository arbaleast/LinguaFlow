<script setup lang="ts">
/**
 * AI 配置（统一入口）：模型服务、提示词模板与用量统计合并到同一页面。
 *
 * - 一级 Tab 与路由 Query 双向同步（?tab=backends|prompts|usage，默认 backends）；
 * - 「模型服务」保留原有的后端管理列表与全部 CRUD / 模型测试功能；
 * - 「提示词模板」承接原「提示词管理」页面（内层三分类走 ?promptTab=）；
 * - 「用量统计」按需挂载用量面板：仅切换到该 Tab 时才请求 stats 与 activities 接口。
 */
import { useI18n } from 'vue-i18n'

import BackendsPanel from '@/components/backends/BackendsPanel.vue'
import SectionTabs from '@/components/common/SectionTabs.vue'
import type { SectionTabItem } from '@/components/common/section-tabs'
import WorkbenchUsagePanel from '@/components/dashboard/WorkbenchUsagePanel.vue'
import PromptsPanel from '@/components/prompts/PromptsPanel.vue'
import { useRouteTab } from '@/composables/useRouteTab'
import { useStatsStore } from '@/stores/stats'

type AConfigTab = 'backends' | 'prompts' | 'usage'

const { t } = useI18n()
const stats = useStatsStore()

const tabs = computed<SectionTabItem<AConfigTab>[]>(() => [
  {
    key: 'backends',
    label: t('backends.tabs.backends'),
    panel: BackendsPanel,
  },
  {
    key: 'prompts',
    label: t('backends.tabs.prompts'),
    panel: PromptsPanel,
  },
  {
    key: 'usage',
    label: t('backends.tabs.usage'),
    panel: WorkbenchUsagePanel,
  },
])

const { activeTab, setTab } = useRouteTab<AConfigTab>(
  [{ value: 'backends' }, { value: 'prompts' }, { value: 'usage' }],
  'backends',
)

/** 「用量统计」Tab 的刷新信号：外层「刷新」按钮推进该计数（其余 Tab 的操作在面板内部） */
const usageRefreshKey = ref(0)

const panelProps = computed(() =>
  activeTab.value === 'usage' ? { refreshKey: usageRefreshKey.value } : {},
)

const refreshUsage = (): void => {
  usageRefreshKey.value += 1
}

const subtitle = computed(() => {
  if (activeTab.value === 'usage') return t('stats.subtitle')
  if (activeTab.value === 'prompts') return t('promptTemplateManagement.subtitle')
  return t('backends.subtitle')
})
</script>

<template>
  <div class="lf-page lf-content-narrow">
    <PageHeader :title="t('backends.title')" :subtitle="subtitle">
      <template #actions>
        <NButton
          v-if="activeTab === 'usage'"
          secondary
          :loading="stats.statsLoading || stats.activitiesLoading"
          @click="refreshUsage"
        >
          {{ t('common.actions.refresh') }}
        </NButton>
      </template>
    </PageHeader>

    <SectionTabs
      :tabs="tabs"
      :model-value="activeTab"
      :panel-props="panelProps"
      @update:model-value="setTab"
    />
  </div>
</template>
