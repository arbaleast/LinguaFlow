import { computed, type ComputedRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'

/**
 * Tab 与路由 Query 的双向同步。
 *
 * 约定：当前激活的 Tab 始终由 `?tab=xxx` 表达。
 * - 通过 URL 直接定位 Tab（首次进入即命中目标 Tab）；
 * - 刷新页面保留当前 Tab（Query 是唯一数据源）；
 * - 浏览器前进/后退可正常切换 Tab（切换使用 router.push 写入历史记录）；
 * - Query 缺失或非法时回退到默认（首个）Tab。
 */

/** 可选的 Tab 定义；`value` 同时作为路由 Query 中的取值 */
export interface RouteTabOption<T extends string = string> {
  value: T
}

export interface RouteTabState<T extends string = string> {
  /** 当前激活的 Tab；Query 缺失或非法时回退到 defaultTab */
  activeTab: ComputedRef<T>
  /** 切换 Tab：把新值写入路由 Query（保留其余 Query 参数，如 org_id） */
  setTab: (tab: T) => void
}

/**
 * Query 同步选项。
 *
 * 默认写 `?tab=`；同一页面存在多层 Tab（如「AI 配置」的一级 Tab 与
 * 「提示词模板」内部的三分类 Tab）时，内层用独立的 Query Key（如 `promptTab`）
 * 避免两层互相覆盖。
 */
export interface RouteTabSyncOptions {
  queryKey?: string
}

export function useRouteTab<T extends string>(
  options: readonly RouteTabOption<T>[],
  defaultTab: T,
  sync: RouteTabSyncOptions = {},
): RouteTabState<T> {
  const route = useRoute()
  const router = useRouter()
  const allowed = new Set<string>(options.map((option) => option.value))
  const queryKey = sync.queryKey ?? 'tab'

  const activeTab = computed<T>(() => {
    const raw = route.query[queryKey]
    const value = Array.isArray(raw) ? raw[0] : raw
    return typeof value === 'string' && allowed.has(value) ? (value as T) : defaultTab
  })

  const setTab = (tab: T): void => {
    if (tab === activeTab.value) return
    // push 而非 replace：浏览器前进/后退需要能回到上一个 Tab。
    void router.push({ path: route.path, query: { ...route.query, [queryKey]: tab } })
  }

  return { activeTab, setTab }
}
