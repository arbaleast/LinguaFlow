/**
 * 二进制对象存储（OPFS / IndexedDB 降级 / 内存）单元测试。
 *
 * Node 环境下没有 OPFS，故主路径用 **IndexedDB 降级实现**（`fake-indexeddb`）验证；
 * 同时用内存实现验证三种实现的**语义一致性**。
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDatabase, openDatabase, type LinguaFlowDatabase } from '../../indexeddb/db'
import { IndexedDbBlobStore } from '../idb'
import { MemoryBlobStore } from '../memory'
import { createBlobStore, isOpfsSupported } from '../index'
import { normalizeKey, objectKey, tempKey, type BlobStore } from '../types'
import { fullHash } from '@/domain/shared/hash'

let db: LinguaFlowDatabase

beforeEach(async () => {
  await closeDatabase()
  db = await openDatabase(`lf-blob-test-${Math.random().toString(36).slice(2)}`)
})

afterEach(async () => {
  await closeDatabase()
})

/** 在两种实现上跑同一组断言，保证语义一致。 */
const implementations = (): Array<[string, () => BlobStore]> => [
  ['memory', () => new MemoryBlobStore()],
  ['idb', () => new IndexedDbBlobStore(db)],
]

describe.each(implementations())('二进制对象存储（%s）', (_name, create) => {
  it('写入后可读回字节，且 sha256 与内容一致', async () => {
    const store = create()
    const key = objectKey('space-1', 42, 'uuid-a')
    const payload = new TextEncoder().encode('hello 世界 🎉')
    const meta = await store.write(key, payload)

    expect(meta.key).toBe(key)
    expect(meta.size).toBe(payload.length)
    expect(meta.sha256).toBe(fullHash('hello 世界 🎉'))

    const bytes = await store.readBytes(key)
    expect(bytes).not.toBeNull()
    expect([...(bytes as Uint8Array)]).toEqual([...payload])
  })

  it('读取不存在的键返回 null', async () => {
    const store = create()
    expect(await store.read('objects/x/1/missing')).toBeNull()
    expect(await store.readBytes('objects/x/1/missing')).toBeNull()
    expect(await store.stat('objects/x/1/missing')).toBeNull()
    expect(await store.exists('objects/x/1/missing')).toBe(false)
  })

  it('流式写入的结果与一次性写入一致', async () => {
    const store = create()
    const chunks = [new TextEncoder().encode('abc'), new TextEncoder().encode('def')]
    const meta = await store.writeStream(
      'objects/s/1/stream',
      (async function* () {
        for (const c of chunks) yield c
      })(),
    )
    expect(meta.size).toBe(6)
    expect(meta.sha256).toBe(fullHash('abcdef'))
    const bytes = await store.readBytes('objects/s/1/stream')
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe('abcdef')
  })

  it('按前缀列举对象键', async () => {
    const store = create()
    await store.write('objects/s/1/a', 'a')
    await store.write('objects/s/1/b', 'b')
    await store.write('objects/s/2/c', 'c')
    await store.write('cache/x', 'x')

    const listed = await store.list('objects/s/1')
    expect(listed).toEqual(['objects/s/1/a', 'objects/s/1/b'])
  })

  it('删除对象返回是否确实删除', async () => {
    const store = create()
    await store.write('objects/s/1/a', 'a')
    expect(await store.delete('objects/s/1/a')).toBe(true)
    expect(await store.delete('objects/s/1/a')).toBe(false)
  })

  it('commit 把 tmp 候选原子落位到 objects（源键消失）', async () => {
    const store = create()
    const tmp = tempKey('write-1')
    const target = objectKey('space-1', 7, 'uuid-b')
    await store.write(tmp, 'candidate')

    const meta = await store.commit(tmp, target)
    expect(meta.key).toBe(target)
    expect(meta.sha256).toBe(fullHash('candidate'))
    expect(await store.exists(tmp)).toBe(false)
    expect(await store.exists(target)).toBe(true)
    expect(new TextDecoder().decode((await store.readBytes(target)) as Uint8Array)).toBe(
      'candidate',
    )
  })

  it('commit 源对象不存在时报错', async () => {
    const store = create()
    await expect(store.commit('tmp/none/x', 'objects/s/1/y')).rejects.toThrow(/源对象不存在/)
  })

  it('usage 汇总所有对象字节数', async () => {
    const store = create()
    await store.write('objects/s/1/a', 'abcd')
    await store.write('objects/s/1/b', 'ef')
    expect(await store.usage()).toBe(6)
  })

  it('clear 清空所有对象', async () => {
    const store = create()
    await store.write('objects/s/1/a', 'a')
    await store.clear()
    expect(await store.list('')).toEqual([])
    expect(await store.usage()).toBe(0)
  })

  it('拒绝含路径穿越的键', async () => {
    const store = create()
    await expect(store.write('objects/../../etc/passwd', 'x')).rejects.toThrow(/路径穿越/)
  })
})

describe('键归一化', () => {
  it('去掉前导与重复分隔符', () => {
    expect(normalizeKey('/objects//s/1/a')).toBe('objects/s/1/a')
    expect(normalizeKey('objects/./s/1/a')).toBe('objects/s/1/a')
  })

  it('拒绝 .. 穿越', () => {
    expect(() => normalizeKey('objects/../x')).toThrow(/路径穿越/)
  })

  it('objectKey / tempKey 复刻后端布局', () => {
    expect(objectKey('space-1', 42, 'uuid')).toBe('objects/space-1/42/uuid')
    expect(tempKey('w1')).toBe('tmp/w1/blob')
  })
})

describe('工厂选择', () => {
  it('Node 环境无 OPFS 时选择 IndexedDB 降级实现', () => {
    expect(isOpfsSupported()).toBe(false)
    const store = createBlobStore({ db })
    expect(store.kind).toBe('idb')
  })

  it('forceMemory 时选择内存实现', () => {
    expect(createBlobStore({ forceMemory: true }).kind).toBe('memory')
  })
})
