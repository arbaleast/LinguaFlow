/**
 * Repository 层的公共原语。
 *
 * 所有业务表共享：UUID 主键、自增 `localId` 发号、同步元字段维护、
 * 设备标识、软删墓碑与 CAS 递增。
 */
import type { LinguaFlowDatabase } from './db'
import type { BaseRow, SyncMeta } from './types'

/** ISO8601 时间戳（毫秒精度，与后端 `time.Time` 的 JSON 形态一致）。 */
export function nowIso(): string {
  return new Date().toISOString()
}

/** 生成 UUID v4 主键。 */
export function newId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID()
  }
  // 兜底：Math.random 拼装的 v4 形态（仅在无 WebCrypto 的极旧环境触发）。
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** 设备标识（持久化于 `kv_meta`，用于云同步冲突裁决）。 */
export async function getDeviceId(db: LinguaFlowDatabase): Promise<string> {
  const row = await db.kv_meta.get('device_id')
  if (row && typeof row.value === 'string' && row.value !== '') {
    return row.value
  }
  const deviceId = newId()
  await db.kv_meta.put({ key: 'device_id', value: deviceId, updated_at: nowIso() })
  return deviceId
}

/**
 * 分配下一个 `localId`（复刻后端 `ent` 的自增 ID 语义）。
 *
 * 发号器落在 `sequences` 表，**在事务内**完成，避免并发写同一张表时重号。
 */
export async function nextLocalId(db: LinguaFlowDatabase, name: string): Promise<number> {
  const row = await db.sequences.get(name)
  const next = (row?.value ?? 0) + 1
  await db.sequences.put({ name, value: next })
  return next
}

/** 构造同步元字段的初始值。 */
export function initialSyncMeta(deviceId: string): SyncMeta {
  return {
    revision: 1,
    deletedAt: null,
    deviceId,
    dirty: true,
  }
}

/**
 * 构造一条新行（含 UUID 主键、自增 `localId` 与同步元字段）。
 *
 * @param localId 由 `nextLocalId` 分配的数字 ID
 */
export async function newRow<
  T extends Omit<BaseRow, keyof SyncMeta | 'id' | 'localId' | 'createdAt' | 'updatedAt'>,
>(
  db: LinguaFlowDatabase,
  options: {
    /** 自增序列名（例如 `'project'`）。 */
    sequence: string
    /** 设备标识。 */
    deviceId: string
    /** 业务字段。 */
    fields: T
  },
): Promise<BaseRow & T> {
  const localId = await nextLocalId(db, options.sequence)
  const at = nowIso()
  return {
    id: newId(),
    localId,
    createdAt: at,
    updatedAt: at,
    ...initialSyncMeta(options.deviceId),
    ...options.fields,
  } as BaseRow & T
}

/**
 * 触碰一行：递增 `revision`、刷新 `updatedAt`、置 `dirty`。
 *
 * `revision` 的单调递增就是**乐观锁**的 CAS 依据（替代后端 `ent.ContentVersion`）。
 */
export function touch<T extends BaseRow>(row: T, deviceId: string): T {
  return {
    ...row,
    revision: row.revision + 1,
    updatedAt: nowIso(),
    deviceId,
    dirty: true,
  }
}

/** 软删一行（写墓碑，不物理删除，等待云同步确认）。 */
export function softDelete<T extends BaseRow>(row: T, deviceId: string): T {
  return {
    ...row,
    revision: row.revision + 1,
    updatedAt: nowIso(),
    deletedAt: nowIso(),
    deviceId,
    dirty: true,
  }
}

/** 判断一行是否已软删。 */
export function isDeleted(row: { deletedAt: string | null } | undefined): boolean {
  return !row || row.deletedAt !== null
}

/**
 * CAS 校验：期望 `revision` 与实际一致时才允许写入。
 *
 * 抛出的错误由 `LocalGateway` 转成 HTTP 409 Conflict（对应后端
 * `isResourceConflictError` / `ResourceConflictError` 语义）。
 */
export class ConflictError extends Error {
  constructor(
    /** 冲突实体的类型。 */
    readonly entity: string,
    /** 冲突实体的 ID。 */
    readonly id: string | number,
    /** 期望的版本。 */
    readonly expectedRevision: number,
    /** 实际的版本。 */
    readonly actualRevision: number,
  ) {
    super(
      `${entity} ${String(id)} 版本冲突：期望 revision=${expectedRevision}，实际 revision=${actualRevision}`,
    )
    this.name = 'ConflictError'
  }
}

/**
 * 在事务内做 CAS 写入。
 *
 * 流程：读当前行 → 校验 `revision` → 写入 `revision+1` 的新行。
 */
export async function casWrite<T extends BaseRow>(
  read: () => Promise<T | undefined>,
  write: (row: T) => Promise<void>,
  options: { entity: string; expectedRevision?: number },
): Promise<void> {
  const current = await read()
  if (!current) {
    throw new ConflictError(options.entity, 'unknown', options.expectedRevision ?? 0, -1)
  }
  if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) {
    throw new ConflictError(options.entity, current.id, options.expectedRevision, current.revision)
  }
  await write(touch(current, current.deviceId))
}
