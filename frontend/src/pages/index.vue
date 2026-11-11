<script setup lang="ts">
/**
 * 工作台：即时多语互译与外贸商务邮件拟写助手。
 *
 * 页面标题与副标题已合并至全局顶栏左侧（见 AppLayout 的 pageHeader meta 机制），
 * 页面本体即翻译核心工作面：横向铺满（不再用 lf-content-narrow 限宽），
 * 纵向撑满视口剩余高度，不再重复渲染页内页头。
 */
import WorkbenchOverviewPanel from '@/components/dashboard/WorkbenchOverviewPanel.vue'

// KeepAlive 的 include 按组件名匹配（见 App.vue），必须显式声明。
defineOptions({ name: 'WorkbenchPage' })

definePage({
  meta: {
    pageHeader: {
      title: 'workbench.home.title',
      subtitle: 'workbench.home.subtitle',
      immersive: true,
    },
  },
})
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <WorkbenchOverviewPanel />
  </div>
</template>
