<script setup lang="ts">
/**
 * 工作台「概览」面板：纯粹的翻译核心工作面。
 *
 * 只保留「外贸邮件与翻译助手」双栏工作面；最近打开项目与任务恢复三栏
 * 已迁移至「项目」页面（/projects?tab=recent），不再在此重复展示。
 * 页面高度由外层沉浸式布局供给：面板纵向撑满视口剩余高度。
 */
import WorkbenchMailAssistant from '@/components/dashboard/WorkbenchMailAssistant.vue'
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <WorkbenchMailAssistant class="min-h-0 flex-1" />
  </div>
</template>
