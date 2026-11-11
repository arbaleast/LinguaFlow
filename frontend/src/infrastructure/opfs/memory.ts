/**
 * 内存实现（二进制对象存储）。
 *
 * 用途：单元测试与无持久化环境（SSR / 隐私模式）。
 * 语义与 OPFS 实现一致：键归一化、流式写入、`commit` 原子落位。
 */
import { sha256Bytes } from '@/domain/shared/hash'
import { normalizeKey, type BlobMeta, type BlobStore } from './types'

/** 内存实现。 */
export class MemoryBlobStore implements BlobStore {
  readonly kind = 'memory' as const
  private readonly files = new Map<string, Uint8Array<ArrayBuffer>>()

  async write(key: string, data: Blob | ArrayBuffer | Uint8Array | string): Promise<BlobMeta> {
    return this.put(normalizeKey(key), await toBytes(data))
  }

  /** 内部写入（字节数组）。 */
  private put(key: string, bytes: Uint8Array<ArrayBuffer>): BlobMeta {
    this.files.set(key, bytes)
    return metaOf(key, bytes)
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
    return this.put(normalizeKey(key), merged)
  }

  async read(key: string): Promise<Blob | null> {
    const bytes = this.files.get(normalizeKey(key))
    if (!bytes) return null
    return new Blob([bytes])
  }

  async readBytes(key: string): Promise<Uint8Array | null> {
    return this.files.get(normalizeKey(key)) ?? null
  }

  async exists(key: string): Promise<boolean> {
    return this.files.has(normalizeKey(key))
  }

  async delete(key: string): Promise<boolean> {
    return this.files.delete(normalizeKey(key))
  }

  async list(prefix: string): Promise<string[]> {
    const normalized = normalizeKey(prefix)
    return [...this.files.keys()].filter((k) => k.startsWith(normalized)).sort()
  }

  async stat(key: string): Promise<BlobMeta | null> {
    const bytes = this.files.get(normalizeKey(key))
    if (!bytes) return null
    return metaOf(normalizeKey(key), bytes)
  }

  async commit(tempKey: string, finalKey: string): Promise<BlobMeta> {
    const source = normalizeKey(tempKey)
    const target = normalizeKey(finalKey)
    const bytes = this.files.get(source)
    if (!bytes) {
      throw new Error(`commit 源对象不存在: ${source}`)
    }
    this.files.set(target, bytes)
    this.files.delete(source)
    return metaOf(target, bytes)
  }

  async usage(): Promise<number> {
    let total = 0
    for (const bytes of this.files.values()) total += bytes.length
    return total
  }

  async clear(): Promise<void> {
    this.files.clear()
  }
}

/** 计算对象元数据。 */
export function metaOf(key: string, bytes: Uint8Array): BlobMeta {
  return {
    key,
    size: bytes.length,
    sha256: toHex(sha256Bytes(bytes)),
  }
}

/** 把各种输入形态归一为字节数组。 */
export async function toBytes(
  data: Blob | ArrayBuffer | Uint8Array | string,
): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data)
  }
  if (data instanceof Uint8Array) {
    // 复制到普通 ArrayBuffer：Blob/BufferSource 只接受 ArrayBuffer 支撑的视图。
    return new Uint8Array(data)
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }
  // Blob
  return new Uint8Array(await data.arrayBuffer())
}

/** 字节数组 → 小写十六进制。 */
export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}
