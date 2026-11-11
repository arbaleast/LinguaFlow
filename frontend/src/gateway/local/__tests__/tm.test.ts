/**
 * 翻译记忆 Repository 单元测试（fake-indexeddb）。
 *
 * 覆盖：`sourceHash` 复用、精确语言对匹配、usage_count 回写、
 * `usage_count DESC, localId ASC` 排序、add 的新建/更新/noop/空值忽略。
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeDatabase, openDatabase, type LinguaFlowDatabase } from '@/infrastructure/indexeddb/db'
import { getDeviceId, newRow } from '@/infrastructure/indexeddb/repo'
import type { BaseRow, TmEntryRow } from '@/infrastructure/indexeddb/types'
import { sourceHash } from '@/domain/tm'

import { RepositoryConflictError, RepositoryNotFoundError } from '../repositories/errors'
import { createProject } from '../repositories/projects'
import { addTm, searchTm } from '../repositories/tm'

let db: LinguaFlowDatabase
let projectId: number

beforeEach(async () => {
  await closeDatabase()
  db = await openDatabase(`lf-tm-${Math.random().toString(36).slice(2)}`)
  projectId = (await createProject(db, { name: 'tm' })).localId
})

afterEach(async () => {
  await closeDatabase()
})

/** 直接造一条 TM 行（用于构造排序 / 历史脏数据场景）。 */
async function insertTm(
  projectIdValue: number,
  source: string,
  target: string,
  sourceLang: string,
  targetLang: string,
  usageCount: number,
): Promise<TmEntryRow> {
  const deviceId = await getDeviceId(db)
  const row = await newRow<Omit<TmEntryRow, keyof BaseRow>>(db, {
    sequence: 'tm_entry',
    deviceId,
    fields: {
      project_id: projectIdValue,
      source_text: source,
      target_text: target,
      source_lang: sourceLang,
      target_lang: targetLang,
      source_hash: sourceHash(source),
      usage_count: usageCount,
    },
  })
  await db.tm_entries.put(row)
  return row
}

describe('tm Repository — addTm', () => {
  it('新建时 trim 字段并使用 domain 的 sourceHash', async () => {
    const row = await addTm(db, projectId, {
      source_text: '  Hello world  ',
      target_text: '  你好世界  ',
      source_lang: '  en ',
      target_lang: ' zh  ',
    })

    expect(row).not.toBeNull()
    expect(row?.source_text).toBe('Hello world')
    expect(row?.target_text).toBe('你好世界')
    expect(row?.source_lang).toBe('en')
    expect(row?.target_lang).toBe('zh')
    expect(row?.source_hash).toBe(sourceHash('Hello world'))
    expect(row?.source_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row?.usage_count).toBe(0)
    expect(row?.localId).toBe(1)
  })

  it('完全一致的重复 add 是 noop（不增行、不改 revision）', async () => {
    const first = await addTm(db, projectId, {
      source_text: 'Hello',
      target_text: '你好',
      source_lang: 'en',
      target_lang: 'zh',
    })
    const second = await addTm(db, projectId, {
      source_text: ' Hello ',
      target_text: ' 你好 ',
      source_lang: 'en',
      target_lang: 'zh',
    })

    expect(second?.localId).toBe(first?.localId)
    expect(second?.revision).toBe(first?.revision)
    expect(await db.tm_entries.count()).toBe(1)
  })

  it('同键不同译文时更新文本并递增 revision', async () => {
    const first = await addTm(db, projectId, {
      source_text: 'Hello',
      target_text: '你好',
      source_lang: 'en',
      target_lang: 'zh',
    })
    const updated = await addTm(db, projectId, {
      source_text: 'Hello',
      target_text: '您好',
      source_lang: 'en',
      target_lang: 'zh',
    })

    expect(updated?.localId).toBe(first?.localId)
    expect(updated?.target_text).toBe('您好')
    expect(updated?.revision).toBe((first?.revision ?? 0) + 1)
    expect(await db.tm_entries.count()).toBe(1)
  })

  it('任一字段为空时静默忽略并返回 null', async () => {
    expect(
      await addTm(db, projectId, {
        source_text: '   ',
        target_text: 'x',
        source_lang: 'en',
        target_lang: 'zh',
      }),
    ).toBeNull()
    expect(
      await addTm(db, projectId, {
        source_text: 'x',
        target_text: 'y',
        source_lang: '',
        target_lang: 'zh',
      }),
    ).toBeNull()
    expect(await db.tm_entries.count()).toBe(0)
  })

  it('项目不存在时抛 404 语义错误', async () => {
    await expect(
      addTm(db, 999, {
        source_text: 'x',
        target_text: 'y',
        source_lang: 'en',
        target_lang: 'zh',
      }),
    ).rejects.toBeInstanceOf(RepositoryNotFoundError)
  })

  it('同键多行（历史脏数据）抛 409', async () => {
    await addTm(db, projectId, {
      source_text: 'dup',
      target_text: 'a',
      source_lang: 'en',
      target_lang: 'zh',
    })
    await insertTm(projectId, 'dup', 'b', 'en', 'zh', 0)

    await expect(
      addTm(db, projectId, {
        source_text: 'dup',
        target_text: 'c',
        source_lang: 'en',
        target_lang: 'zh',
      }),
    ).rejects.toBeInstanceOf(RepositoryConflictError)
  })
})

describe('tm Repository — searchTm', () => {
  it('精确匹配 source_hash + 语言对，命中后 usage_count +1', async () => {
    await addTm(db, projectId, {
      source_text: 'Hello',
      target_text: '你好',
      source_lang: 'en',
      target_lang: 'zh',
    })
    await addTm(db, projectId, {
      source_text: 'Hello',
      target_text: 'Bonjour',
      source_lang: 'en',
      target_lang: 'fr',
    })

    const hits = await searchTm(db, projectId, {
      source: '  Hello  ',
      source_lang: ' en ',
      target_lang: ' zh ',
    })

    expect(hits).toHaveLength(1)
    expect(hits[0]?.target_text).toBe('你好')
    expect(hits[0]?.usage_count).toBe(1)

    const persisted = await db.tm_entries
      .where('localId')
      .equals(hits[0]?.localId ?? 0)
      .first()
    expect(persisted?.usage_count).toBe(1)
  })

  it('语言对不匹配 / 无命中返回空数组且不改计数', async () => {
    await addTm(db, projectId, {
      source_text: 'Hello',
      target_text: '你好',
      source_lang: 'en',
      target_lang: 'zh',
    })

    expect(
      await searchTm(db, projectId, {
        source: 'Hello',
        source_lang: 'en',
        target_lang: 'fr',
      }),
    ).toEqual([])
    expect(
      await searchTm(db, projectId, {
        source: 'Missing',
        source_lang: 'en',
        target_lang: 'zh',
      }),
    ).toEqual([])

    const row = await db.tm_entries.toCollection().first()
    expect(row?.usage_count).toBe(0)
  })

  it('按 usage_count DESC, localId ASC 排序（平局用 localId）', async () => {
    const low = await addTm(db, projectId, {
      source_text: 'Same',
      target_text: 'low',
      source_lang: 'en',
      target_lang: 'zh',
    })
    const high = await insertTm(projectId, 'Same', 'high', 'en', 'zh', 3)
    const high2 = await insertTm(projectId, 'Same', 'high2', 'en', 'zh', 3)

    const first = await searchTm(db, projectId, {
      source: 'Same',
      source_lang: 'en',
      target_lang: 'zh',
    })

    expect(first.map((row) => row.localId)).toEqual([high.localId, high2.localId, low?.localId])
    expect(first.map((row) => row.usage_count)).toEqual([4, 4, 1])

    // 第二次查询：计数全部 +1，排序保持稳定。
    const second = await searchTm(db, projectId, {
      source: 'Same',
      source_lang: 'en',
      target_lang: 'zh',
    })
    expect(second.map((row) => row.localId)).toEqual([high.localId, high2.localId, low?.localId])
    expect(second.map((row) => row.usage_count)).toEqual([5, 5, 2])
  })

  it('过滤墓碑（软删行不参与匹配）', async () => {
    const row = await addTm(db, projectId, {
      source_text: 'Gone',
      target_text: '没了',
      source_lang: 'en',
      target_lang: 'zh',
    })
    if (!row) throw new Error('addTm 应返回新建行')
    await db.tm_entries.put({ ...row, deletedAt: new Date().toISOString() })

    expect(
      await searchTm(db, projectId, {
        source: 'Gone',
        source_lang: 'en',
        target_lang: 'zh',
      }),
    ).toEqual([])
  })
})
