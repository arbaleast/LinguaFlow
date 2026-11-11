<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { NButton, NIcon, type DropdownOption } from 'naive-ui'
import IconCarbonMoon from '~icons/carbon/moon'
import IconCarbonScreen from '~icons/carbon/screen'
import IconCarbonSun from '~icons/carbon/sun'

import TaskHistoryDeleteDialog from '@/components/operations/TaskHistoryDeleteDialog.vue'
import AppModeMenu from '@/components/layout/AppModeMenu.vue'
import AppNavList from '@/components/layout/AppNavList.vue'
import AppSidebar from '@/components/layout/AppSidebar.vue'
import AppUserMenu from '@/components/layout/AppUserMenu.vue'
import { useAuthStore } from '@/stores/auth'
import { useLocaleStore } from '@/stores/locale'
import { useThemeStore, type ThemeMode } from '@/stores/theme'
import { getDefaultTokenStorage } from '@/api/token-storage'
import { invalidateSessionViews } from '@/api/session-context'
import { onOrganizationInvalidated } from '@/utils/organization-scope'
import { readAppPageHeaderMeta } from '@/router/page-header'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const locale = useLocaleStore()
const theme = useThemeStore()
const { t } = useI18n()
onOrganizationInvalidated(() => {
  invalidateSessionViews()
})
watch(
  () => auth.user?.role,
  (role) => {
    if (role !== 'admin' && route.path.startsWith('/admin')) void router.replace('/')
  },
)

const SIDEBAR_STORAGE_KEY = 'linguaflow.sidebar.collapsed'

const sidebarCollapsed = ref(getDefaultTokenStorage().getItem(SIDEBAR_STORAGE_KEY) === '1')

watch(sidebarCollapsed, (collapsed) => {
  getDefaultTokenStorage().setItem(SIDEBAR_STORAGE_KEY, collapsed ? '1' : '0')
})

const localeOptions = computed<DropdownOption[]>(() =>
  locale.availableLocales.map((item) => ({
    label: t(item.labelKey),
    key: item.code,
  })),
)

const themeOptions = computed<DropdownOption[]>(() => [
  {
    label: t('theme.system'),
    key: 'system',
    icon: () => h(NIcon, null, { default: () => h(IconCarbonScreen) }),
  },
  {
    label: t('theme.light'),
    key: 'light',
    icon: () => h(NIcon, null, { default: () => h(IconCarbonSun) }),
  },
  {
    label: t('theme.dark'),
    key: 'dark',
    icon: () => h(NIcon, null, { default: () => h(IconCarbonMoon) }),
  },
])

const onSelectTheme = (key: string | number): void => {
  theme.setMode(String(key) as ThemeMode)
}

const onSelectLocale = (key: string | number): void => {
  locale.setLocale(String(key))
}

const mobileNavOpen = ref(false)

// 顶栏左侧的页面标题：仅由通过路由 meta 声明 pageHeader 的页面渲染，
// 其余页面顶栏左侧保持留白，避免与页面内自带 PageHeader 重复。
const appPageHeader = computed(() => readAppPageHeaderMeta(route.meta))
const appPageHeaderTitle = computed(() => {
  const header = appPageHeader.value
  return header ? t(header.title) : ''
})
const appPageHeaderSubtitle = computed(() => {
  const header = appPageHeader.value
  return header?.subtitle ? t(header.subtitle) : ''
})
// 沉浸式页面：页面不再渲染页内页头，主区收紧顶部内边距让内容上移
const isImmersivePage = computed(() => appPageHeader.value?.immersive === true)

// 视口跨过 lg 断点（桌面侧边栏接管导航）时自动收起移动端抽屉，避免两套导航并存
const desktopNavQuery = window.matchMedia('(min-width: 64rem)')
const onDesktopNavChange = (event: MediaQueryListEvent): void => {
  if (event.matches) {
    mobileNavOpen.value = false
  }
}
onMounted(() => desktopNavQuery.addEventListener('change', onDesktopNavChange))
onUnmounted(() => desktopNavQuery.removeEventListener('change', onDesktopNavChange))
</script>

<template>
  <div class="flex min-h-screen bg-lf-bg text-lf-text">
    <!-- 桌面侧边栏（可折叠为图标窄栏） -->
    <AppSidebar :collapsed="sidebarCollapsed" @update:collapsed="sidebarCollapsed = $event" />

    <!-- 主区 -->
    <div class="flex min-w-0 flex-1 flex-col">
      <header
        class="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-lf-border-soft bg-lf-surface px-4 sm:gap-3 sm:px-6"
      >
        <!-- lg:hidden! 用 important 覆盖 naive-ui 注入的 .n-button display（分层样式斗不过未分层样式） -->
        <NButton
          quaternary
          circle
          class="lg:hidden!"
          :aria-label="t('nav.menu')"
          :title="t('nav.menu')"
          @click="mobileNavOpen = true"
        >
          <template #icon>
            <IconCarbonMenu class="text-lg" />
          </template>
        </NButton>

        <!-- 顶栏左侧：当前页面标题（仅沉浸式页面声明时渲染）+ 单行紧凑副标题 -->
        <div v-if="appPageHeaderTitle" class="min-w-0 flex-1 overflow-hidden">
          <div class="flex min-w-0 items-baseline gap-2">
            <h1 class="truncate text-[15px] leading-5 font-semibold tracking-tight text-lf-text-strong">
              {{ appPageHeaderTitle }}
            </h1>
            <span
              v-if="appPageHeaderSubtitle"
              class="hidden min-w-0 truncate text-xs leading-5 text-lf-text-subtle md:inline"
              >{{ appPageHeaderSubtitle }}</span
            >
          </div>
        </div>
        <div v-else class="min-w-0 flex-1" />

        <div class="flex shrink-0 items-center gap-3 sm:gap-4">
          <NDropdown
            v-if="locale.hasMultipleLocales"
            trigger="click"
            :options="localeOptions"
            placement="bottom-end"
            @select="onSelectLocale"
          >
            <NButton
              quaternary
              size="small"
              :aria-label="t('common.language')"
              :title="t('common.language')"
            >
              <template #icon><IconCarbonLanguage aria-hidden="true" /></template>
              <span class="hidden sm:inline">{{ t('common.language') }}</span>
            </NButton>
          </NDropdown>
          <NDropdown
            trigger="click"
            :options="themeOptions"
            placement="bottom-end"
            @select="onSelectTheme"
          >
            <NButton quaternary circle :title="t('common.theme')" :aria-label="t('common.theme')">
              <template #icon>
                <IconCarbonScreen v-if="theme.mode === 'system'" class="text-lg" />
                <IconCarbonMoon v-else-if="theme.isDark" class="text-lg" />
                <IconCarbonSun v-else class="text-lg" />
              </template>
            </NButton>
          </NDropdown>
          <AppModeMenu />
          <GlobalJobTrackerWidget />
          <AppUserMenu />
        </div>
      </header>

      <!-- 宽度治理下放页面：普通页面根部用 .lf-content-narrow 保持居中窄栏；
           沉浸式页面（如工作台）收紧顶部内边距并纵向撑满视口剩余高度 -->
      <main
        :class="
          isImmersivePage
            ? 'flex min-h-0 flex-1 flex-col px-5 pt-4 pb-7 sm:px-8'
            : 'flex min-h-0 flex-1 flex-col px-5 py-7 sm:px-8'
        "
      >
        <NAlert v-if="auth.initializationError" type="warning" :bordered="false" class="mb-5">
          {{ auth.initializationError }}
          <NButton text class="ml-3" @click="auth.fetchCurrentUser().catch(() => undefined)">{{
            t('operations.authRetry')
          }}</NButton>
        </NAlert>
        <slot />
      </main>
    </div>

    <!-- 移动端导航抽屉（与桌面侧边栏共用同一套导航渲染） -->
    <NDrawer v-model:show="mobileNavOpen" placement="left" :width="280">
      <NDrawerContent :title="t('common.appName')" closable>
        <AppNavList variant="drawer" @navigate="mobileNavOpen = false" />
      </NDrawerContent>
    </NDrawer>

    <GlobalJobDetailDrawer />
    <TaskHistoryDeleteDialog />
  </div>
</template>
