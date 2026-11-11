<script setup lang="ts" generic="T extends string">
/**
 * 通用分区 Tab：标签条 + 按需挂载的面板宿主。
 *
 * - 标签条只渲染导航（NTab 不带面板内容），面板由下方 `<KeepAlive>` 承载；
 * - 同一时刻只挂载当前 Tab 的面板组件，避免多个子视图首屏同时请求；
 * - `<KeepAlive>` 缓存已访问过的面板，切回时保留未保存的表单、搜索条件与分页位置。
 */
import { NTab, NTabs } from 'naive-ui'

import type { SectionTabItem } from './section-tabs'

const props = withDefaults(
  defineProps<{
    /** Tab 列表（key 与路由 Query 取值一致） */
    tabs: SectionTabItem<T>[]
    /** 当前激活的 Tab */
    modelValue: T
    /** 透传给当前面板组件的额外属性（如刷新信号） */
    panelProps?: Record<string, unknown>
    /** 紧凑模式：缩小标签条上下留白，用于首屏高度敏感的页面 */
    compact?: boolean
  }>(),
  { panelProps: () => ({}), compact: false },
)

const emit = defineEmits<{
  'update:modelValue': [value: T]
}>()

/** 当前 Tab 对应的面板组件；非法值回退到首个 Tab */
const activePanel = computed(
  () => props.tabs.find((tab) => tab.key === props.modelValue)?.panel ?? props.tabs[0]?.panel,
)
</script>

<template>
  <div :class="compact ? 'space-y-2' : 'space-y-5'">
    <NTabs
      type="line"
      :size="compact ? 'small' : 'medium'"
      :class="compact ? 'lf-section-tabs--compact' : undefined"
      :value="modelValue"
      @update:value="(value: string | number) => emit('update:modelValue', value as T)"
    >
      <NTab v-for="tab in tabs" :key="tab.key" :name="tab.key" :tab="tab.label" />
    </NTabs>

    <KeepAlive>
      <component :is="activePanel" :key="modelValue" v-bind="panelProps" />
    </KeepAlive>
  </div>
</template>

<style scoped>
/* naive-ui 的标签内边距来自未分层的运行时样式，reduced size 下再收紧 2px 上下留白 */
.lf-section-tabs--compact :deep(.n-tabs-tab) {
  padding-top: 4px;
  padding-bottom: 4px;
}
</style>
