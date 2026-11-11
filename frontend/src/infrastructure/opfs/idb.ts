/**
 * IndexedDB 降级实现（二进制对象存储）。
 *
 * 仅在**不支持 OPFS** 的环境使用：把对象本体写进 `raw_blobs` 独立表。
 *
 * 与元数据表**物理隔离**是硬要求：`raw_blobs` 只以 `key` 为主键，
 * 业务查询永远不会扫到它；读取必须按 key 逐条 `get`，避免一次性把大二进制
 * 拉进内存。
 */
import { sha256Bytes } from '@/domain/shared/hash'
import type { LinguaFlowDatabase } from '../indexeddb/db'
import { normalizeKey, type BlobMeta, type BlobStore } from './types'
import { toBytes, toHex } from './memory'

/** IndexedDB 降级实现。 */
export class IndexedDbBlobStore implements BlobStore {
  readonly kind = 'idb' as const

  constructor(private readonly db: LinguaFlowDatabase) {}

  async write(key: string, data: Blob | ArrayBuffer | Uint8Array | string): Promise<BlobMeta> {
    const bytes = await toBytes(data)
    const normalized = normalizeKey(key)
    await this.db.raw_blobs.put({
      key: normalized,
      data: new Blob([bytes]),
      size: bytes.length,
      sha256: toHex(sha256Bytes(bytes)),
      created_at: new Date().toISOString(),
    })
    return { key: normalized, size: bytes.length, sha256: toHex(sha256Bytes(bytes)) }
  }

  async writeStream(key: string, chunks: AsyncIterable<Uint8Array>): Promise<BlobMeta> {
    const parts: Uint8Array[] = []
    let total = 0
    for await (const chunk of chunks) {
      parts.push(chunk)
      total += chunk.length
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      merged.set(part, offset)
      offset += part.length
    }
    return this.write(key, merged)
  }

  async read(key: string): Promise<Blob | null> {
    const row = await this.db.raw_blobs.get(normalizeKey(key))
    return row ? row.data : null
  }

  async readBytes(key: string): Promise<Uint8Array | null> {
    const row = await this.db.raw_blobs.get(normalizeKey(key))
    if (!row) return null
    return new Uint8Array(await row.data.arrayBuffer())
  }

  async exists(key: string): Promise<boolean> {
    const row = await this.db.raw_blobs.get(normalizeKey(key))
    return row !== undefined
  }

  async delete(key: string): Promise<boolean> {
    const normalized = normalizeKey(key)
    const existing = await this.db.raw_blobs.get(normalized)
    if (!existing) return false
    await this.db.raw_blobs.delete(normalized)
    return true
  }

  async list(prefix: string): Promise<string[]> {
    const normalized = normalizeKey(prefix)
    const keys = await this.db.raw_blobs.toCollection().primaryKeys()
    return keys
      .map((k) => String(k))
      .filter((k) => k.startsWith(normalized))
      .sort()
  }

  async stat(key: string): Promise<BlobMeta | null> {
    const row = await this.db.raw_blobs.get(normalizeKey(key))
    if (!row) return null
    return { key: row.key, size: row.size, sha256: row.sha256 }
  }

  async commit(tempKey: string, finalKey: string): Promise<BlobMeta> {
    const source = normalizeKey(tempKey)
    const target = normalizeKey(finalKey)
    const row = await this.db.raw_blobs.get(source)
    if (!row) {
      throw new Error(`commit 源对象不存在: ${source}`)
    }
    const bytes = new Uint8Array(await row.data.arrayBuffer())
    const meta = await this.write(target, bytes)
    await this.db.raw_blobs.delete(source)
    return meta
  }

  async usage(): Promise<number> {
    const rows = await this.db.raw_blobs.toArray()
    let total = 0
    for (const row of rows) total += row.size
    return total
  }

  async clear(): Promise<void> {
    await this.db.raw_blobs.clear()
  }
}
