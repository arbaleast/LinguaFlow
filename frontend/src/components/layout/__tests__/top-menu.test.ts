/**
 * 顶栏两个下拉菜单的职责分离测试。
 *
 * 验收目标：
 *
 * - 模式菜单**只**包含环境相关项（当前环境 + 切换入口）；
 * - 头像菜单**只**包含个人设置项；
 * - 两者没有任何交集，也不残留旧的 `local / 本地模式` 标题块。
 */
import { describe, expect, it } from 'vitest'
import {
  buildModeOptions,
  buildUserOptions,
  topMenuProps,
  TOP_MENU_MIN_WIDTH,
  type MenuIconFactory,
} from '../top-menu'

/** 测试用的图标工厂：只记录名字，不产生真实 vnode。 */
const menuIcon: MenuIconFactory = (name) => () => name

const MODE_LABELS = {
  connectRemote: '连接远程服务…',
  switchService: '切换服务器…',
}

const USER_LABELS = {
  profile: '个人资料',
  security: '安全设置',
  preferences: '使用偏好',
  team: '团队',
  changelog: '更新日志',
  about: '关于',
  logout: '退出登录',
}

/** 取出选项的 key（跳过分隔线）。 */
const keysOf = (options: { key?: string | number; type?: string }[]): string[] =>
  options.filter((option) => option.type !== 'divider').map((option) => String(option.key))

/** 取出选项的文案（跳过分隔线）。 */
const labelsOf = (options: { label?: string; type?: string }[]): string[] =>
  options.filter((option) => option.type !== 'divider').map((option) => String(option.label))

describe('顶栏菜单 — 环境模式切换', () => {
  it('本地环境：只显示当前环境与「连接远程服务…」', () => {
    const options = buildModeOptions({
      environmentLabel: '本地模式',
      isLocalEnvironment: true,
      labels: MODE_LABELS,
      menuIcon,
    })
    expect(keysOf(options)).toEqual(['current', 'connect-remote'])
    expect(labelsOf(options)).toEqual(['本地模式', '连接远程服务…'])
  })

  it('远程环境：只显示当前环境与「切换服务器…」', () => {
    const options = buildModeOptions({
      environmentLabel: 'https://lf.example.com',
      isLocalEnvironment: false,
      labels: MODE_LABELS,
      menuIcon,
    })
    expect(keysOf(options)).toEqual(['current', 'switch-service'])
    expect(labelsOf(options)).toEqual(['https://lf.example.com', '切换服务器…'])
  })

  it('当前环境项带勾选图标且不可点击', () => {
    const [current] = buildModeOptions({
      environmentLabel: '本地模式',
      isLocalEnvironment: true,
      labels: MODE_LABELS,
      menuIcon,
    })
    expect(current?.disabled).toBe(true)
    expect(typeof current?.icon).toBe('function')
  })

  it('不包含任何个人设置项', () => {
    const options = buildModeOptions({
      environmentLabel: '本地模式',
      isLocalEnvironment: true,
      labels: MODE_LABELS,
      menuIcon,
    })
    const labels = labelsOf(options)
    for (const personal of Object.values(USER_LABELS)) {
      expect(labels).not.toContain(personal)
    }
  })
})

describe('顶栏菜单 — 用户头像', () => {
  it('远程环境：个人设置 + 团队 + 更新日志 + 关于 + 退出登录', () => {
    const options = buildUserOptions({
      isLocalEnvironment: false,
      labels: USER_LABELS,
      menuIcon,
    })
    expect(keysOf(options)).toEqual([
      'profile',
      'security',
      'preferences',
      'team',
      'changelog',
      'about',
      'logout',
    ])
  })

  it('本地环境：没有团队与退出登录（无服务端会话可注销）', () => {
    const options = buildUserOptions({
      isLocalEnvironment: true,
      labels: USER_LABELS,
      menuIcon,
    })
    expect(keysOf(options)).toEqual(['profile', 'security', 'preferences', 'changelog', 'about'])
  })

  it('不包含任何环境切换项', () => {
    const options = buildUserOptions({
      isLocalEnvironment: false,
      labels: USER_LABELS,
      menuIcon,
    })
    const keys = keysOf(options)
    expect(keys).not.toContain('connect-remote')
    expect(keys).not.toContain('switch-service')
    expect(keys).not.toContain('current')
  })

  it('不再渲染旧的「local / 本地模式」标题块', () => {
    const options = buildUserOptions({
      isLocalEnvironment: true,
      labels: USER_LABELS,
      menuIcon,
    })
    expect(options.some((option) => option.type === 'render')).toBe(false)
    expect(labelsOf(options)).not.toContain('本地模式')
  })
})

describe('顶栏菜单 — 统一外观', () => {
  it('两个菜单共用同一套宽度', () => {
    const props = topMenuProps(undefined, [])
    expect(String(props.style)).toContain(TOP_MENU_MIN_WIDTH)
  })
})
