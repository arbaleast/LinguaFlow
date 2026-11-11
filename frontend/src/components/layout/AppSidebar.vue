<script setup lang="ts">
import { NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'

import AppLogo from '@/components/AppLogo.vue'
import AppNavList from '@/components/layout/AppNavList.vue'

/**
 * 桌面端左侧边栏（可折叠为图标窄栏）：
 * - 分类标题 12px / SemiBold / 中性灰，区块之间以 mt-6 mb-2 拉开层级
 * - 选中项：半透明品牌底色 + 左侧 3px 品牌色竖条 + 图标文字同步高亮
 * - 悬浮项：轻量灰底过渡；折叠后隐藏标题与文字，仅保留图标 + Tooltip
 * - 底部常驻区只保留折叠控制，避免控制类文字分散在导航中
 */
defineOptions({ name: 'AppSidebar' })

defineProps<{
  /** 是否处于折叠（图标窄栏）状态 */
  collapsed: boolean
}>()

const emit = defineEmits<{
  'update:collapsed': [value: boolean]
}>()

const { t } = useI18n()
</script>

<template>
  <aside
    class="sticky top-0 hidden h-screen shrink-0 flex-col border-r border-lf-border-soft bg-lf-surface py-3.5 transition-[width] duration-200 lg:flex"
    :class="collapsed ? 'w-[60px] px-2' : 'w-[232px] px-3'"
  >
    <RouterLink
      to="/"
      class="mb-4 flex items-center rounded-lf-ctl no-underline transition-colors hover:bg-lf-surface-muted"
      :class="collapsed ? 'justify-center' : 'px-2'"
      :aria-label="t('common.appName')"
    >
      <AppLogo size="md" :wordmark="!collapsed" />
    </RouterLink>

    <AppNavList :collapsed="collapsed" />

    <!-- 底部常驻区：折叠控制固定收纳于此 -->
    <div class="mt-3 shrink-0 border-t border-lf-border-soft pt-3">
      <NTooltip trigger="hover" placement="right" :disabled="!collapsed">
        <template #trigger>
          <button
            type="button"
            class="flex h-9 w-full items-center gap-3 rounded-lf-ctl px-3 text-sm font-medium text-lf-text-subtle transition-colors duration-150 hover:bg-lf-surface-muted hover:text-lf-text"
            :class="collapsed ? 'justify-center px-0' : ''"
            :aria-label="collapsed ? t('layout.sidebar.expand') : t('layout.sidebar.collapse')"
            @click="emit('update:collapsed', !collapsed)"
          >
            <IconCarbonChevronLeft
              class="h-5 w-5 shrink-0 transition-transform duration-200"
              :class="collapsed ? 'rotate-180' : ''"
              aria-hidden="true"
            />
            <span v-if="!collapsed" class="min-w-0 truncate">{{
              t('layout.sidebar.collapse')
            }}</span>
          </button>
        </template>
        <span class="block max-w-xs truncate">{{
          collapsed ? t('layout.sidebar.expand') : t('layout.sidebar.collapse')
        }}</span>
      </NTooltip>
    </div>
  </aside>
</template>
