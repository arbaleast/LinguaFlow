<script setup lang="ts">
/**
 * 实体管理页通用骨架：页头 + 指标行 + 筛选栏 + 加载/空态 + 列表内容。
 *
 * 模板/配置类管理页（提示词、执行策略、执行计划、AI 后端等）共用此骨架，
 * 各页保留自己的 store、表单与编辑器组件，仅通过 props 与插槽填充内容。
 */

interface EntityMetric {
  label: string
  value: string | number
}

withDefaults(
  defineProps<{
    title: string
    subtitle?: string
    metrics?: EntityMetric[]
    loading?: boolean
    /** 列表为空（含筛选后为空）时展示空态，否则渲染默认插槽 */
    empty?: boolean
    emptyDescription?: string
    /**
     * 是否展示页头（标题 + 副标题）。
     * 内嵌到多 Tab 页面时置为 false：页面标题由外层容器统一提供，
     * 避免外层与内层出现重复的标题/副标题堆叠（操作区仍保留）。
     */
    showHeader?: boolean
  }>(),
  {
    subtitle: '',
    metrics: () => [],
    loading: false,
    empty: false,
    emptyDescription: '',
    showHeader: true,
  },
)
</script>

<template>
  <div class="lf-page lf-content-narrow">
    <PageHeader v-if="showHeader" :title="title" :subtitle="subtitle || undefined">
      <template v-if="$slots.actions" #actions>
        <slot name="actions" />
      </template>
    </PageHeader>

    <!-- 内嵌模式：页头由外层容器提供，操作区降级为独立的一行 -->
    <div v-else-if="$slots.actions" class="flex flex-wrap items-center justify-end gap-3">
      <slot name="actions" />
    </div>

    <div
      v-if="metrics.length > 0"
      class="grid grid-cols-1 gap-4 md:grid-cols-2"
      :class="metrics.length >= 4 ? 'xl:grid-cols-4' : 'xl:grid-cols-3'"
    >
      <div v-for="metric in metrics" :key="metric.label" class="lf-metric">
        <div class="lf-metric-label">{{ metric.label }}</div>
        <div class="lf-metric-value">{{ metric.value }}</div>
      </div>
    </div>

    <div v-if="$slots.filters" class="lf-panel px-4 py-3">
      <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <slot name="filters" />
      </div>
    </div>

    <div v-if="loading" class="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
      <div v-for="index in 6" :key="index" class="lf-panel p-5">
        <NSkeleton text :repeat="4" />
      </div>
    </div>

    <NEmpty v-else-if="empty" class="lf-panel py-16" :description="emptyDescription">
      <template v-if="$slots['empty-extra']" #extra>
        <slot name="empty-extra" />
      </template>
    </NEmpty>

    <slot v-else />
  </div>
</template>
