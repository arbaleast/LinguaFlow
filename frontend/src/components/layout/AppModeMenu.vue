<script setup lang="ts">
/**
 * 顶栏【环境模式切换】入口。
 *
 * 只承载「当前运行在哪个环境」与「切换到别的环境」两件事，
 * 不掺杂任何用户个人设置——个人设置见 `AppUserMenu.vue`。
 *
 * 环境含义：
 *
 * - `local`：连接本机 Go 进程；
 * - `browser-local`：纯浏览器本地运行（无后端进程）；
 * - `server`：连接远程服务端。
 */
import { NButton, NIcon, type DropdownOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import IconCarbonCheckmark from '~icons/carbon/checkmark'
import IconCarbonCloud from '~icons/carbon/cloud'
import IconCarbonLaptop from '~icons/carbon/laptop'
import IconCarbonLink from '~icons/carbon/link'

import { buildModeOptions, topMenuProps, type MenuIconFactory } from './top-menu'
import { useServiceStore } from '@/stores/service'

defineOptions({ name: 'AppModeMenu' })

const router = useRouter()
const service = useServiceStore()
const { t } = useI18n()

/** 是否处于「本地环境」（Go 本地进程 或 纯浏览器本地模式）。 */
const isLocalEnvironment = computed(
  () => service.mode === 'local' || service.mode === 'browser-local',
)

/** 当前环境名称：本地环境显示模式名，远程环境显示服务名。 */
const environmentLabel = computed(() => {
  if (service.mode === 'browser-local') {
    return t('layout.modeMenu.browserLocal')
  }
  if (service.isLocal) {
    return t('layout.modeMenu.local')
  }
  return service.displayName.trim() || service.baseUrl
})

const menuIcon: MenuIconFactory = (name) => {
  const component =
    name === 'current' ? IconCarbonCheckmark : name === 'link' ? IconCarbonLink : IconCarbonLaptop
  return () => h(NIcon, null, { default: () => h(component) })
}

const modeOptions = computed<DropdownOption[]>(() =>
  buildModeOptions({
    environmentLabel: environmentLabel.value,
    isLocalEnvironment: isLocalEnvironment.value,
    labels: {
      connectRemote: t('layout.modeMenu.connectRemote'),
      switchService: t('layout.modeMenu.switchService'),
    },
    menuIcon,
  }),
)

const onSelectMode = async (key: string | number): Promise<void> => {
  if (key === 'connect-remote') {
    // 本地模式下路由守卫会拦截 /service，必须带 force=1 才能打开配置页。
    await router.push({ path: '/service', query: { force: '1' } })
    return
  }
  if (key === 'switch-service') {
    await router.push({ path: '/service' })
  }
}
</script>

<template>
  <NDropdown
    trigger="click"
    :options="modeOptions"
    :menu-props="topMenuProps"
    placement="bottom-end"
    @select="onSelectMode"
  >
    <NButton
      secondary
      size="small"
      class="gap-1.5 px-2.5"
      style="--n-height: 32px"
      :aria-label="t('layout.modeMenu.label')"
      :title="environmentLabel"
    >
      <span
        class="h-2 w-2 shrink-0 rounded-full"
        :class="isLocalEnvironment ? 'bg-lf-success' : 'bg-lf-info'"
        aria-hidden="true"
      />
      <IconCarbonLaptop v-if="isLocalEnvironment" class="text-base" aria-hidden="true" />
      <IconCarbonCloud v-else class="text-base" aria-hidden="true" />
      <span class="hidden sm:inline">{{ environmentLabel }}</span>
    </NButton>
  </NDropdown>
</template>
