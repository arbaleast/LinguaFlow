/**
 * 本地存储配额与持久化权限。
 *
 * - `navigator.storage.persist()`：申请持久化存储权限，避免浏览器在空间紧张时
 *   清理本地数据（这是「浏览器优先」架构的数据安全底线）。
 * - `navigator.storage.estimate()`：查询本地空间配额与使用量，供 `storage` store
 *   展示与写入前的预算校验。
 * - 预算常量沿用前端既有的 EPUB 预算族（`useEpubRotate.ts:39-44`）与后端
 *   `ziputil` / `storage` 的上限，保持前后端口径一致。
 */

/** 单个文件上限：80 MB。 */
export const MAX_FILE_BYTES = 80 * 1024 * 1024

/** 单条目（压缩包内一项）解压后上限：16 MB。 */
export const MAX_ENTRY_UNCOMPRESSED_BYTES = 16 * 1024 * 1024

/** 单个压缩包总解压上限：120 MB。 */
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 120 * 1024 * 1024

/** 单个压缩包条目数上限：8000。 */
export const MAX_ARCHIVE_ENTRIES = 8000

/** 存储估算结果。 */
export interface StorageEstimate {
  /** 已用字节数。 */
  usage: number
  /** 配额字节数（浏览器未给出时为 `null`）。 */
  quota: number | null
  /** 是否已获得持久化权限。 */
  persisted: boolean
}

/** 存储估算不可用时的缺省值。 */
export const EMPTY_ESTIMATE: StorageEstimate = { usage: 0, quota: null, persisted: false }

/** 结构化错误：配额超限。 */
export class QuotaExceededError extends Error {
  constructor(
    /** 触发的预算项名称。 */
    readonly budget: string,
    /** 实际值。 */
    readonly actual: number,
    /** 预算上限。 */
    readonly limit: number,
    message?: string,
  ) {
    super(message ?? `本地存储超出预算：${budget}（${actual} > ${limit}）`)
    this.name = 'QuotaExceededError'
  }
}

/** 把浏览器原生的 `QuotaExceededError` 归一为结构化错误。 */
export function isQuotaExceeded(error: unknown): boolean {
  if (error instanceof QuotaExceededError) return true
  if (!error || typeof error !== 'object') return false
  const name = (error as { name?: unknown }).name
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED'
}

/**
 * 查询本地存储用量与配额。
 *
 * 浏览器不支持 StorageManager 时返回 `EMPTY_ESTIMATE`（不抛错）。
 */
export async function estimateStorage(): Promise<StorageEstimate> {
  const manager = globalThis.navigator?.storage
  if (!manager || typeof manager.estimate !== 'function') {
    return { ...EMPTY_ESTIMATE, persisted: await isPersisted() }
  }
  try {
    const estimate = await manager.estimate()
    return {
      usage: estimate.usage ?? 0,
      quota: estimate.quota ?? null,
      persisted: await isPersisted(),
    }
  } catch {
    return { ...EMPTY_ESTIMATE, persisted: await isPersisted() }
  }
}

/** 当前是否已获得持久化存储权限。 */
export async function isPersisted(): Promise<boolean> {
  const manager = globalThis.navigator?.storage
  if (!manager || typeof manager.persisted !== 'function') return false
  try {
    return await manager.persisted()
  } catch {
    return false
  }
}

/**
 * 申请持久化存储权限。
 *
 * 浏览器可能拒绝（例如用户未授予、或处于隐私模式）；返回是否成功，
 * **不抛错**——持久化是「尽力而为」的增强，不是硬前置。
 */
export async function requestPersistence(): Promise<boolean> {
  const manager = globalThis.navigator?.storage
  if (!manager || typeof manager.persist !== 'function') return false
  try {
    if (typeof manager.persisted === 'function' && (await manager.persisted())) {
      return true
    }
    return await manager.persist()
  } catch {
    return false
  }
}

/** 写入前的预算校验：超出即抛 `QuotaExceededError`。 */
export function assertWithinBudget(budget: string, actual: number, limit: number): void {
  if (actual > limit) {
    throw new QuotaExceededError(budget, actual, limit)
  }
}
