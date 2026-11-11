import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * KeepAlive 行为契约测试。
 *
 * 工作台状态在路由往返时不丢失，依赖两件事必须同时成立：
 * 1. App.vue 的 RouterView 用 KeepAlive 包裹页面组件，且 include 只保留工作台；
 * 2. 工作台页面组件显式声明了与 include 匹配的组件名。
 *
 * 这里直接校验源码契约（ents 与 openapi 契约测试同风格），避免后续重构
 * 悄悄移除缓存或把 include 放宽到所有路由。
 */
const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../src/${relative}`, import.meta.url)), 'utf8')

const compact = (source: string): string => source.replace(/\s+/g, ' ')

describe('workbench KeepAlive contract', () => {
  it('caches only the workbench page', () => {
    const app = compact(read('App.vue'))
    expect(app).toContain("<KeepAlive :include=\"['WorkbenchPage']\">")
    // 动态组件必须位于 KeepAlive 内部，否则缓存不生效。
    expect(app.indexOf('<KeepAlive')).toBeLessThan(app.indexOf('<component :is="Component" />'))
  })

  it('declares the stable component name the include list matches', () => {
    const page = compact(read('pages/index.vue'))
    expect(page).toContain("defineOptions({ name: 'WorkbenchPage' })")
  })

  it('detaches global listeners while the page is cached', () => {
    const component = compact(read('components/dashboard/WorkbenchMailAssistant.vue'))
    expect(component).toContain('onDeactivated(() => {')
    expect(component).toContain('onActivated(() => {')
    expect(component).toContain("window.removeEventListener('keydown', onGlobalKeydown)")
  })
})
