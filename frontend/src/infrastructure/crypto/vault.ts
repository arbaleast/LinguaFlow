/**
 * 本地 API Key 密文保险库（Web Crypto AES-GCM 256）。
 *
 * ## 安全纪律
 *
 * 1. **明文 API Key 绝不进 IndexedDB**。写入路径只接受明文，落到表里的
 *    只有 `ciphertext` / `nonce` / `key_id`（对应后端 `CredentialVersion` 的 AEAD 密文）。
 * 2. **密文不可回读给 UI**（对齐 `stores/credentials.ts:59` 的
 *    「secrets write-only 永不回读」纪律）：`decrypt` 只供**本地执行引擎内部**
 *    在真正调用 AI 后端前解密使用；对外只暴露「是否已配置」的布尔信息。
 * 3. **主密钥不可导出**：用 `crypto.subtle.generateKey(..., extractable=false)` 生成
 *    AES-GCM 256 主密钥，存入 IndexedDB `kv_meta`。密钥对象经结构化克隆持久化，
 *    **无法通过 JS 读出原始字节**，即使数据库文件被复制也无法直接解密。
 *
 * ## 降级
 *
 * `crypto.subtle` 不可用（极旧环境 / 非安全上下文）时，
 * `encrypt` 抛 `VaultUnavailableError`，**绝不**退回明文落盘。
 */
import type { LinguaFlowDatabase } from '../indexeddb/db'
import { newId, nowIso } from '../indexeddb/repo'

/** 主密钥在 `kv_meta` 中的键名。 */
const MASTER_KEY_ID = 'vault_master_key'

/** AES-GCM 密钥长度（位）。 */
const KEY_LENGTH = 256

/** AES-GCM 推荐的 nonce 长度（字节）。 */
const NONCE_LENGTH = 12

/** 保险库不可用（非安全上下文 / 无 WebCrypto）。 */
export class VaultUnavailableError extends Error {
  constructor(message = '当前环境不支持 Web Crypto（crypto.subtle 不可用）') {
    super(message)
    this.name = 'VaultUnavailableError'
  }
}

/** 密文信封（写入 `credential_vault` 表的形态）。 */
export interface VaultSecret {
  /** AES-GCM 密文（base64，含 16 字节 auth tag）。 */
  ciphertext: string
  /** 随机 nonce（base64）。 */
  nonce: string
  /** 派生密钥标识。 */
  key_id: string
}

/** 取得 `crypto.subtle`（不可用时抛 `VaultUnavailableError`）。 */
function requireSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new VaultUnavailableError()
  }
  return subtle
}

/** 字节数组 → base64。 */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

/** base64 → 字节数组。 */
export function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** 本地密文保险库。 */
export class CredentialVault {
  constructor(private readonly db: LinguaFlowDatabase) {}

  /**
   * 取得（或创建）主密钥。
   *
   * 密钥以 **不可导出** 的 `CryptoKey` 形态存放在 `kv_meta`；
   * 结构化克隆持久化后无法通过 JS 取回原始字节。
   */
  private async masterKey(): Promise<CryptoKey> {
    const subtle = requireSubtle()
    const row = await this.db.kv_meta.get(MASTER_KEY_ID)
    const existing = row?.value
    if (existing && typeof existing === 'object' && 'type' in existing) {
      const key = existing as CryptoKey
      if (key.type === 'secret' && key.algorithm.name === 'AES-GCM') {
        return key
      }
    }
    const key = await subtle.generateKey({ name: 'AES-GCM', length: KEY_LENGTH }, false, [
      'encrypt',
      'decrypt',
    ])
    await this.db.kv_meta.put({
      key: MASTER_KEY_ID,
      value: key,
      updated_at: nowIso(),
    })
    return key
  }

  /** 加密明文（返回可持久化的密文信封）。 */
  async encrypt(plaintext: string, keyId = 'default'): Promise<VaultSecret> {
    const subtle = requireSubtle()
    const key = await this.masterKey()
    const nonce = new Uint8Array(NONCE_LENGTH)
    globalThis.crypto.getRandomValues(nonce)
    const data = new TextEncoder().encode(plaintext)
    const cipher = new Uint8Array(
      await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, data as unknown as BufferSource),
    )
    return {
      ciphertext: toBase64(cipher),
      nonce: toBase64(nonce),
      key_id: keyId,
    }
  }

  /** 解密密文信封。 */
  async decrypt(secret: VaultSecret): Promise<string> {
    const subtle = requireSubtle()
    const key = await this.masterKey()
    const nonce = fromBase64(secret.nonce)
    const cipher = fromBase64(secret.ciphertext)
    const plain = await subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(nonce) },
      key,
      new Uint8Array(cipher),
    )
    return new TextDecoder().decode(plain)
  }

  /**
   * 写入一条凭据（**只存密文**）。
   *
   * @returns 凭据行的 `localId`（对外 ID）与 `version`（版本号）。
   */
  async put(options: {
    provider: string
    name: string
    /** 明文 API Key。 */
    secret: string
    /** 凭据行 ID（续写既有凭据时传入）。 */
    id?: string
  }): Promise<{ localId: number; id: string; version: number }> {
    const deviceId = await this.deviceId()
    const envelope = await this.encrypt(options.secret)
    const at = nowIso()
    const existing = options.id ? await this.db.credential_vault.get(options.id) : undefined
    // 版本号在既有凭据上递增（与后端 `CredentialVersion` 的版本推进一致）。
    const version = existing ? existing.current_version + 1 : 1

    if (existing) {
      const versions = [
        ...existing.versions.map((v) =>
          v.version === existing.current_version ? { ...v, revoked: true } : v,
        ),
        { version, ...envelope, created_at: at, revoked: false },
      ]
      await this.db.credential_vault.put({
        ...existing,
        name: options.name,
        provider: options.provider,
        current_version: version,
        revoked: false,
        versions,
        revision: existing.revision + 1,
        updatedAt: at,
        deviceId,
        dirty: true,
      })
      return { localId: existing.localId, id: existing.id, version }
    }

    const localId = await this.nextLocalId('credential')
    const id = newId()
    await this.db.credential_vault.put({
      id,
      localId,
      name: options.name,
      provider: options.provider,
      current_version: version,
      revoked: false,
      versions: [{ version, ...envelope, created_at: at, revoked: false }],
      createdAt: at,
      updatedAt: at,
      revision: 1,
      deletedAt: null,
      deviceId,
      dirty: true,
    })
    return { localId, id, version }
  }

  /**
   * 解密并返回明文。
   *
   * **仅供本地执行引擎内部使用**；UI 不得调用本方法。
   */
  async reveal(localId: number): Promise<string> {
    const row = await this.db.credential_vault.where('localId').equals(localId).first()
    if (!row) throw new Error(`凭据不存在: ${localId}`)
    if (row.revoked) throw new Error(`凭据已吊销: ${localId}`)
    const current = row.versions.find((v) => v.version === row.current_version)
    if (!current) throw new Error(`凭据版本缺失: ${localId}#${row.current_version}`)
    return this.decrypt(current)
  }

  /** 吊销某个凭据（全部版本标记为已吊销）。 */
  async revoke(localId: number): Promise<boolean> {
    const row = await this.db.credential_vault.where('localId').equals(localId).first()
    if (!row) return false
    const deviceId = await this.deviceId()
    const at = nowIso()
    await this.db.credential_vault.put({
      ...row,
      revoked: true,
      versions: row.versions.map((v) => ({ ...v, revoked: true })),
      revision: row.revision + 1,
      updatedAt: at,
      deviceId,
      dirty: true,
    })
    return true
  }

  /** 取得（或创建）设备标识。 */
  private async deviceId(): Promise<string> {
    const { getDeviceId } = await import('../indexeddb/repo')
    return getDeviceId(this.db)
  }

  /** 分配自增 `localId`。 */
  private async nextLocalId(name: string): Promise<number> {
    const { nextLocalId: next } = await import('../indexeddb/repo')
    return next(this.db, name)
  }
}
