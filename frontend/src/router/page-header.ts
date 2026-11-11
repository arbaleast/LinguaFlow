import type { RouteMeta } from 'vue-router'

/**
 * 顶栏页面头：由页面通过路由 meta 声明，AppLayout 统一渲染。
 *
 * 页面用 `definePage({ meta: { pageHeader: { ... } } })` 声明自己的标题/副标题；
 * 未声明的页面保持原有行为（顶栏左侧留白，页面内自带 PageHeader），
 * 避免顶栏与页内页头重复堆叠同一标题。
 */
export interface AppPageHeaderMeta {
  /** 页面标题的 i18n key */
  title: string
  /** 可选副标题的 i18n key（顶栏内以浅灰小字紧随标题） */
  subtitle?: string
  /** 沉浸式布局：页面不再渲染页内页头，主区收紧顶部内边距让内容上移 */
  immersive?: boolean
}

/** 从路由 meta 中安全读取页面头声明（meta 值来自用户可写的路由配置，需校验形状） */
export const readAppPageHeaderMeta = (meta: RouteMeta): AppPageHeaderMeta | null => {
  const value: unknown = meta.pageHeader
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.title !== 'string') return null
  return {
    title: record.title,
    subtitle: typeof record.subtitle === 'string' ? record.subtitle : undefined,
    immersive: record.immersive === true,
  }
}
