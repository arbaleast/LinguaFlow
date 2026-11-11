/**
 * 二进制对象存储的工厂与聚合出口。
 */
import { getDatabase, type LinguaFlowDatabase } from '../indexeddb/db'
import { IndexedDbBlobStore } from './idb'
import { MemoryBlobStore } from './memory'
import { isOpfsSupported, OpfsBlobStore } from './opfs'
import type { BlobStore } from './types'

export * from './types'
export { MemoryBlobStore, toBytes, toHex } from './memory'
export { OpfsBlobStore, isOpfsSupported } from './opfs'
export { IndexedDbBlobStore } from './idb'

let store: BlobStore | null = null

/**
 * 创建二进制对象存储（按环境能力自动选择实现）。
 *
 * 选择顺序：
 *
 * 1. OPFS 可用 → `OpfsBlobStore`（首选，真文件系统语义 + 流式写入）。
 * 2. 否则 → `IndexedDbBlobStore`（`raw_blobs` 独立表，按 key 懒加载）。
 * 3. `forceMemory=true` → `MemoryBlobStore`（单元测试 / 无持久化环境）。
 */
export function createBlobStore(options?: {
  /** 强制使用内存实现。 */
  forceMemory?: boolean
  /** 指定数据库实例（降级实现需要）。 */
  db?: LinguaFlowDatabase
}): BlobStore {
  if (options?.forceMemory) {
    return new MemoryBlobStore()
  }
  if (isOpfsSupported()) {
    return new OpfsBlobStore()
  }
  return new IndexedDbBlobStore(options?.db ?? getDatabase())
}

/** 获取共享的二进制对象存储（惰性创建）。 */
export function getBlobStore(): BlobStore {
  if (!store) {
    store = createBlobStore()
  }
  return store
}

/** 重置共享的二进制对象存储句柄（测试用）。 */
export function resetBlobStore(): void {
  store = null
}
