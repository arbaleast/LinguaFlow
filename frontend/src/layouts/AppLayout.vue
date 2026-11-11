<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { NButton, NIcon, useMessage, type DropdownOption } from 'naive-ui'
import IconCarbonMoon from '~icons/carbon/moon'
import IconCarbonScreen from '~icons/carbon/screen'
import IconCarbonSun from '~icons/carbon/sun'

import TaskHistoryDeleteDialog from '@/components/operations/TaskHistoryDeleteDialog.vue'
import AppNavList from '@/components/layout/AppNavList.vue'
import AppSidebar from '@/components/layout/AppSidebar.vue'
import { useAuthStore } from '@/stores/auth'
import { useLocaleStore } from '@/stores/locale'
import { useServiceStore } from '@/stores/service'
import { useThemeStore, type ThemeMode } from '@/stores/theme'
import { getDefaultTokenStorage } from '@/api/token-storage'
import { invalidateSessionViews } from '@/api/session-context'
import { onOrganizationInvalidated } from '@/utils/organization-scope'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const locale = useLocaleStore()
const service = useServiceStore()
const theme = useThemeStore()
const message = useMessage()
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

const displayName = computed(() => {
  if (!auth.user) {
    return ''
  }
  return auth.user.display_name?.trim() || auth.user.username
})

const initial = computed(() => {
  const name = displayName.value
  return name ? name.charAt(0).toUpperCase() : '?'
})

const serviceSummary = computed(() => {
  if (service.isLocal) {
    return t('layout.localModeBadge')
  }
  return service.displayName.trim() || service.baseUrl
})

const userOptions = computed<DropdownOption[]>(() => {
  const items: DropdownOption[] = [
    {
      key: 'user-info',
      type: 'render',
      render: () =>
        h('div', { class: 'px-3 py-2 min-w-[180px]' }, [
          h('div', { class: 'text-sm font-medium text-lf-text-strong' }, displayName.value),
          auth.user?.email
            ? h('div', { class: 'mt-0.5 text-xs text-lf-text-muted' }, auth.user.email)
            : null,
          h(
            'div',
            {
              class: 'mt-1.5 truncate text-[11px] font-mono text-lf-text-subtle',
              title: service.baseUrl,
            },
            serviceSummary.value,
          ),
        ]),
    },
    { type: 'divider', key: 'divider-1' },
    { label: t('layout.userMenu.profile'), key: 'profile' },
    { label: t('layout.userMenu.security'), key: 'security' },
    { label: t('workbench.settings.preferences'), key: 'preferences' },
    ...(!service.isLocal ? [{ label: t('workbench.settings.team'), key: 'team' }] : []),
    { type: 'divider', key: 'divider-2' },
    { label: t('nav.changelog'), key: 'changelog' },
    { label: t('nav.about'), key: 'about' },
    { type: 'divider', key: 'divider-3' },
  ]

  if (service.isLocal) {
    items.push({ label: t('layout.userMenu.connectRemoteService'), key: 'switch-service' })
  } else {
    items.push(
      { label: t('layout.userMenu.switchService'), key: 'switch-service' },
      { label: t('layout.userMenu.logout'), key: 'logout' },
    )
  }

  return items
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

const onSelectUserAction = async (key: string | number) => {
  if (key === 'logout') {
    try {
      await auth.logout()
      message.success(t('layout.messages.logoutSuccess'))
      await router.push({ path: '/login' })
    } catch (error) {
      console.error(error)
      message.warning(t('operations.logoutUnconfirmed'))
      await router.push({ path: '/login' })
    }
  } else if (key === 'switch-service') {
    const query = service.isLocal ? { force: '1' } : {}
    await router.push({ path: '/service', query })
  } else if (key === 'changelog') {
    await router.push({ path: '/changelog' })
  } else if (key === 'about') {
    await router.push({ path: '/about' })
  } else if (key === 'profile') {
    await router.push({ path: '/settings/profile' })
  } else if (key === 'security') {
    await router.push({ path: '/settings/security' })
  } else if (key === 'preferences') {
    await router.push({ path: '/settings/preferences' })
  } else if (key === 'team') {
    await router.push({ path: '/settings/team' })
  }
}

const onSelectTheme = (key: string | number): void => {
  theme.setMode(String(key) as ThemeMode)
}

const onSelectLocale = (key: string | number): void => {
  locale.setLocale(String(key))
}

const mobileNavOpen = ref(false)

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

        <div class="min-w-0 flex-1 overflow-hidden" />

        <div class="flex shrink-0 items-center gap-2 sm:gap-3">
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
          <span
            v-if="service.isLocal"
            class="flex shrink-0 items-center text-lf-success"
            :title="t('layout.localModeBadge')"
            :aria-label="t('layout.localModeBadge')"
            role="img"
          >
            <IconCarbonLaptop class="text-lg sm:hidden" aria-hidden="true" />
            <span class="hidden sm:inline-flex"
              ><NTag size="small" type="success" :bordered="false">{{
                t('layout.localModeBadge')
              }}</NTag></span
            >
          </span>
          <GlobalJobTrackerWidget />
          <NDropdown
            v-if="auth.user"
            trigger="click"
            :options="userOptions"
            placement="bottom-end"
            @select="onSelectUserAction"
          >
            <button
              type="button"
              class="lf-grad-bg flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-xs font-semibold text-white"
              :aria-label="displayName"
            >
              {{ initial }}
            </button>
          </NDropdown>
        </div>
      </header>

      <!-- 宽度治理下放页面：普通页面根部用 .lf-content-narrow 保持居中窄栏；
           需要全宽的页面（如项目工作台）自行铺满 -->
      <main class="flex-1 px-5 py-7 sm:px-8">
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
