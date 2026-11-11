<script setup lang="ts">
/**
 * 「词库与项目」列表面板。
 *
 * - 卡片突出词库定位：名称、背景摘要、术语启用状态，并提供
 *   [在工作台使用] / [管理术语] 快捷按钮（编辑/删除保留）；
 * - 「最近使用」以轻量 Chip 条呈现（来自浏览器本地访问偏好，无记录自动隐藏）；
 * - 刷新 / 新建按钮并入筛选搜索栏右侧，保持单行紧凑布局。
 */
import { NButton, NInput, NModal, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'

import { type ApiSchemas } from '@/api/client'
import ProjectFormDrawer from '@/components/projects/ProjectFormDrawer.vue'
import ScopeFilterTabs from '@/components/common/ScopeFilterTabs.vue'
import { useStoreErrorToast } from '@/composables/useStoreErrorToast'
import { useProjectsStore, type GlossaryFilter } from '@/stores/projects'
import { usePreferencesStore } from '@/stores/preferences'
import { formatDateTime } from '@/utils/datetime'
import { useOrganizationScope } from '@/composables/useOrganizationScope'
import OrganizationScopeSelect from '@/components/organizations/OrganizationScopeSelect.vue'
import { onOrganizationInvalidated } from '@/utils/organization-scope'
import { captureSession, isSessionCurrent } from '@/api/session-context'

type Project = ApiSchemas['Project']

const route = useRoute()
const router = useRouter()
const projects = useProjectsStore()
const preferences = usePreferencesStore()
const { orgId, canWrite, setScope } = useOrganizationScope((id) => {
  projects.setOrganization(id)
  void projects.loadProjects(id)
})
const message = useMessage()
const { t } = useI18n()

const formDrawerVisible = ref(false)
const editingProject = ref<Project | null>(null)
const deleteConfirmVisible = ref(false)
const deletingProject = ref<Project | null>(null)

/** 卡片摘要：背景说明单行截断；无背景时显示语言对摘要 */
const cardSummary = (project: Project): string => {
  const background = project.config?.background
  if (typeof background === 'string' && background.trim()) {
    return background.trim().replace(/\s+/g, ' ')
  }
  return t('projects.card.noBackground', {
    source: project.source_lang || 'auto',
    target: project.target_lang,
  })
}

/** 最近使用（浏览器本地偏好，仅保留当前仍可见的项目，最多 5 个） */
const recentProjects = computed(() =>
  preferences.recentProjects
    .flatMap((visit) => {
      const project = projects.items.find((item) => item.id === visit.project_id)
      return project ? [{ project, lastOpenedAt: visit.last_opened_at }] : []
    })
    .slice(0, 5),
)

const hasActiveFilters = computed(
  () => projects.searchQuery.trim().length > 0 || projects.glossaryFilter !== 'all',
)

const filterTabs = computed(() => [
  { name: 'all', label: t('projects.filters.all'), count: projects.totalCount },
  {
    name: 'enabled',
    label: t('projects.filters.glossaryEnabled'),
    count: projects.glossaryEnabledCount,
  },
  {
    name: 'disabled',
    label: t('projects.filters.glossaryDisabled'),
    count: projects.glossaryDisabledCount,
  },
])

const cardDate = (project: Project): string => {
  const value = project.updated_at ?? project.created_at
  return value ? formatDateTime(value, { dateStyle: 'short' }) : '—'
}

const cardDateTitle = (project: Project): string => {
  const value = project.updated_at ?? project.created_at
  return value ? formatDateTime(value, { dateStyle: 'medium', timeStyle: 'short' }) : ''
}

const openCreateDrawer = (): void => {
  editingProject.value = null
  formDrawerVisible.value = true
}

const openEditDrawer = (project: Project): void => {
  if (!projects.canEdit(project)) return
  editingProject.value = project
  formDrawerVisible.value = true
}

const openProjectWorkspace = (project: Project): void => {
  void router.push(`/projects/${project.id}`)
}

/** 工作台使用：深链挂载该词库 */
const useInWorkbench = (project: Project): void => {
  void router.push({ path: '/', query: { project: String(project.id) } })
}

/** 管理术语：直达详情页术语词库 Tab */
const openGlossary = (project: Project): void => {
  void router.push({ path: `/projects/${project.id}`, query: { tab: 'glossary' } })
}

const openDeleteConfirm = (project: Project): void => {
  if (!projects.canDelete(project)) return
  deletingProject.value = project
  deleteConfirmVisible.value = true
}

const closeDeleteConfirm = (): void => {
  deleteConfirmVisible.value = false
  deletingProject.value = null
}

const confirmDelete = async (): Promise<void> => {
  if (!deletingProject.value) return
  const session = captureSession()
  try {
    await projects.deleteProject(deletingProject.value.id)
    message.success(t('projects.messages.deleteSuccess'))
    closeDeleteConfirm()
  } catch (error) {
    if (!isSessionCurrent(session) || (error instanceof Error && error.name === 'AbortError'))
      return
    console.error(error)
    message.error(projects.deleteError || t('projects.messages.deleteFailed'))
  }
}

onMounted(() => {
  projects.loadProjects(orgId.value)

  if (route.query.create === '1') {
    openCreateDrawer()
  }
})

useStoreErrorToast(
  () => projects.error,
  () => {
    projects.error = null
  },
)
watch(orgId, () => {
  formDrawerVisible.value = false
  deleteConfirmVisible.value = false
})
onOrganizationInvalidated((id) => {
  if (id === orgId.value || id === editingProject.value?.owner_org_id) {
    formDrawerVisible.value = false
    deleteConfirmVisible.value = false
    editingProject.value = null
  }
})
</script>

<template>
  <EntityListPage
    :title="t('projects.title')"
    :subtitle="t('projects.subtitle')"
    :show-header="false"
    :loading="projects.loading"
    :empty="projects.filteredItems.length === 0"
    :empty-description="
      hasActiveFilters ? t('projects.empty.filtered') : t('projects.empty.default')
    "
  >
    <template #actions />

    <template #filters>
      <OrganizationScopeSelect :value="orgId" @update:value="setScope" />
      <ScopeFilterTabs
        :tabs="filterTabs"
        :value="projects.glossaryFilter"
        @update:value="(value: string) => projects.setGlossaryFilter(value as GlossaryFilter)"
      />
      <NInput
        v-model:value="projects.searchQuery"
        clearable
        class="lg:max-w-sm!"
        :placeholder="t('projects.filters.searchPlaceholder')"
      />
      <div class="ml-auto flex items-center gap-2">
        <NButton secondary :loading="projects.loading" @click="projects.loadProjects(orgId)">
          {{ t('common.actions.refresh') }}
        </NButton>
        <NButton v-if="canWrite" type="primary" @click="openCreateDrawer">
          {{ t('projects.actions.create') }}
        </NButton>
      </div>
    </template>

    <!-- 最近使用：轻量 Chip 条（本地偏好，无记录自动隐藏） -->
    <div v-if="recentProjects.length" class="flex flex-wrap items-center gap-2">
      <span class="shrink-0 text-xs text-lf-text-subtle">
        {{ t('projects.recentChips.label') }}
      </span>
      <button
        v-for="{ project, lastOpenedAt } in recentProjects"
        :key="project.id"
        type="button"
        class="flex max-w-56 items-center gap-1.5 rounded-full border border-lf-border-soft bg-lf-surface-muted px-2.5 py-1 text-xs font-medium text-lf-text-muted transition-colors hover:border-brand-400 hover:text-brand-600"
        :title="formatDateTime(lastOpenedAt, { dateStyle: 'medium', timeStyle: 'short' })"
        @click="openProjectWorkspace(project)"
      >
        <IconCarbonDataBlob class="h-3.5 w-3.5 shrink-0 text-brand-500" aria-hidden="true" />
        <span class="truncate">{{ project.name }}</span>
      </button>
    </div>

    <template #empty-extra>
      <NButton v-if="hasActiveFilters" secondary @click="projects.resetFilters">
        {{ t('projects.filters.reset') }}
      </NButton>
      <NButton v-else-if="canWrite" type="primary" @click="openCreateDrawer">
        {{ t('projects.actions.createFirst') }}
      </NButton>
    </template>

    <!-- 卡片网格 -->
    <div class="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
      <div
        v-for="project in projects.filteredItems"
        :key="project.id"
        class="lf-interactive-card relative flex h-full cursor-pointer flex-col gap-4 overflow-hidden p-5"
        :class="{ 'pointer-events-none opacity-60': projects.isDeletingProject(project.id) }"
        @click="openProjectWorkspace(project)"
      >
        <!-- 头部：名称 + 编号 + 术语表状态标签 -->
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <h2
              class="truncate text-lg font-semibold tracking-tight text-lf-text-strong"
              :title="project.name"
            >
              {{ project.name }}
            </h2>
            <p class="mt-1 font-mono text-xs text-lf-text-subtle">#{{ project.id }}</p>
          </div>
          <NTag
            round
            size="small"
            :bordered="false"
            :type="project.glossary_enabled ? 'success' : 'default'"
            class="shrink-0"
          >
            {{
              project.glossary_enabled
                ? t('projects.form.glossaryEnabled')
                : t('projects.form.glossaryDisabled')
            }}
          </NTag>
        </div>

        <!-- 背景摘要（客户/产品背景，词库定位核心信息） -->
        <p
          class="line-clamp-2 min-h-8 text-xs leading-4 text-lf-text-muted"
          :title="cardSummary(project)"
        >
          {{ cardSummary(project) }}
        </p>

        <!-- 语言方向 -->
        <div class="flex items-center gap-2 rounded-lf-ctl bg-lf-surface-muted px-3 py-2.5 text-sm">
          <IconCarbonLanguage class="h-4 w-4 shrink-0 text-brand-500" />
          <span class="truncate font-medium text-lf-text-strong">
            {{ project.source_lang || 'auto' }}
          </span>
          <span class="text-lf-text-subtle">→</span>
          <span class="truncate font-medium text-lf-text-strong">
            {{ project.target_lang }}
          </span>
        </div>

        <!-- 底部：更新时间 + 操作 -->
        <div class="mt-auto border-t border-lf-border-soft pt-4">
          <div class="flex items-center justify-between gap-3">
            <span class="text-xs text-lf-text-subtle" :title="cardDateTitle(project)">
              {{ t('projects.card.updatedAt') }} {{ cardDate(project) }}
            </span>
            <div class="flex items-center gap-1" @click.stop>
              <NButton size="tiny" secondary type="primary" @click="useInWorkbench(project)">
                <template #icon>
                  <NIcon size="13"><IconCarbonChat /></NIcon>
                </template>
                {{ t('projects.card.useInWorkbench') }}
              </NButton>
              <NButton size="tiny" secondary @click="openGlossary(project)">
                {{ t('projects.card.manageGlossary') }}
              </NButton>
              <NButton
                v-if="projects.canEdit(project)"
                text
                type="primary"
                size="tiny"
                @click="openEditDrawer(project)"
              >
                {{ t('common.actions.edit') }}
              </NButton>
              <NButton
                v-if="projects.canEdit(project)"
                text
                type="error"
                size="tiny"
                @click="openDeleteConfirm(project)"
              >
                {{ t('common.actions.delete') }}
              </NButton>
            </div>
          </div>
        </div>

        <NSpin
          v-if="projects.isDeletingProject(project.id)"
          :show="true"
          class="absolute inset-0 flex items-center justify-center bg-lf-surface/80"
          size="medium"
        />
      </div>
    </div>
  </EntityListPage>

  <!-- 新建/编辑项目抽屉 -->
  <ProjectFormDrawer v-model:show="formDrawerVisible" :project="editingProject" :org-id="orgId" />

  <!-- 删除确认弹窗 -->
  <NModal
    v-model:show="deleteConfirmVisible"
    preset="dialog"
    type="warning"
    :title="t('common.actions.confirmDelete')"
    :content="t('projects.delete.confirm', { name: deletingProject?.name ?? '' })"
    :positive-text="t('common.actions.deleteConfirmAction')"
    :negative-text="t('common.cancel')"
    :loading="projects.deletingProjectIds.length > 0"
    @positive-click="confirmDelete"
    @negative-click="closeDeleteConfirm"
  />
</template>
