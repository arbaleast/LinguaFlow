<script setup lang="ts">
/**
 * 工作台（统一入口）：概览与用量合并到同一页面。
 *
 * - Tab 与路由 Query 双向同步（?tab=overview|usage，默认 overview）；
 * - 「概览」保留工作台首屏全部能力（即时翻译面板、最近打开项目、任务恢复列表）；
 * - 「用量」保留原用量概览的全部统计（API 调用、Token、任务数量、活动记录与图表）；
 * - 用量 Tab 的统计接口按需加载：默认进入概览时不会提前请求。
 */
import { useI18n } from 'vue-i18n'

import SectionTabs from '@/components/common/SectionTabs.vue'
import type { SectionTabItem } from '@/components/common/section-tabs'
import WorkbenchOverviewPanel from '@/components/dashboard/WorkbenchOverviewPanel.vue'
import WorkbenchUsagePanel from '@/components/dashboard/WorkbenchUsagePanel.vue'
import { useRouteTab } from '@/composables/useRouteTab'
import { useStatsStore } from '@/stores/stats'

type WorkbenchTab = 'overview' | 'usage'

const { t } = useI18n()
const router = useRouter()
const stats = useStatsStore()

const tabs = computed<SectionTabItem<WorkbenchTab>[]>(() => [
  {
    key: 'overview',
    label: t('workbench.tabs.overview'),
    panel: WorkbenchOverviewPanel,
  },
  {
    key: 'usage',
    label: t('workbench.tabs.usage'),
    panel: WorkbenchUsagePanel,
  },
])

const { activeTab, setTab } = useRouteTab<WorkbenchTab>(
  [{ value: 'overview' }, { value: 'usage' }],
  'overview',
)

/** 每个 Tab 独立的刷新信号：只有当前 Tab 的刷新按钮会推进对应计数 */
const refreshKeys = reactive<Record<WorkbenchTab, number>>({ overview: 0, usage: 0 })

const panelProps = computed(() => ({ refreshKey: refreshKeys[activeTab.value] }))

const refreshActiveTab = (): void => {
  refreshKeys[activeTab.value] += 1
}

const subtitle = computed(() =>
  activeTab.value === 'usage' ? t('stats.subtitle') : t('workbench.home.subtitle'),
)
</script>

<template>
  <div class="lf-page lf-content-narrow">
    <PageHeader :title="t('workbench.home.title')" :subtitle="subtitle">
      <template #actions>
        <NButton
          secondary
          :loading="activeTab === 'usage' && (stats.statsLoading || stats.activitiesLoading)"
          @click="refreshActiveTab"
        >
          {{ t('common.actions.refresh') }}
        </NButton>
        <template v-if="activeTab === 'overview'">
          <NButton
            type="primary"
            @click="router.push({ path: '/projects', query: { create: '1' } })"
          >
            <IconCarbonAddAlt />
            {{ t('dashboard.quickActions.createProject.title') }}
          </NButton>
        </template>
      </template>
    </PageHeader>

    <SectionTabs
      :tabs="tabs"
      :model-value="activeTab"
      :panel-props="panelProps"
      compact
      @update:model-value="setTab"
    />
  </div>
</template>
