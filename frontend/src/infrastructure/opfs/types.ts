/**
 * 二进制对象存储的契约。
 *
 * ## 布局（对应后端 `objects/<space.Identity>/<projectID>/<uuid>`，service/storage.go:502）
 *
 * ```text
 * objects/<spaceIdentity>/<projectId>/<uuid>   # 源文件 / 导出 / 快照
 * tmp/<writeId>/                              # candidate → live 的原子落位
 * cache/                                      # 解析中间产物、字体缓存
 * ```
 *
 * ## 降级策略
 *
 * 1. **OPFS**（首选）：Origin Private File System，真文件系统语义与流式写入。
 * 2. **IndexedDB `raw_blobs`**：不支持 OPFS 时使用；与元数据表**物理隔离**，
 *    按 key 懒加载（`get` 单条取回），避免列表查询触发内存暴涨。
 * 3. **内存**：单元测试与无持久化环境。
 */

/** 二进制对象元数据。 */
export interface BlobMeta {
  /** 对象键（形如 `objects/<space>/<projectId>/<uuid>`）。 */
  key: string
  /** 字节数。 */
  size: number
  /** sha256 小写十六进制。 */
  sha256: string
}

/** 二进制对象存储。 */
export interface BlobStore {
  /** 实现类型（用于诊断与 UI 提示）。 */
  readonly kind: 'opfs' | 'idb' | 'memory'
  /** 写入（二进制或文本）。 */
  write(key: string, data: Blob | ArrayBuffer | Uint8Array | string): Promise<BlobMeta>
  /** 流式写入（逐块追加，不在内存里拼整个文件）。 */
  writeStream(key: string, chunks: AsyncIterable<Uint8Array>): Promise<BlobMeta>
  /** 读取完整对象。 */
  read(key: string): Promise<Blob | null>
  /** 读取为字节数组。 */
  readBytes(key: string): Promise<Uint8Array | null>
  /** 对象是否存在。 */
  exists(key: string): Promise<boolean>
  /** 删除对象；返回是否确实删除了。 */
  delete(key: string): Promise<boolean>
  /** 列出某前缀下的所有对象键。 */
  list(prefix: string): Promise<string[]>
  /** 读取对象元数据。 */
  stat(key: string): Promise<BlobMeta | null>
  /**
   * 原子落位：把 `tmp/<writeId>/…` 的候选内容移动到 `objects/…`。
   *
   * 语义与后端 `StorageWrite` 的 candidate → live 一致：
   * 目标键要么是旧内容，要么是新内容，**不会出现半写状态**。
   */
  commit(tempKey: string, finalKey: string): Promise<BlobMeta>
  /** 已用字节数总和。 */
  usage(): Promise<number>
  /** 清空所有对象。 */
  clear(): Promise<void>
}

/** 存储根目录名（与后端 `linguaflow/` 对应）。 */
export const BLOB_ROOT_DIR = 'linguaflow'

/** 源文件 / 导出 / 快照三类对象。 */
export type BlobPurpose = 'source' | 'export' | 'snapshot'

/** 构造 `objects/<spaceIdentity>/<projectId>/<uuid>` 形式的对象键。 */
export function objectKey(spaceIdentity: string, projectId: number | string, uuid: string): string {
  return `objects/${spaceIdentity}/${String(projectId)}/${uuid}`
}

/** 构造 `tmp/<writeId>/<name>` 形式的临时键。 */
export function tempKey(writeId: string, name = 'blob'): string {
  return `tmp/${writeId}/${name}`
}

/** 归一化对象键：去掉前导 `/`、折叠重复分隔符、拒绝 `..` 穿越。 */
export function normalizeKey(key: string): string {
  const parts = key.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.some((p) => p === '..')) {
    throw new Error(`blob key 含非法路径穿越: ${key}`)
  }
  return parts.join('/')
}
