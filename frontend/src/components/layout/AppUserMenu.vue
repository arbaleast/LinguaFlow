<script setup lang="ts">
/**
 * 顶栏【用户头像菜单】入口。
 *
 * 只承载「当前账号的个人操作」：个人资料、安全设置、使用偏好、
 * 更新日志、关于，以及远程服务下的退出登录。
 *
 * 环境相关的操作（切换本地 / 远程服务）统一放在 `AppModeMenu.vue`，
 * 避免两个菜单的信息层级混在一起。
 */
import { NIcon, useMessage, type DropdownOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import IconCarbonDocument from '~icons/carbon/document'
import IconCarbonInformation from '~icons/carbon/information'
import IconCarbonLocked from '~icons/carbon/locked'
import IconCarbonLogout from '~icons/carbon/logout'
import IconCarbonSettingsAdjust from '~icons/carbon/settings-adjust'
import IconCarbonUser from '~icons/carbon/user'
import IconCarbonUserAvatar from '~icons/carbon/user-avatar'

import { buildUserOptions, topMenuProps, type MenuIconFactory } from './top-menu'
import { useAuthStore } from '@/stores/auth'
import { useServiceStore } from '@/stores/service'

defineOptions({ name: 'AppUserMenu' })

const router = useRouter()
const auth = useAuthStore()
const service = useServiceStore()
const message = useMessage()
const { t } = useI18n()

/** 是否处于「本地环境」（Go 本地进程 或 纯浏览器本地模式）。 */
const isLocalEnvironment = computed(
  () => service.mode === 'local' || service.mode === 'browser-local',
)

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

const ICONS = {
  profile: IconCarbonUser,
  security: IconCarbonLocked,
  preferences: IconCarbonSettingsAdjust,
  team: IconCarbonUserAvatar,
  changelog: IconCarbonDocument,
  about: IconCarbonInformation,
  logout: IconCarbonLogout,
} as const

const menuIcon: MenuIconFactory = (name) => {
  const component = ICONS[name as keyof typeof ICONS] ?? IconCarbonUser
  return () => h(NIcon, null, { default: () => h(component) })
}

const userOptions = computed<DropdownOption[]>(() =>
  buildUserOptions({
    isLocalEnvironment: isLocalEnvironment.value,
    labels: {
      profile: t('layout.userMenu.profile'),
      security: t('layout.userMenu.security'),
      preferences: t('layout.userMenu.preferences'),
      team: t('layout.userMenu.team'),
      changelog: t('layout.userMenu.changelog'),
      about: t('layout.userMenu.about'),
      logout: t('layout.userMenu.logout'),
    },
    menuIcon,
  }),
)

const onSelectUserAction = async (key: string | number): Promise<void> => {
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
</script>

<template>
  <NDropdown
    v-if="auth.user"
    trigger="click"
    :options="userOptions"
    :menu-props="topMenuProps"
    placement="bottom-end"
    @select="onSelectUserAction"
  >
    <button
      type="button"
      class="lf-grad-bg flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-xs font-semibold text-white"
      :aria-label="displayName"
      :title="displayName"
    >
      {{ initial }}
    </button>
  </NDropdown>
</template>
