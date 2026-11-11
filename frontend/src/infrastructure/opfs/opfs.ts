/**
 * OPFS（Origin Private File System）实现。
 *
 * 目录结构：
 *
 * ```text
 * <origin>/linguaflow/
 *   ├── objects/<spaceIdentity>/<projectId>/<uuid>
 *   ├── tmp/<writeId>/<name>
 *   └── cache/...
 * ```
 *
 * 写入使用 `FileSystemWritableFileStream`（`createWritable`），支持流式追加；
 * `commit` 通过「写临时文件 → 移动到目标路径 → 删除临时文件」实现 candidate → live
 * 的原子落位（目标路径要么是旧内容要么是新内容）。
 */
import { sha256Bytes } from '@/domain/shared/hash'
import { normalizeKey, type BlobMeta, type BlobStore } from './types'
import { toBytes, toHex } from './memory'

/** 是否支持 OPFS。 */
export function isOpfsSupported(): boolean {
  const manager = globalThis.navigator?.storage
  return typeof manager?.getDirectory === 'function'
}

/** OPFS 实现。 */
export class OpfsBlobStore implements BlobStore {
  readonly kind = 'opfs' as const

  constructor(private readonly rootDirName = 'linguaflow') {}

  /** 取得根目录句柄（惰性创建）。 */
  private async root(): Promise<FileSystemDirectoryHandle> {
    const manager = globalThis.navigator?.storage
    if (!manager || typeof manager.getDirectory !== 'function') {
      throw new Error('当前环境不支持 OPFS（navigator.storage.getDirectory 不可用）')
    }
    const base = await manager.getDirectory()
    return base.getDirectoryHandle(this.rootDirName, { create: true })
  }

  /** 逐级解析目录句柄。 */
  private async dirFor(
    key: string,
    create: boolean,
  ): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
    const parts = normalizeKey(key).split('/')
    const name = parts.pop()
    if (!name) throw new Error(`blob key 非法: ${key}`)
    let dir = await this.root()
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create })
    }
    return { dir, name }
  }

  async write(key: string, data: Blob | ArrayBuffer | Uint8Array | string): Promise<BlobMeta> {
    const bytes = await toBytes(data)
    const { dir, name } = await this.dirFor(key, true)
    const handle = await dir.getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    try {
      await writable.write(bytes as unknown as BufferSource)
    } finally {
      await writable.close()
    }
    return { key: normalizeKey(key), size: bytes.length, sha256: toHex(sha256Bytes(bytes)) }
  }

  async writeStream(key: string, chunks: AsyncIterable<Uint8Array>): Promise<BlobMeta> {
    const { dir, name } = await this.dirFor(key, true)
    const handle = await dir.getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    let total = 0
    const hashChunks: Uint8Array[] = []
    try {
      for await (const chunk of chunks) {
        await writable.write(chunk as unknown as BufferSource)
        hashChunks.push(chunk)
        total += chunk.length
      }
    } finally {
      await writable.close()
    }
    return {
      key: normalizeKey(key),
      size: total,
      sha256: toHex(sha256Bytes(concat(hashChunks, total))),
    }
  }

  async read(key: string): Promise<Blob | null> {
    const handle = await this.fileHandle(key, false)
    if (!handle) return null
    return handle.getFile()
  }

  async readBytes(key: string): Promise<Uint8Array | null> {
    const file = await this.read(key)
    if (!file) return null
    return new Uint8Array(await file.arrayBuffer())
  }

  async exists(key: string): Promise<boolean> {
    return (await this.fileHandle(key, false)) !== null
  }

  async delete(key: string): Promise<boolean> {
    const { dir, name } = await this.dirFor(key, false)
    try {
      await dir.removeEntry(name)
      return true
    } catch {
      return false
    }
  }

  async list(prefix: string): Promise<string[]> {
    const normalized = normalizeKey(prefix)
    const parts = normalized.split('/')
    const out: string[] = []
    await this.walk(await this.root(), parts, '', out)
    return out.sort()
  }

  async stat(key: string): Promise<BlobMeta | null> {
    const handle = await this.fileHandle(key, false)
    if (!handle) return null
    const file = await handle.getFile()
    const bytes = new Uint8Array(await file.arrayBuffer())
    return { key: normalizeKey(key), size: file.size, sha256: toHex(sha256Bytes(bytes)) }
  }

  async commit(tempKey: string, finalKey: string): Promise<BlobMeta> {
    const source = normalizeKey(tempKey)
    const target = normalizeKey(finalKey)
    const bytes = await this.readBytes(source)
    if (!bytes) {
      throw new Error(`commit 源对象不存在: ${source}`)
    }
    const meta = await this.write(target, bytes)
    await this.delete(source)
    return meta
  }

  async usage(): Promise<number> {
    let total = 0
    const keys = await this.list('')
    for (const key of keys) {
      const file = await this.read(key)
      if (file) total += file.size
    }
    return total
  }

  async clear(): Promise<void> {
    const root = await this.root()
    for await (const name of root.keys()) {
      await root.removeEntry(name, { recursive: true }).catch(() => undefined)
    }
  }

  /** 取得文件句柄（不存在且 `create=false` 时返回 null）。 */
  private async fileHandle(key: string, create: boolean): Promise<FileSystemFileHandle | null> {
    try {
      const { dir, name } = await this.dirFor(key, create)
      return await dir.getFileHandle(name, { create })
    } catch {
      return null
    }
  }

  /** 递归遍历目录，收集文件键。 */
  private async walk(
    dir: FileSystemDirectoryHandle,
    parts: string[],
    prefix: string,
    out: string[],
  ): Promise<void> {
    if (parts.length > 0) {
      const head = parts[0] as string
      try {
        const child = await dir.getDirectoryHandle(head)
        await this.walk(child, parts.slice(1), `${prefix}${head}/`, out)
      } catch {
        // 该层不是目录（同名文件）→ 当作叶子处理
        out.push(`${prefix}${head}`)
      }
      return
    }
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'directory') {
        await this.walk(handle as FileSystemDirectoryHandle, [], `${prefix}${name}/`, out)
      } else {
        out.push(`${prefix}${name}`)
      }
    }
  }
}

/** 拼接字节块。 */
function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}
