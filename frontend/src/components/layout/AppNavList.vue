<script setup lang="ts">
import { NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'

import { APP_NAV_SECTIONS, type AppNavItem } from '@/layouts/navigation'
import { useAuthStore } from '@/stores/auth'

/**
 * 全应用导航列表：桌面侧边栏与移动端抽屉共用同一份渲染，
 * 保证「分类标题 / 选中态 / 悬浮态 / 图标排版」在两端完全一致。
 */
defineOptions({ name: 'AppNavList' })

withDefaults(
  defineProps<{
    /** 窄栏模式：隐藏分类标题与文字，仅居中展示图标并启用 Tooltip */
    collapsed?: boolean
    /** 抽屉形态：导航容器不占据剩余高度（由抽屉自身滚动） */
    variant?: 'sidebar' | 'drawer'
  }>(),
  { collapsed: false, variant: 'sidebar' },
)

const emit = defineEmits<{
  /** 点击任意导航项后触发（移动端抽屉用于自动关闭） */
  navigate: []
}>()

const { t } = useI18n()
const auth = useAuthStore()
const route = useRoute()

const sections = computed(() =>
  APP_NAV_SECTIONS.filter((section) => !section.adminOnly || auth.user?.role === 'admin'),
)

const isActive = (item: AppNavItem): boolean => {
  if (item.path === '/') {
    return route.path === '/'
  }
  return route.path === item.path || route.path.startsWith(`${item.path}/`)
}
</script>

<template>
  <nav
    class="flex flex-col"
    :class="variant === 'sidebar' ? 'lf-scroll min-h-0 flex-1 overflow-y-auto' : ''"
    :aria-label="t('nav.main')"
  >
    <template v-for="section in sections" :key="`section-${section.labelKey}`">
      <!-- 分类标题：12px / SemiBold / 中性灰，无底色；区块之间 mt-6 mb-2 拉开层级 -->
      <div
        v-if="!collapsed"
        class="mt-6 mb-2 px-3 text-xs font-semibold tracking-wide text-lf-text-subtle first:mt-0"
      >
        {{ t(section.labelKey) }}
      </div>

      <div class="flex flex-col gap-0.5">
        <NTooltip
          v-for="item in section.items"
          :key="item.path"
          trigger="hover"
          placement="right"
          :disabled="!collapsed"
        >
          <template #trigger>
            <RouterLink
              :to="item.path"
              class="group relative flex h-9 items-center gap-3 rounded-lf-ctl px-3 text-sm font-medium no-underline transition-colors duration-150"
              :class="[
                collapsed ? 'justify-center px-0' : '',
                isActive(item)
                  ? 'bg-lf-brand-soft text-brand-600'
                  : 'text-lf-text-muted hover:bg-lf-surface-muted hover:text-lf-text',
              ]"
              :aria-current="isActive(item) ? 'page' : undefined"
              :aria-label="collapsed ? t(item.labelKey) : undefined"
              @click="emit('navigate')"
            >
              <!-- 选中态视觉锚点：左侧 3px 品牌色圆角竖条（与菜单项左缘齐平） -->
              <span
                class="absolute top-1/2 left-0 h-5 w-[3px] -translate-y-1/2 rounded-full bg-brand-500 transition-opacity duration-150"
                :class="isActive(item) ? 'opacity-100' : 'opacity-0'"
                aria-hidden="true"
              />
              <component
                :is="item.icon"
                class="h-5 w-5 shrink-0 transition-colors duration-150"
                :class="
                  isActive(item)
                    ? 'text-brand-600'
                    : 'text-lf-text-subtle group-hover:text-lf-text-muted'
                "
                aria-hidden="true"
              />
              <span v-if="!collapsed" class="min-w-0 truncate">{{ t(item.labelKey) }}</span>
            </RouterLink>
          </template>
          <span class="block max-w-xs truncate">{{ t(item.labelKey) }}</span>
        </NTooltip>
      </div>
    </template>
  </nav>
</template>
