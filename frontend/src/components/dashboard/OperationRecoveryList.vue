<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { isSupportedOperation, type Operation } from '@/api/operations'
import { formatRelativeTime } from '@/utils/datetime'

import type { OperationBadge, OperationBadgeTone } from './operation-badges'

const props = withDefaults(
  defineProps<{
    title: string
    items: Operation[]
    loading: boolean
    error: string | null
    emptyText: string
    query: Record<string, string>
    /** 标题栏状态胶囊；为空时不占用额外空间 */
    badges?: OperationBadge[]
  }>(),
  { badges: () => [] },
)
const { t } = useI18n()

const badgeToneClasses: Record<OperationBadgeTone, string> = {
  info: 'bg-lf-accent-sky-soft text-lf-accent-sky',
  warning: 'bg-lf-warning-soft text-lf-warning',
  danger: 'bg-lf-danger-soft text-lf-danger',
  neutral: 'bg-lf-surface-muted text-lf-text-subtle',
}
const badgeAriaLabel = (badge: OperationBadge): string =>
  badge.label ? `${badge.label} ${badge.count}` : `${props.title} ${badge.count}`
const taskLink = (task: Operation) => ({
  path: '/operations',
  query: {
    task_type: task.task_type,
    task_id: task.task_id,
    ...(task.task_type === 'glossary_sync' || task.task_type === 'storage'
      ? { project_id: String(task.project_id) }
      : {}),
  },
})
const tones = {
  pending: 'default',
  running: 'info',
  pausing: 'warning',
  paused: 'warning',
  waiting_retry: 'warning',
  needs_action: 'warning',
  completed: 'success',
  failed: 'error',
  cancelled: 'default',
} as const
</script>
<template>
  <section class="lf-panel h-full p-4">
    <div class="mb-3 flex items-center justify-between gap-3">
      <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h2 class="truncate text-sm font-semibold text-lf-text-strong">{{ title }}</h2>
        <span
          v-for="badge in badges"
          :key="badge.key"
          class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs leading-4 font-medium"
          :class="badgeToneClasses[badge.tone]"
          role="img"
          :aria-label="badgeAriaLabel(badge)"
          :title="badgeAriaLabel(badge)"
        >
          <span v-if="badge.label">{{ badge.label }}</span>
          <span class="tabular-nums">{{ badge.count }}</span>
        </span>
      </div>
      <RouterLink
        :to="{ path: '/operations', query }"
        class="shrink-0 text-xs text-brand-600 no-underline hover:underline"
        >{{ t('workbench.home.viewAll') }}</RouterLink
      >
    </div>
    <div v-if="loading && !items.length" class="space-y-3">
      <NSkeleton v-for="n in 3" :key="n" height="42px" />
    </div>
    <NAlert
      v-if="error"
      type="warning"
      class="mb-3"
      :title="items.length ? t('workbench.home.refreshFailed') : undefined"
      >{{ error }}</NAlert
    >
    <NEmpty
      v-if="!loading && !error && !items.length"
      :description="emptyText"
      size="small"
      class="py-1.5"
    >
      <template #icon>
        <IconCarbonTask class="text-lg text-lf-text-subtle/70" aria-hidden="true" />
      </template>
    </NEmpty>
    <ul v-if="items.length" class="divide-y divide-lf-border-soft">
      <li v-for="task in items" :key="`${task.task_type}:${task.task_id}`">
        <RouterLink
          :to="taskLink(task)"
          class="flex items-center justify-between gap-3 rounded-lg py-2.5 text-lf-text no-underline hover:bg-lf-surface focus-visible:outline-2 focus-visible:outline-brand-500"
        >
          <div class="min-w-0">
            <p class="truncate text-sm font-medium text-lf-text-strong">
              {{ isSupportedOperation(task) ? task.project_name : '' }}
            </p>
            <p class="mt-1 truncate text-xs text-lf-text-muted">
              {{ t(`workbench.home.${task.task_type}`) }} ·
              {{ t('workbench.home.task', { id: task.task_id }) }}
            </p>
            <time :datetime="task.updated_at" class="mt-1 block text-xs text-lf-text-subtle">{{
              formatRelativeTime(task.updated_at)
            }}</time>
          </div>
          <NTag :type="tones[task.status]" size="small" :bordered="false" class="shrink-0">{{
            t(`workbench.home.statuses.${task.status}`)
          }}</NTag>
        </RouterLink>
      </li>
    </ul>
  </section>
</template>
