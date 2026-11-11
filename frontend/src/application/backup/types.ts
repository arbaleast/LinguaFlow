/**
 * 本地备份的数据契约。
 *
 * 备份是**浏览器本地数据**的完整快照，用于：
 *
 * - 用户手动导出留存（GDPR 式的「可携带」能力）；
 * - 换设备 / 换浏览器时恢复；
 * - 升级 Schema 前的安全快照。
 *
 * ## 安全纪律
 *
 * `credential_vault` 表保存的是 **AES-GCM 密文**，其主密钥在 `kv_meta`
 * 里以**不可导出**的 `CryptoKey` 形态持久化。因此：
 *
 * - 默认导出**完全跳过** `credential_vault`（`manifest.credentialVault = 'skipped'`）；
 * - 显式要求包含时**必须**提供口令，密文会用口令派生的密钥二次加密
 *   （`manifest.credentialVault = 'encrypted'`）；
 * - **绝不**把 `kv_meta` 里的主密钥以字节形式导出（它本来就不可导出）。
 */
import type { TableName } from '@/infrastructure/indexeddb/db'

/** 备份文件格式标识。 */
export const BACKUP_FORMAT = 'linguaflow.local.backup'

/** 备份容器格式版本（与数据库 Schema 版本无关）。 */
export const BACKUP_FORMAT_VERSION = 1

/** 凭据保险库在备份中的处理方式。 */
export type CredentialVaultMode = 'skipped' | 'encrypted'

/** 二进制内容在备份中的处理方式。 */
export type BlobContentMode = 'skipped' | 'inline'

/** 备份清单（随包保存，导入时用于校验）。 */
export interface BackupManifest {
  /** 固定为 {@link BACKUP_FORMAT}。 */
  format: typeof BACKUP_FORMAT
  /** 备份容器格式版本。 */
  formatVersion: number
  /** 导出时的数据库 Schema 版本。 */
  schemaVersion: number
  /** 导出时间（ISO-8601）。 */
  createdAt: string
  /** 参与备份的表名（有序）。 */
  tables: TableName[]
  /** 每张表的行数。 */
  counts: Record<string, number>
  /** 凭据保险库的处理方式。 */
  credentialVault: CredentialVaultMode
  /** 二进制内容（`raw_blobs`）的处理方式。 */
  blobs: BlobContentMode
}

/** 口令派生的密钥参数。 */
export interface BackupKdfParams {
  /** 迭代次数。 */
  iterations: number
  /** 摘要算法。 */
  hash: 'SHA-256'
}

/** 被口令加密的凭据保险库负载。 */
export interface EncryptedCredentialPayload {
  /** base64 的 PBKDF2 盐。 */
  salt: string
  /** base64 的 AES-GCM IV（12 字节）。 */
  iv: string
  /** base64 的密文。 */
  ciphertext: string
  /** 密钥派生参数。 */
  kdf: BackupKdfParams
}

/** 备份包（JSON 形态）。 */
export interface BackupBundle {
  manifest: BackupManifest
  /** 表名 → 行数组。 */
  data: Record<string, unknown[]>
  /** 仅当 `manifest.credentialVault === 'encrypted'` 时存在。 */
  credentialVault?: EncryptedCredentialPayload
}

/** 导出选项。 */
export interface BackupExportOptions {
  /**
   * 是否包含凭据保险库。
   *
   * `true` 时**必须**同时提供 `passphrase`，否则抛错。
   */
  includeSecrets?: boolean
  /** 用于加密凭据保险库的口令。 */
  passphrase?: string
  /**
   * 是否内联 `raw_blobs` 的二进制内容（base64）。
   *
   * 默认 `false`——大文件应留在 OPFS，仅备份其元数据。
   */
  includeBlobs?: boolean
}

/** 导入选项。 */
export interface BackupImportOptions {
  /** 解密凭据保险库所需的口令（备份含密文时必填）。 */
  passphrase?: string
  /**
   * 是否先清空目标库再写入。
   *
   * 默认 `true`（整库替换）。`false` 时按主键合并（已存在的主键被覆盖）。
   */
  replace?: boolean
}

/** 导入结果。 */
export interface BackupImportResult {
  /** 实际写入的表 → 行数。 */
  counts: Record<string, number>
  /** 是否写入了凭据保险库。 */
  credentialsRestored: boolean
  /** 跳过的表（及其原因）。 */
  skipped: Array<{ table: string; reason: string }>
}

/** 备份 / 恢复过程中抛出的错误。 */
export class BackupError extends Error {
  constructor(
    /** 错误码。 */
    readonly code: BackupErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'BackupError'
  }
}

/** 备份错误码。 */
export type BackupErrorCode =
  | 'invalid_format'
  | 'unsupported_format_version'
  | 'schema_version_mismatch'
  | 'missing_passphrase'
  | 'invalid_passphrase'
  | 'corrupt_payload'
  | 'unsupported_operation'
