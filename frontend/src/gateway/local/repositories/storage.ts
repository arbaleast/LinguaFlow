/**
 * 本地「项目存储」投影（对应 Go `GetProjectStorage`）。
 *
 * 浏览器本地模式**只有一个逻辑存储空间**（浏览器自身的 OPFS / IndexedDB），
 * 因此：
 *
 * - `storage_state` 恒为 `active`（无迁移、无退役、无维护窗口）；
 * - `runtime.deployment_enabled` 为 `true`——本地写入**始终被允许**，
 *   `stores/projectWorkspace.ts` 的 `prepareStorageWrite` 因此可以顺畅通过；
 * - `runtime.maintenance` 恒为 `false`；
 * - `retirement` 两个阶段均 `allowed: false`，理由码 `storage_capability_unsupported`
 *   （浏览器本地没有「退役远端空间」这一动作）；
 * - `binding` 指向本地默认空间（`LOCAL_DEFAULT_STORAGE_SPACE_ID`）。
 *
 * 形状与后端 `ProjectStorage` **逐字段一致**（见 `api/types.d.ts` 的 `ProjectStorage`）。
 */
import type { ApiSchemas } from '@/api/client-core'
import type { LinguaFlowDatabase } from '@/infrastructure/indexeddb/db'
import { LOCAL_DEFAULT_STORAGE_SPACE_ID, requireProject } from './projects'

/** 本地默认存储空间的展示名。 */
export const LOCAL_DEFAULT_STORAGE_SPACE_NAME = '浏览器本地空间'

/** 退休（retirement）两个阶段在浏览器本地模式均不可用。 */
const RETIREMENT_UNAVAILABLE: ApiSchemas['StorageActionAvailability'] = {
  allowed: false,
  reason_codes: ['storage_capability_unsupported'],
}

/**
 * 构造本地存储运行时能力描述。
 *
 * `deployment_enabled` 为 `true`：本地写入始终允许（OPFS / IndexedDB 配额异常
 * 由写入路径自身转成结构化错误，而不是在准入层提前拒绝）。
 */
export function localStorageRuntime(): ApiSchemas['StorageRuntime'] {
  return {
    deployment_enabled: true,
    maintenance: false,
    retirement: {
      contract_version: 1,
      unused_removal: { ...RETIREMENT_UNAVAILABLE },
      in_use_retirement: { ...RETIREMENT_UNAVAILABLE },
    },
  }
}

/**
 * 读取项目的本地存储快照。
 *
 * @throws 仓库层的 `RepositoryNotFoundError`（路由层映射 404）。
 */
export async function getProjectStorage(
  db: LinguaFlowDatabase,
  projectId: number,
): Promise<ApiSchemas['ProjectStorage']> {
  const project = await requireProject(db, projectId)
  return {
    runtime: localStorageRuntime(),
    project_id: project.localId,
    storage_generation: project.storage_generation,
    storage_state: 'active',
    migration_task_id: null,
    binding: {
      space_id: project.storage_space_id ?? LOCAL_DEFAULT_STORAGE_SPACE_ID,
      name: LOCAL_DEFAULT_STORAGE_SPACE_NAME,
      scope: 'user',
      status: 'active',
      historical: false,
      owner_id: 1,
    },
    reason_codes: [],
  }
}
