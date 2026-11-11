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

import { activityRoutes, jobRoutes, statsRoutes } from './jobs'
import { backendRoutes, credentialRoutes } from './credentials'
import { glossaryImportRoutes, glossaryRoutes } from './glossary'
import { operationRoutes } from './operations'
import { projectRoutes } from './projects'
import { resourceDownloadRoutes, resourceRoutes } from './resources'
import { segmentRoutes } from './segments'
import { storageRoutes } from './storage'
import { qaRecheckRoutes } from './qa_recheck'
import { templateRoutes } from './templates'
import { userRoutes } from './users'

export {
  activityRoutes,
  backendRoutes,
  credentialRoutes,
  glossaryImportRoutes,
  glossaryRoutes,
  jobRoutes,
  operationRoutes,
  projectRoutes,
  qaRecheckRoutes,
  resourceDownloadRoutes,
  resourceRoutes,
  segmentRoutes,
  statsRoutes,
  storageRoutes,
  templateRoutes,
  userRoutes,
}

/**
 * 全部本地端点。
 *
 * 顺序即匹配优先级（路径模板互不重叠，顺序不影响结果），
 * 与 `frontend/src/api/*.ts` 的调用路径**逐字一致**。
 */
export const localRoutes: readonly LocalRoute[] = [
  ...projectRoutes,
  ...resourceRoutes,
  ...resourceDownloadRoutes,
  ...segmentRoutes,
  ...glossaryRoutes,
  ...glossaryImportRoutes,
  ...qaRecheckRoutes,
  ...templateRoutes,
  ...credentialRoutes,
  ...backendRoutes,
  ...jobRoutes,
  ...statsRoutes,
  ...activityRoutes,
  ...operationRoutes,
  ...userRoutes,
  ...storageRoutes,
]
