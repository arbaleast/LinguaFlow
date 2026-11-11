/**
 * 本地凭据密文保险库（Web Crypto AES-GCM 256）单元测试。
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDatabase, openDatabase, type LinguaFlowDatabase } from '../../indexeddb/db'
import { CredentialVault, fromBase64, toBase64, VaultUnavailableError } from '../vault'

let db: LinguaFlowDatabase
let vault: CredentialVault

beforeEach(async () => {
  await closeDatabase()
  db = await openDatabase(`lf-vault-test-${Math.random().toString(36).slice(2)}`)
  vault = new CredentialVault(db)
})

afterEach(async () => {
  await closeDatabase()
})

describe('凭据保险库', () => {
  it('写入后表内只有密文，绝无明文 API Key', async () => {
    const secret = 'sk-proj-ABCDEF0123456789'
    const { localId } = await vault.put({
      provider: 'openai',
      name: 'my key',
      secret,
    })

    const row = await db.credential_vault.where('localId').equals(localId).first()
    expect(row).toBeDefined()
    expect(row?.versions).toHaveLength(1)
    expect(row?.versions[0]?.ciphertext).toBeTruthy()
    expect(row?.versions[0]?.nonce).toBeTruthy()

    // 整行序列化后不得出现明文
    const serialized = JSON.stringify(row)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('sk-proj-')
  })

  it('密文与 nonce 的 base64 可往返', () => {
    const bytes = new Uint8Array([0, 1, 250, 255])
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes])
  })

  it('解密后还原原始明文', async () => {
    const secret = 'sk-ant-秘密值 🎉'
    const { localId } = await vault.put({ provider: 'anthropic', name: 'k', secret })
    expect(await vault.reveal(localId)).toBe(secret)
  })

  it('同一明文两次加密得到不同密文（随机 nonce）', async () => {
    const a = await vault.encrypt('same')
    const b = await vault.encrypt('same')
    expect(a.nonce).not.toBe(b.nonce)
    expect(a.ciphertext).not.toBe(b.ciphertext)
    expect(await vault.decrypt(a)).toBe('same')
    expect(await vault.decrypt(b)).toBe('same')
  })

  it('主密钥不可导出', async () => {
    await vault.encrypt('x')
    const row = await db.kv_meta.get('vault_master_key')
    const key = row?.value as CryptoKey
    expect(key.extractable).toBe(false)
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 })
  })

  it('主密钥持久化后复用（重新打开保险库仍能解密）', async () => {
    const secret = 'sk-reuse'
    const first = await vault.put({ provider: 'openai', name: 'a', secret })
    const keyBefore = await db.kv_meta.get('vault_master_key')
    // 模拟页面刷新：新建保险库实例，主密钥从 IndexedDB 读回。
    const reloaded = new CredentialVault(db)
    const second = await reloaded.put({ provider: 'openai', name: 'b', secret })
    const keyAfter = await db.kv_meta.get('vault_master_key')

    // CryptoKey 经结构化克隆持久化，对象身份不同但算法参数一致。
    expect((keyBefore?.value as CryptoKey | undefined)?.algorithm).toEqual(
      (keyAfter?.value as CryptoKey | undefined)?.algorithm,
    )
    expect((keyAfter?.value as CryptoKey | undefined)?.extractable).toBe(false)
    // 复用同一主密钥 ⇒ 旧密文仍可解密
    expect(await reloaded.reveal(first.localId)).toBe(secret)
    expect(await reloaded.reveal(second.localId)).toBe(secret)
  })

  it('写入既有凭据时追加版本并推进 current_version', async () => {
    const first = await vault.put({ provider: 'openai', name: 'k', secret: 'v1' })
    const second = await vault.put({
      provider: 'openai',
      name: 'k',
      secret: 'v2',
      id: first.id,
    })
    expect(second.version).toBe(2)
    const row = await db.credential_vault.get(first.id)
    expect(row?.versions).toHaveLength(2)
    expect(row?.current_version).toBe(2)
    expect(await vault.reveal(first.localId)).toBe('v2')
  })

  it('吊销后拒绝解密', async () => {
    const { localId } = await vault.put({ provider: 'openai', name: 'k', secret: 'v' })
    expect(await vault.revoke(localId)).toBe(true)
    await expect(vault.reveal(localId)).rejects.toThrow(/已吊销/)
  })

  it('吊销不存在的凭据返回 false', async () => {
    await expect(vault.reveal(999)).rejects.toThrow(/不存在/)
    expect(await vault.revoke(999)).toBe(false)
  })

  it('密文被篡改时解密失败（AES-GCM 认证标签）', async () => {
    const envelope = await vault.encrypt('sensitive')
    const bytes = fromBase64(envelope.ciphertext)
    bytes[0] = (bytes[0] as number) ^ 0xff
    await expect(vault.decrypt({ ...envelope, ciphertext: toBase64(bytes) })).rejects.toBeTruthy()
  })
})

describe('保险库不可用时的行为', () => {
  it('crypto.subtle 缺失时抛 VaultUnavailableError（绝不退回明文落盘）', async () => {
    const original = globalThis.crypto
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: original.getRandomValues.bind(original) },
      configurable: true,
    })
    try {
      await expect(vault.encrypt('secret')).rejects.toBeInstanceOf(VaultUnavailableError)
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: original,
        configurable: true,
      })
    }
  })
})
