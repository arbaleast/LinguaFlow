<script setup lang="ts">
/**
 * 工作台「概览」面板。
 *
 * 由原工作台首页迁移而来：外贸邮件与翻译助手、最近打开项目与任务恢复列表保留；
 * 任务中心已完整展示的七宫格统计不再重复，关键状态计数下沉为恢复卡片的标题胶囊。
 * 页面标题与「刷新 / 新建项目」快捷操作改由外层工作台页面提供。
 */
import { useI18n } from 'vue-i18n'

import WorkbenchMailAssistant from '@/components/dashboard/WorkbenchMailAssistant.vue'
import OperationRecoveryList from '@/components/dashboard/OperationRecoveryList.vue'
import type { OperationBadge } from '@/components/dashboard/operation-badges'
import { type ApiSchemas, fetchProjects } from '@/api/client'
import type { Operation, OperationsQuery } from '@/api/operations'
import {
  captureSession,
  getSessionScope,
  isSessionCurrent,
  sessionGeneration,
} from '@/api/session-context'
import { isAccessDenied } from '@/api/utils'
import { usePreferencesStore } from '@/stores/preferences'
import { useOperationsStore } from '@/stores/operations'
import { formatRelativeTime } from '@/utils/datetime'
import { extractErrorMessage } from '@/utils/errors'

const props = withDefaults(defineProps<{ refreshKey?: number }>(), { refreshKey: 0 })

const { t } = useI18n()
const preferences = usePreferencesStore()
const operations = useOperationsStore()
const projects = shallowRef<ApiSchemas['Project'][]>([])
const projectsLoading = ref(false)
const projectsError = ref<string | null>(null)
const recent = reactive({ items: [] as Operation[], loading: false, error: null as string | null })
const paused = reactive({ items: [] as Operation[], loading: false, error: null as string | null })
const failed = reactive({ items: [] as Operation[], loading: false, error: null as string | null })
const recentProjects = computed(() =>
  preferences.recentProjects
    .flatMap((visit) => {
      const project = projects.value.find((item) => item.id === visit.project_id)
      return project ? [{ ...project, last_opened_at: visit.last_opened_at }] : []
    })
    .slice(0, 5),
)
const failedWindow = shallowRef<{ updated_from: string; updated_before: string } | null>(null)
const failedQuery = computed(() => ({ status: 'failed', ...failedWindow.value }))

/** 任务中心已展示完整七宫格，概览只把关键计数下沉为卡片标题胶囊。 */
const totals = computed(() => operations.summary?.total ?? null)
const recentBadges = computed<OperationBadge[]>(() => {
  const total = totals.value
  if (!total) return []
  const badges: OperationBadge[] = []
  if (total.running > 0)
    badges.push({
      key: 'running',
      label: t('workbench.home.statuses.running'),
      count: total.running,
      tone: 'info',
    })
  if (total.pending > 0)
    badges.push({
      key: 'pending',
      label: t('workbench.home.statuses.pending'),
      count: total.pending,
      tone: 'neutral',
    })
  return badges
})
const pausedBadges = computed<OperationBadge[]>(() => {
  const total = totals.value
  if (!total) return []
  const count = total.paused
  return [{ key: 'paused', count, tone: count > 0 ? 'warning' : 'neutral' }]
})
const failedBadges = computed<OperationBadge[]>(() => {
  const total = totals.value
  if (!total) return []
  const count = total.recent_failed
  return [{ key: 'recent_failed', count, tone: count > 0 ? 'danger' : 'neutral' }]
})
let epoch = 0
let mounted = true
let inFlight: Promise<void> | null = null
let queuedRefresh = false

const refresh = (force = false): Promise<void> => {
  if (inFlight) {
    if (force && !queuedRefresh) {
      queuedRefresh = true
      void inFlight.then(() => {
        queuedRefresh = false
        return refresh(true)
      })
    }
    return inFlight
  }
  if (!mounted || !getSessionScope()) return Promise.resolve()
  const snapshot = captureSession()
  const requestEpoch = epoch
  const current = () => mounted && requestEpoch === epoch && isSessionCurrent(snapshot)
  const readTasks = async (state: typeof recent, query: OperationsQuery): Promise<void> => {
    state.loading = true
    state.error = null
    try {
      const result = await operations.queryOperations(query, force)
      if (current()) state.items = result.items
    } catch (error) {
      if (!current()) return
      if (isAccessDenied(error)) state.items = []
      state.error = extractErrorMessage(error, t('workbench.home.loadFailed'))
    } finally {
      if (current()) state.loading = false
    }
  }
  const readProjects = async (): Promise<void> => {
    projectsLoading.value = true
    projectsError.value = null
    try {
      const response = await fetchProjects()
      if (!current()) return
      projects.value = response.items
      preferences.pruneRecentProjects(response.items.map((item) => item.id))
    } catch (error) {
      if (!current()) return
      if (isAccessDenied(error)) projects.value = []
      projectsError.value = extractErrorMessage(error, t('workbench.home.loadFailed'))
    } finally {
      if (current()) projectsLoading.value = false
    }
  }
  const readFailed = async (): Promise<void> => {
    failed.loading = true
    failed.error = null
    const summary = await operations.ensureSummary(force)
    if (!current()) return
    if (!summary) {
      failed.loading = false
      failed.error = operations.summaryError ?? t('workbench.home.loadFailed')
      return
    }
    await readTasks(failed, {
      status: 'failed',
      updated_from: summary.recent_failed_since,
      updated_before: summary.as_of,
      limit: 3,
    })
    if (current() && !failed.error)
      failedWindow.value = {
        updated_from: summary.recent_failed_since,
        updated_before: summary.as_of,
      }
  }
  const request = Promise.all([
    readProjects(),
    readTasks(recent, { state: 'all', limit: 5 }),
    readTasks(paused, { task_type: 'translation', status: 'paused', limit: 3 }),
    readFailed(),
  ]).then(() => {})
  inFlight = request
  void request.finally(() => {
    if (inFlight === request) inFlight = null
  })
  return request
}
watch(
  sessionGeneration,
  () => {
    epoch++
    inFlight = null
    projects.value = []
    failedWindow.value = null
    projectsError.value = null
    projectsLoading.value = false
    for (const state of [recent, paused, failed])
      Object.assign(state, { items: [], loading: false, error: null })
    void nextTick(() => refresh())
  },
  { flush: 'sync' },
)
watch(
  () => operations.revision,
  () => {
    void refresh(true)
  },
)
// 外层工作台页面的「刷新」按钮：仅在概览 Tab 激活时生效（面板被 KeepAlive 停用时不会触发请求）
watch(
  () => props.refreshKey,
  (value, previous) => {
    if (value !== previous) void refresh(true)
  },
)
const visible = (): void => {
  if (document.visibilityState === 'visible') void refresh()
}
onMounted(() => {
  void refresh()
  document.addEventListener('visibilitychange', visible)
})
onBeforeUnmount(() => {
  mounted = false
  epoch++
  document.removeEventListener('visibilitychange', visible)
})
</script>

<template>
  <div class="space-y-4">
    <WorkbenchMailAssistant />
    <section class="lf-panel p-4">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-sm font-semibold text-lf-text-strong">
          {{ t('workbench.home.recentProjects') }}
        </h2>
        <span class="text-xs text-lf-text-muted">{{ t('workbench.home.recentProjectsHint') }}</span>
      </div>
      <NSkeleton v-if="projectsLoading && !projects.length" height="64px" />
      <NAlert
        v-if="projectsError"
        type="warning"
        class="mb-3"
        :title="projects.length ? t('workbench.home.refreshFailed') : undefined"
        >{{ projectsError }}</NAlert
      >
      <NEmpty
        v-if="!projectsLoading && !projectsError && !recentProjects.length"
        :description="t('workbench.home.noProjects')"
        size="small"
        class="py-1"
      >
        <template #icon>
          <IconCarbonFolder class="text-lg text-lf-text-subtle/70" aria-hidden="true" />
        </template>
      </NEmpty>
      <div v-if="recentProjects.length" class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <RouterLink
          v-for="project in recentProjects"
          :key="project.id"
          :to="`/projects/${project.id}`"
          class="min-w-0 rounded-lg border border-lf-border-soft p-4 text-lf-text no-underline hover:border-brand-500"
        >
          <p class="truncate text-sm font-medium">{{ project.name }}</p>
          <p class="mt-2 text-xs text-lf-text-muted">
            {{ project.source_lang }} → {{ project.target_lang }}
          </p>
          <time :datetime="project.last_opened_at" class="mt-1 block text-xs text-lf-text-subtle">{{
            formatRelativeTime(project.last_opened_at)
          }}</time>
        </RouterLink>
      </div>
    </section>
    <div class="grid gap-3 lg:grid-cols-3">
      <OperationRecoveryList
        :title="t('workbench.home.recentTasks')"
        v-bind="recent"
        :badges="recentBadges"
        :empty-text="t('workbench.home.noTasks')"
        :query="{ state: 'all' }"
      />
      <OperationRecoveryList
        :title="t('workbench.home.pausedTasks')"
        v-bind="paused"
        :badges="pausedBadges"
        :empty-text="t('workbench.home.noPaused')"
        :query="{ task_type: 'translation', status: 'paused' }"
      />
      <OperationRecoveryList
        :title="t('workbench.home.failedTasks')"
        v-bind="failed"
        :badges="failedBadges"
        :empty-text="t('workbench.home.noFailed')"
        :query="failedQuery"
      />
    </div>
  </div>
</template>
