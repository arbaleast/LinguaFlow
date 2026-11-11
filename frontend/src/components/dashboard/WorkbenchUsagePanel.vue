<script setup lang="ts">
/**
 * 用量统计面板（挂在「AI 后端」页面的「用量统计」Tab 下）。
 *
 * 只保留 AI 调用量监控本身：历史用量 4 项核心指标（API 调用、输入/输出 Token、
 * 任务段数）与「最近活动」列表；任务状态卡片、保留的翻译任务记录等属于
 * 「任务中心」的重复模块已移除，活动列表扩展为全宽展示。
 */
import { useI18n } from 'vue-i18n'

import ActivityFeed from '@/components/dashboard/ActivityFeed.vue'
import StatsCard from '@/components/dashboard/StatsCard.vue'
import { useStatsStore } from '@/stores/stats'
import { parseOrganizationId } from '@/utils/organization-scope'
import { sessionGeneration } from '@/api/session-context'

const props = withDefaults(defineProps<{ refreshKey?: number }>(), { refreshKey: 0 })

const stats = useStatsStore()
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
watch(
  () => stats.revision,
  () => {
    void stats.loadStats()
  },
)
const orgId = computed(() => parseOrganizationId(route.query.org_id))
const refresh = async (): Promise<void> => {
  await stats.loadAll()
}

// 外层「AI 后端」页面的「刷新」按钮：用量统计接口仅在用量 Tab 激活时才会被触发
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

    <div>
      <div v-if="orgId" class="mb-3 flex items-center justify-between gap-3 text-sm">
        <span>{{ t('workbench.stats.organizationActivity') }} #{{ orgId }}</span
        ><NButton text @click="clearOrganizationScope">{{
          t('workbench.stats.clearScope')
        }}</NButton>
      </div>
      <ActivityFeed />
    </div>
  </div>
</template>
