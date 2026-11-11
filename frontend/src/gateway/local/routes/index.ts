/**
 * Phase 2 本地路由表聚合出口。
 *
 * 由 `LocalGateway` 在启动时 `router.addAll(localRoutes)` 即可接管全部端点；
 * 本模块刻意不做任何网关实例化，保持「路由表」与「网关分发」解耦。
 *
 * TM 没有路由：`src/api/` 中不存在 TM 端点（TM 只由翻译流水线内部使用），
 * 对应的 Repository 在 `../repositories/tm.ts`。
 */
import type { LocalRoute } from '../router'

import { glossaryRoutes } from './glossary'
import { projectRoutes } from './projects'
import { resourceRoutes } from './resources'

export { glossaryRoutes, projectRoutes, resourceRoutes }

/** 全部本地端点（项目 / 资源 / 术语表）。 */
export const localRoutes: readonly LocalRoute[] = [
  ...projectRoutes,
  ...resourceRoutes,
  ...glossaryRoutes,
]
