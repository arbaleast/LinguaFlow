/**
 * 顶部导航下拉菜单的共享外观与选项构造。
 *
 * 顶栏右侧有多个并列的下拉入口（语言、主题、环境模式、用户设置），
 * 统一由这里收敛宽度与留白，避免各入口看起来像不同组件。
 *
 * 本模块只依赖**类型**，不引入 naive-ui 的运行时实现，
 * 因此可以在 Node 环境下直接做单元测试。
 */
import type { DropdownMenuProps, DropdownOption } from 'naive-ui'

/** 顶栏下拉菜单的最小宽度。 */
export const TOP_MENU_MIN_WIDTH = '12.5rem'

/**
 * 顶栏下拉菜单的统一 `menu-props`。
 *
 * naive-ui 的 `NDropdown` 会把返回值透传给内部 `NMenu`，
 * 因此 `style` 直接作用在菜单根节点上。
 */
export const topMenuProps: DropdownMenuProps = () => ({
  style: `min-width: ${TOP_MENU_MIN_WIDTH};`,
})

/** 顶栏菜单使用的语义化图标名（由调用方映射到具体图标组件）。 */
export type MenuIconName =
  | 'current'
  | 'link'
  | 'profile'
  | 'security'
  | 'preferences'
  | 'team'
  | 'changelog'
  | 'about'
  | 'logout'

/** 菜单图标渲染器：由调用方注入（naive-ui 的 `NIcon` 包装）。 */
export type MenuIconFactory = (name: MenuIconName) => DropdownOption['icon']

/** 模式菜单的文案。 */
export interface ModeMenuLabels {
  /** 「连接远程服务…」 */
  connectRemote: string
  /** 「切换服务器…」 */
  switchService: string
}

/** 模式菜单的构造参数。 */
export interface ModeMenuInput {
  /** 当前环境名称（本地模式 / 浏览器本地模式 / 远程服务名）。 */
  environmentLabel: string
  /** 是否处于本地环境（Go 本地进程 或 纯浏览器本地模式）。 */
  isLocalEnvironment: boolean
  labels: ModeMenuLabels
  menuIcon: MenuIconFactory
}

/**
 * 构造【环境模式切换】菜单。
 *
 * 菜单只有两类信息：
 *
 * 1. 当前环境（带勾选图标，禁用状态）；
 * 2. 切换入口（本地环境 → 连接远程服务；远程环境 → 切换服务器）。
 *
 * 绝不包含任何用户个人设置。
 */
export function buildModeOptions(input: ModeMenuInput): DropdownOption[] {
  const { environmentLabel, isLocalEnvironment, labels, menuIcon } = input
  return [
    {
      key: 'current',
      label: environmentLabel,
      disabled: true,
      icon: menuIcon('current'),
    },
    { type: 'divider', key: 'mode-divider' },
    isLocalEnvironment
      ? {
          key: 'connect-remote',
          label: labels.connectRemote,
          icon: menuIcon('link'),
        }
      : {
          key: 'switch-service',
          label: labels.switchService,
          icon: menuIcon('link'),
        },
  ]
}

/** 用户菜单的文案。 */
export interface UserMenuLabels {
  profile: string
  security: string
  preferences: string
  team: string
  changelog: string
  about: string
  logout: string
}

/** 用户菜单的构造参数。 */
export interface UserMenuInput {
  /** 是否处于本地环境（本地环境没有团队、没有可注销的服务端会话）。 */
  isLocalEnvironment: boolean
  labels: UserMenuLabels
  menuIcon: MenuIconFactory
}

/**
 * 构造【用户头像菜单】。
 *
 * 菜单只有账号个人操作：个人资料、安全设置、使用偏好、（远程环境的）团队、
 * 更新日志、关于、（远程环境的）退出登录。
 *
 * 绝不包含任何环境切换项。
 */
export function buildUserOptions(input: UserMenuInput): DropdownOption[] {
  const { isLocalEnvironment, labels, menuIcon } = input
  const items: DropdownOption[] = [
    { key: 'profile', label: labels.profile, icon: menuIcon('profile') },
    { key: 'security', label: labels.security, icon: menuIcon('security') },
    { key: 'preferences', label: labels.preferences, icon: menuIcon('preferences') },
  ]
  if (!isLocalEnvironment) {
    items.push({ key: 'team', label: labels.team, icon: menuIcon('team') })
  }
  items.push({ type: 'divider', key: 'user-divider-1' })
  items.push({ key: 'changelog', label: labels.changelog, icon: menuIcon('changelog') })
  items.push({ key: 'about', label: labels.about, icon: menuIcon('about') })
  if (!isLocalEnvironment) {
    items.push({ type: 'divider', key: 'user-divider-2' })
    items.push({ key: 'logout', label: labels.logout, icon: menuIcon('logout') })
  }
  return items
}
