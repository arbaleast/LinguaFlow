import type { Component } from 'vue'

/**
 * 通用 Tab 项：标识、显示文案与按需挂载的面板组件。
 *
 * `key` 与路由 Query 取值保持一致（如 `?tab=translation`），
 * `panel` 为该 Tab 的内容组件，由 SectionTabs 以 `<KeepAlive>` 承载：
 * 未激活的 Tab 不会挂载（不发起重复请求），切回时保留表单/筛选/分页状态。
 */
export interface SectionTabItem<T extends string = string> {
  key: T
  label: string
  panel: Component
}
