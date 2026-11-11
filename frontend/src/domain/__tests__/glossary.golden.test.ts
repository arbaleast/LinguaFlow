/**
 * `domain/glossary` 黄金向量对拍测试。
 *
 * 期望值全部来自 Go `backend/internal/glossary` 的真实输出
 * （由 `backend/internal/glossary/golden_vectors_test.go` 导出），
 * 本移植层必须与之 100% 一致。
 */
import { describe, expect, it } from 'vitest'
import glossaryFixture from '../__fixtures__/glossary.json'
import {
  addForRequest,
  caseInsensitiveReplace,
  FileGlossary,
  glossaryEntry,
  isCJKTarget,
  loadFile,
  newMemory,
  nopGlossary,
  safeReplace,
  type AddResult,
  type GlossaryEntry,
  type RequestAdder,
} from '../glossary'
import { argString, runGolden, type GoldenFixture } from './helpers/golden'

const fixture = glossaryFixture as unknown as GoldenFixture

/** 把黄金向量里的条目对象还原为领域层条目。 */
function toEntry(value: unknown): GlossaryEntry {
  const raw = value as Record<string, unknown>
  return {
    source: String(raw.source ?? ''),
    target: String(raw.target ?? ''),
    caseSensitive: Boolean(raw.caseSensitive),
    forbidden: Boolean(raw.forbidden),
    mandatory: Boolean(raw.mandatory),
    notes: String(raw.notes ?? ''),
  }
}

/** 读取条目数组参数（缺省为空数组）。 */
function argEntries(args: Record<string, unknown>, key: string): GlossaryEntry[] {
  const value = args[key]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new Error(`黄金向量参数 "${key}" 期望为数组`)
  }
  return value.map(toEntry)
}

/** 读取多轮 Add 参数。 */
function argRounds(args: Record<string, unknown>, key: string): GlossaryEntry[][] {
  const value = args[key]
  if (!Array.isArray(value)) {
    throw new Error(`黄金向量参数 "${key}" 期望为数组`)
  }
  return value.map((round) => (Array.isArray(round) ? round.map(toEntry) : []))
}

/** 以 content 建表：非空走 `loadFile`，空串走内存表（对齐 Go 的 Fixture 构造）。 */
function buildGlossary(content: string): FileGlossary {
  if (content === '') return newMemory()
  const loaded = loadFile(content, 'g.csv')
  if (!loaded.ok) {
    throw new Error(`黄金向量种子 CSV 解析失败: ${loaded.error.message}`)
  }
  return loaded.value
}

/** 带 RequestAdder 能力的测试替身（对应 Go 侧 requestAwareGolden）。 */
class RequestAwareFileGlossary extends FileGlossary implements RequestAdder {
  awareCalls = 0

  addForRequest(_requestID: string, ...entries: GlossaryEntry[]): AddResult {
    this.awareCalls++
    return this.add(...entries)
  }
}

describe('domain/glossary 黄金向量', () => {
  it('覆盖全部黄金向量', () => {
    runGolden(fixture, {
      'glossary.load_csv': (args) => {
        const result = loadFile(argString(args, 'content'), 'g.csv')
        if (!result.ok) return { ok: false, error: true }
        return {
          ok: true,
          entries: result.value.snapshotEntries(),
          sources: result.value.snapshotSources(),
          len: result.value.length,
          dirty: result.value.dirty,
        }
      },

      'glossary.lookup': (args) => {
        const glossary = buildGlossary(argString(args, 'content'))
        const seed = argEntries(args, 'entries')
        if (seed.length > 0) glossary.add(...seed)
        return { hits: glossary.lookup(argString(args, 'text'), '', '') }
      },

      'glossary.add': (args) => {
        const glossary = buildGlossary(argString(args, 'content'))
        const dirtyBefore = glossary.dirty
        const results = argRounds(args, 'rounds').map((round) => glossary.add(...round))
        return {
          results,
          len: glossary.length,
          sources: glossary.snapshotSources(),
          dirtyBefore,
          dirtyAfter: glossary.dirty,
        }
      },

      'glossary.save': (args) => {
        const path = argString(args, 'path')
        const glossary = FileGlossary.fromEntries(argEntries(args, 'entries'), path)
        if (path === '') {
          const plan = glossary.prepareSave()
          return plan.ok ? { ok: true, error: false } : { ok: false, error: true }
        }
        let content: string | null = null
        const result = glossary.save((plan) => {
          content = plan.content
        })
        if (!result.ok || content === null) return { ok: false, error: true }
        return {
          ok: true,
          content,
          sources: glossary.snapshotSources(),
          dirty: glossary.dirty,
        }
      },

      'glossary.is_cjk_target': (args) => ({ cjk: isCJKTarget(argString(args, 'lang')) }),

      'glossary.replace': (args) => {
        const result = safeReplace(
          argString(args, 'text'),
          argString(args, 'from'),
          argString(args, 'to'),
          argString(args, 'lang'),
        )
        return { text: result.text, replaced: result.replaced, warn: result.warn }
      },

      'glossary.replace_ci': (args) => {
        const result = caseInsensitiveReplace(
          argString(args, 'text'),
          argString(args, 'old'),
          argString(args, 'new'),
        )
        return { text: result.text, replaced: result.replaced }
      },

      'glossary.nop': () => {
        const hits = nopGlossary.lookup('anything', '', '')
        const result = nopGlossary.add(glossaryEntry({ source: 'x', target: 'y' }))
        return { ok: true, hits, added: result.added, skipped: result.skipped }
      },

      'glossary.add_for_request': (args) => {
        const target = new RequestAwareFileGlossary('golden.csv')
        const result = addForRequest(
          target,
          argString(args, 'requestID'),
          ...argEntries(args, 'entries'),
        )
        return { result, requestAware: target.awareCalls > 0, len: target.length }
      },
    })
  })

  it('加载结果满足「长词优先」的字节长度降序不变量', () => {
    const loaderCases = fixture.cases.filter((c) => c.op === 'glossary.load_csv')
    expect(loaderCases.length).toBeGreaterThan(0)
    for (const testCase of loaderCases) {
      const expectOk = testCase.expect.ok as boolean
      if (!expectOk) continue
      const entries = testCase.expect.entries as GlossaryEntry[]
      const lengths = entries.map((entry) => new TextEncoder().encode(entry.source).length)
      for (let i = 1; i < lengths.length; i++) {
        expect(
          lengths[i - 1],
          `用例 ${testCase.id} 的第 ${i} 条破坏了字节长度降序`,
        ).toBeGreaterThanOrEqual(lengths[i] as number)
      }
    }
  })

  it('解析失败用例确实返回失败分支', () => {
    const errorCases = fixture.cases.filter(
      (c) => c.op === 'glossary.load_csv' && c.expect.error === true,
    )
    expect(errorCases.length).toBeGreaterThan(0)
    for (const testCase of errorCases) {
      const result = loadFile(argString(testCase.args, 'content'), 'g.csv')
      expect(result.ok, `用例 ${testCase.id} 应解析失败`).toBe(false)
    }
  })
})
