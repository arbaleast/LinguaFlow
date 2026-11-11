<script setup lang="ts">
/**
 * 工作台「用量」面板。
 *
 * 由原「用量概览」页面迁移而来：API 调用、Token 消耗、任务数量统计、活动记录与
 * 时间范围相关的展示全部保留；页面标题与刷新操作改由外层工作台页面提供。
 */
import { useI18n } from 'vue-i18n'

import ActivityFeed from '@/components/dashboard/ActivityFeed.vue'
import JobStatusOverview from '@/components/dashboard/JobStatusOverview.vue'
import StatsCard from '@/components/dashboard/StatsCard.vue'
import { useStatsStore } from '@/stores/stats'
import { useOperationsStore } from '@/stores/operations'
import OperationCounts from '@/components/operations/OperationCounts.vue'
import { parseOrganizationId } from '@/utils/organization-scope'
import { sessionGeneration } from '@/api/session-context'

const props = withDefaults(defineProps<{ refreshKey?: number }>(), { refreshKey: 0 })

const stats = useStatsStore()
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const operations = useOperationsStore()
watch(
  () => stats.revision,
  () => {
    void stats.loadStats()
  },
)
const orgId = computed(() => parseOrganizationId(route.query.org_id))
const refresh = async (): Promise<void> => {
  await Promise.all([stats.loadAll(), operations.ensureSummary(true)])
}

// 外层工作台页面的「刷新」按钮：用量统计接口仅在用量 Tab 激活时才会被触发
watch(
  () => props.refreshKey,
  (value, previous) => {
    if (value !== previous) void refresh()
  },
)

watch(
  [orgId, sessionGeneration],
  () => {
    stats.setActivityOrganization(orgId.value)
    void stats.loadAll()
    void operations.ensureSummary()
  },
  { immediate: true },
)

/** 清除组织范围：回到「查看全部活动」，保留当前 Tab */
const clearOrganizationScope = (): void => {
  void router.replace({ query: { ...route.query, org_id: undefined } })
}
</script>

<template>
  <div class="lf-page">
    <section class="space-y-3">
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-sm font-semibold text-lf-text-strong">
          {{ t('workbench.home.currentTasks') }}
        </h2>
        <RouterLink to="/operations" class="text-xs text-brand-600 no-underline hover:underline">{{
          t('workbench.home.operations')
        }}</RouterLink>
      </div>
      <OperationCounts
        :summary="operations.summary"
        :loading="operations.summaryLoading"
        :error="operations.summaryError"
      />
    </section>
    <h2 class="text-sm font-semibold text-lf-text-strong">{{ t('workbench.stats.usage') }}</h2>
    <NAlert v-if="stats.statsError && stats.stats" type="warning"
      >{{ t('workbench.stats.stale') }} · {{ stats.statsUpdatedAt }}</NAlert
    >

    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatsCard
        :title="t('dashboard.stats.apiCalls')"
        :value="stats.stats?.api_calls ?? 0"
        icon="carbon:api"
        tone="brand"
        :loading="stats.statsLoading"
        :error="stats.stats ? null : stats.statsError"
      />
      <StatsCard
        :title="t('dashboard.stats.inputTokens')"
        :value="stats.stats?.input_tokens ?? 0"
        icon="carbon:cloud-upload"
        tone="info"
        :loading="stats.statsLoading"
        :error="stats.stats ? null : stats.statsError"
      />
      <StatsCard
        :title="t('dashboard.stats.outputTokens')"
        :value="stats.stats?.output_tokens ?? 0"
        icon="carbon:cloud-download"
        tone="accent"
        :loading="stats.statsLoading"
        :error="stats.stats ? null : stats.statsError"
      />
      <StatsCard
        :title="t('dashboard.stats.segmentCount')"
        :value="stats.stats?.segment_count ?? 0"
        icon="carbon:chart-column"
        tone="neutral"
        :loading="stats.statsLoading"
        :error="stats.stats ? null : stats.statsError"
      />
    </div>

    <div class="grid grid-cols-1 gap-4 xl:grid-cols-5">
      <div class="xl:col-span-2">
        <JobStatusOverview />
      </div>
      <div class="xl:col-span-3">
        <div v-if="orgId" class="mb-3 flex items-center justify-between gap-3 text-sm">
          <span>{{ t('workbench.stats.organizationActivity') }} #{{ orgId }}</span
          ><NButton text @click="clearOrganizationScope">{{
            t('workbench.stats.clearScope')
          }}</NButton>
        </div>
        <ActivityFeed />
      </div>
    </div>
  </div>
</template>
