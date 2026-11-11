import type { Component } from 'vue'

import IconCarbonDashboard from '~icons/carbon/dashboard'
import IconCarbonFolder from '~icons/carbon/folder'
import IconCarbonServerProxy from '~icons/carbon/server-proxy'
import IconCarbonFlow from '~icons/carbon/flow'
import IconCarbonTextVerticalAlignment from '~icons/carbon/text-vertical-alignment'
import IconCarbonSecurity from '~icons/carbon/security'
import IconCarbonTask from '~icons/carbon/task'

export interface AppNavItem {
  /** 目标路由路径；'/' 仅在精确匹配时视为激活 */
  path: string
  labelKey: string
  icon: Component
}

export interface AppNavSection {
  /** 分组标题 i18n key（分类标题：12px / SemiBold / 中性灰，无底色） */
  labelKey: string
  items: AppNavItem[]
  /** 仅管理员可见 */
  adminOnly?: boolean
}

/** 全应用导航的单一数据源：桌面侧边栏与移动端抽屉共用同一份渲染 */
export const APP_NAV_SECTIONS: AppNavSection[] = [
  {
    labelKey: 'nav.mainGroup',
    items: [
      { path: '/', labelKey: 'nav.dashboard', icon: IconCarbonDashboard },
      { path: '/operations', labelKey: 'operations.title', icon: IconCarbonTask },
      { path: '/projects', labelKey: 'nav.projects', icon: IconCarbonFolder },
    ],
  },
  {
    labelKey: 'nav.configGroup',
    items: [
      { path: '/backends', labelKey: 'nav.backends', icon: IconCarbonServerProxy },
      { path: '/execution-config', labelKey: 'nav.executionConfig', icon: IconCarbonFlow },
    ],
  },
  {
    labelKey: 'nav.tools',
    items: [
      {
        path: '/tools/epub-rotate',
        labelKey: 'nav.epubRotate',
        icon: IconCarbonTextVerticalAlignment,
      },
    ],
  },
  {
    labelKey: 'nav.adminGroup',
    adminOnly: true,
    items: [{ path: '/admin', labelKey: 'nav.admin', icon: IconCarbonSecurity }],
  },
]
