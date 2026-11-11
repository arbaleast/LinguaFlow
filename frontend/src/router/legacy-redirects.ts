import type {
  LocationQueryRaw,
  RouteLocationNormalized,
  RouteLocationRaw,
  RouteRecordRaw,
} from 'vue-router'

/**
 * 旧路径 → 新入口的兼容重定向。
 *
 * 功能收敛后：
 * - 「AI 后端」升级为「AI 配置」`/backends`（一级 Tab：backends / prompts / usage）；
 *   三类提示词并入「提示词模板」Tab（内层 `?promptTab=`：translation / bootstrap / prune）；
 * - 执行策略与执行计划合并到 `/execution-config`（Tab：profiles / plans）；
 * - 用量概览并入「AI 配置」（Tab：usage），工作台不再提供用量 Tab。
 *
 * 旧书签、历史记录与站内旧链接统一重定向到新页面对应的 Tab，
 * 并保留其余 Query 参数（如 org_id），不会产生重定向死循环。
 */
interface LegacyTabRedirect {
  /** 旧路径 */
  path: string
  /** 合并后的新路径 */
  target: string
  /** 新页面一级 Tab（?tab=xxx） */
  tab: string
  /** 新页面内层 Tab（写入 `?promptTab=`；仅两级 Tab 的合并需要） */
  subTab?: string
  /** 把旧 Query 中的 `?tab=` 值搬移到内层 Key（如 `promptTab`） */
  remapTabTo?: string
}

const LEGACY_TAB_REDIRECTS: LegacyTabRedirect[] = [
  {
    path: '/bootstrap-prompt-templates',
    target: '/backends',
    tab: 'prompts',
    subTab: 'bootstrap',
  },
  { path: '/prune-prompt-templates', target: '/backends', tab: 'prompts', subTab: 'prune' },
  // 旧提示词管理入口的 `?tab=translation|bootstrap|prune` 是内层分类，搬到 `?promptTab=`
  { path: '/prompt-templates', target: '/backends', tab: 'prompts', remapTabTo: 'promptTab' },
  { path: '/execution-profiles', target: '/execution-config', tab: 'profiles' },
  { path: '/execution-plan-templates', target: '/execution-config', tab: 'plans' },
  { path: '/stats', target: '/backends', tab: 'usage' },
]

/** 旧路由重定向表（追加到文件路由之后） */
export const legacyRedirectRoutes: RouteRecordRaw[] = LEGACY_TAB_REDIRECTS.map(
  ({ path, target, tab, subTab, remapTabTo }) => ({
    path,
    redirect: (to) => {
      const query: LocationQueryRaw = { ...to.query, tab }
      if (subTab) query.promptTab = subTab
      if (remapTabTo && typeof to.query.tab === 'string') {
        query[remapTabTo] = to.query.tab
      }
      return { path: target, query }
    },
  }),
)

/**
 * 工作台不再承载用量 Tab：`/?tab=usage` 平滑迁移到 `/backends?tab=usage`。
 *
 * 以导航守卫实现而非路由记录：与文件路由 `/` 得分相同的重定向记录会因匹配顺序
 * 遮蔽真正的工作台页面；守卫仅在显式携带 tab=usage 时介入，其余访问不受影响。
 */
export const workbenchUsageRedirect = (
  to: RouteLocationNormalized,
): RouteLocationRaw | undefined => {
  if (to.path === '/' && to.query.tab === 'usage') {
    return { path: '/backends', query: to.query }
  }
  return undefined
}
