import type { RouteRecordRaw } from 'vue-router'

/**
 * 旧路径 → 新入口的兼容重定向。
 *
 * 功能收敛后：
 * - 三类提示词合并到 `/prompt-templates`（Tab：translation / bootstrap / prune）；
 * - 执行策略与执行计划合并到 `/execution-config`（Tab：profiles / plans）；
 * - 用量概览并入工作台 `/`（Tab：usage）。
 *
 * 旧书签、历史记录与站内旧链接统一重定向到新页面对应的 Tab，
 * 并保留其余 Query 参数（如 org_id），不会产生重定向死循环。
 */
interface LegacyTabRedirect {
  /** 旧路径 */
  path: string
  /** 合并后的新路径 */
  target: string
  /** 新页面中对应的 Tab（?tab=xxx） */
  tab: string
}

const LEGACY_TAB_REDIRECTS: LegacyTabRedirect[] = [
  { path: '/bootstrap-prompt-templates', target: '/prompt-templates', tab: 'bootstrap' },
  { path: '/prune-prompt-templates', target: '/prompt-templates', tab: 'prune' },
  { path: '/execution-profiles', target: '/execution-config', tab: 'profiles' },
  { path: '/execution-plan-templates', target: '/execution-config', tab: 'plans' },
  { path: '/stats', target: '/', tab: 'usage' },
]

/** 旧路由重定向表（追加到文件路由之后） */
export const legacyRedirectRoutes: RouteRecordRaw[] = LEGACY_TAB_REDIRECTS.map(
  ({ path, target, tab }) => ({
    path,
    redirect: (to) => ({ path: target, query: { ...to.query, tab } }),
  }),
)
