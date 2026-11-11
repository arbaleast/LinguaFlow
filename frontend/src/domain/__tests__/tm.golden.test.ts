/**
 * `domain/tm` 黄金向量对拍测试。
 *
 * 期望值来自 Go `backend/internal/tm` 的真实匹配/排序语义
 * （由 `backend/internal/tm/golden_vectors_test.go` 导出；Go 侧用纯内存记录
 * 列表复刻 `sqlite.go` 的 WHERE/ORDER，`source_hash` 仍走生产 `hash.Full`）。
 */
import { describe, expect, it } from 'vitest'
import tmFixture from '../__fixtures__/tm.json'
import {
  goTrimSpace,
  MemoryTmStore,
  nopTranslationMemory,
  ScopedTranslationMemory,
  scopeKey,
  sourceHash,
  type TmEntry,
} from '../tm'
import { argNumber, argString, runGolden, type GoldenFixture } from './helpers/golden'

const fixture = tmFixture as unknown as GoldenFixture

/** 把黄金向量里的种子记录还原为存储条目（`sourceHash` 由领域层计算）。 */
function argSeeds(args: Record<string, unknown>, key: string): TmEntry[] {
  const value = args[key]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new Error(`黄金向量参数 "${key}" 期望为数组`)
  }
  return (value as Array<Record<string, unknown>>).map((raw) => {
    const sourceText = goTrimSpace(String(raw.sourceText ?? ''))
    return {
      id: Number(raw.id ?? 0),
      projectId: Number(raw.projectId ?? 0),
      sourceHash: sourceHash(sourceText),
      sourceText,
      targetText: String(raw.targetText ?? ''),
      sourceLang: String(raw.sourceLang ?? ''),
      targetLang: String(raw.targetLang ?? ''),
      usageCount: Number(raw.usageCount ?? 0),
    }
  })
}

/** 构造绑定作用域的领域对象。 */
function buildTM(args: Record<string, unknown>): {
  store: MemoryTmStore
  tm: ScopedTranslationMemory
} {
  const store = new MemoryTmStore(argSeeds(args, 'entries'))
  const tm = new ScopedTranslationMemory(store, { projectId: argNumber(args, 'projectId') })
  return { store, tm }
}

describe('domain/tm 黄金向量', () => {
  it('覆盖全部黄金向量', () => {
    runGolden(fixture, {
      'tm.source_hash': (args) => ({ hash: sourceHash(argString(args, 'src')) }),

      'tm.scope': (args) => {
        const result = scopeKey({ projectId: argNumber(args, 'projectId') })
        return result.ok ? { ok: true, key: result.value } : { ok: false, error: true }
      },

      'tm.search': (args) => {
        const { store, tm } = buildTM(args)
        const times = argNumber(args, 'times')
        let matches: unknown[] = []
        for (let i = 0; i < times; i++) {
          const result = tm.search(
            argString(args, 'src'),
            argString(args, 'srcLang'),
            argString(args, 'tgtLang'),
          )
          if (!result.ok) return { ok: false, error: true }
          matches = result.value
        }
        return {
          ok: true,
          matches,
          usage: store.snapshot().map((entry) => ({
            id: entry.id,
            usageCount: entry.usageCount,
          })),
        }
      },

      'tm.add': (args) => {
        const { store, tm } = buildTM(args)
        const result = tm.add(
          argString(args, 'src'),
          argString(args, 'tgt'),
          argString(args, 'srcLang'),
          argString(args, 'tgtLang'),
        )
        return { ok: result.ok, error: !result.ok, entries: store.snapshot() }
      },

      'tm.nop': () => {
        const result = nopTranslationMemory.search('anything', 'en', 'zh')
        return { ok: true, matches: result.ok ? result.value : [] }
      },
    })
  })

  it('所有命中的 score 恒为 1（完全相等匹配）', () => {
    const searchCases = fixture.cases.filter((c) => c.op === 'tm.search' && c.expect.ok === true)
    expect(searchCases.length).toBeGreaterThan(0)
    for (const testCase of searchCases) {
      const matches = testCase.expect.matches as Array<{ score: unknown }>
      for (const match of matches) {
        expect(match.score, `用例 ${testCase.id} 的 score 应为 1`).toBe(1)
      }
    }
  })

  it('source_hash 恒为 64 位小写十六进制', () => {
    const hashCases = fixture.cases.filter((c) => c.op === 'tm.source_hash')
    expect(hashCases.length).toBeGreaterThan(0)
    for (const testCase of hashCases) {
      const hash = testCase.expect.hash as string
      expect(hash.length, `用例 ${testCase.id} 的哈希长度`).toBe(64)
      for (const ch of hash) {
        expect(
          '0123456789abcdef'.includes(ch),
          `用例 ${testCase.id} 的哈希出现非小写十六进制字符`,
        ).toBe(true)
      }
      expect(sourceHash(argString(testCase.args, 'src'))).toBe(hash)
    }
  })

  it('Search 只对命中行累加 usageCount', () => {
    const searchCases = fixture.cases.filter((c) => c.op === 'tm.search' && c.expect.ok === true)
    expect(searchCases.length).toBeGreaterThan(0)
    for (const testCase of searchCases) {
      const times = argNumber(testCase.args, 'times')
      const matches = testCase.expect.matches as Array<{ source: string; target: string }>
      const matched = new Set(matches.map((m) => `${m.source}\u0000${m.target}`))
      const seeds = testCase.args.entries as Array<Record<string, unknown>>
      const seedById = new Map(seeds.map((s) => [Number(s.id), s]))
      const usage = testCase.expect.usage as Array<{ id: number; usageCount: number }>
      for (const row of usage) {
        const seed = seedById.get(row.id)
        const before = Number(seed?.usageCount ?? 0)
        const key = `${goTrimSpace(String(seed?.sourceText ?? ''))}\u0000${String(seed?.targetText ?? '')}`
        const expected = matched.has(key) ? before + times : before
        expect(row.usageCount, `用例 ${testCase.id} 的条目 ${row.id} 计数不符`).toBe(expected)
      }
    }
  })
})
