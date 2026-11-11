<script setup lang="ts">
/**
 * 词库与项目（列表页）。
 *
 * - 页面标题合入 AppLayout 顶栏左侧（route meta.pageHeader），页内不再重复大标题；
 * - 「最近使用」收编为列表上方的轻量横向 Chip 条（无记录自动隐藏，不再单独占一个 Tab）；
 * - 刷新 / 新建词库按钮并入 ProjectsListPanel 的筛选搜索栏最右侧；
 * - 进入 /projects/[projectId] 时由子路由视图接管。
 */
import ProjectsListPanel from '@/components/projects/ProjectsListPanel.vue'

definePage({
  meta: {
    pageHeader: {
      title: 'nav.projects',
      subtitle: 'projects.subtitle',
    },
  },
})

const route = useRoute()
const router = useRouter()

const isProjectListRoute = computed(() => route.path === '/projects')

// 旧 Tab 链接兼容：?tab=recent|list 已取消分层，直接归位到列表页
watch(
  () => route.query.tab,
  (tab) => {
    if (route.path === '/projects' && (tab === 'recent' || tab === 'list')) {
      void router.replace({ path: '/projects', query: { ...route.query, tab: undefined } })
    }
  },
  { immediate: true },
)
</script>

<template>
  <RouterView v-if="!isProjectListRoute" />
  <ProjectsListPanel v-else />
</template>
