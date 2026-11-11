/**
 * `domain/script` 黄金向量对拍测试。
 *
 * 期望值全部来自 Go `backend/internal/script` 的真实输出
 * （由 `backend/internal/script/golden_vectors_test.go` 导出），
 * 本移植层必须与之 100% 一致。
 */
import { describe, expect, it } from 'vitest'
import scriptFixture from '../__fixtures__/script.json'
import {
  HANS_SPECIFIC_CHARS,
  HANT_SPECIFIC_CHARS,
  resolveProfile,
  runeScript,
  scanProfile,
  scriptDisplayName,
  type Profile,
  type Script,
} from '../script'
import { argString, argStringArray, runGolden, type GoldenFixture } from './helpers/golden'

const fixture = scriptFixture as unknown as GoldenFixture

/** 从黄金向量参数还原 Profile。 */
function argProfile(args: Record<string, unknown>): Profile {
  const raw = args.profile
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { language: '', expected: '', siblings: [] }
  }
  const obj = raw as Record<string, unknown>
  return {
    language: typeof obj.language === 'string' ? obj.language : '',
    expected: typeof obj.expected === 'string' ? obj.expected : '',
    siblings: Array.isArray(obj.siblings) ? (obj.siblings as Script[]) : [],
  }
}

describe('domain/script 黄金向量', () => {
  it('覆盖全部黄金向量', () => {
    runGolden(fixture, {
      'script.resolve': (args) => {
        const p = resolveProfile(argString(args, 'lang'))
        return {
          ok: p !== null,
          language: p?.language ?? '',
          expected: p?.expected ?? '',
          siblings: p?.siblings ?? [],
        }
      },

      'script.display_name': (args) => {
        return { name: scriptDisplayName(argString(args, 'script')) }
      },

      'script.scan': (args) => {
        const ev = scanProfile(argProfile(args), argString(args, 'text'))
        return {
          ok: ev !== null,
          script: ev?.script ?? '',
          count: ev?.count ?? 0,
          sample: ev?.sample ?? '',
        }
      },

      'script.rune_script': (args) => {
        const rune = argString(args, 'rune')
        const cp = rune.codePointAt(0)
        if (cp === undefined) {
          throw new Error(`黄金向量参数 "rune" 为空串`)
        }
        const v = runeScript(cp)
        return { ok: v.ok, script: v.script }
      },

      'script.tables': (args) => {
        const which = argString(args, 'which')
        if (which !== 'hans' && which !== 'hant') {
          throw new Error(`未知的字表: ${which}`)
        }
        const chars = which === 'hans' ? HANS_SPECIFIC_CHARS : HANT_SPECIFIC_CHARS
        const runes = Array.from(chars)
        return {
          chars,
          count: runes.length,
          first: runes[0] ?? '',
          last: runes[runes.length - 1] ?? '',
        }
      },
    })
  })

  it('生成字表按码点严格升序且互不相交', () => {
    const hans = Array.from(HANS_SPECIFIC_CHARS, (ch) => ch.codePointAt(0) ?? 0)
    const hant = Array.from(HANT_SPECIFIC_CHARS, (ch) => ch.codePointAt(0) ?? 0)
    for (const rs of [hans, hant]) {
      expect(rs.length).toBeGreaterThanOrEqual(500)
      expect(rs.length).toBeLessThanOrEqual(8000)
      for (let i = 1; i < rs.length; i++) {
        expect(rs[i]!).toBeGreaterThan(rs[i - 1]!)
      }
    }
    const hantSet = new Set(hant)
    for (const cp of hans) {
      expect(hantSet.has(cp)).toBe(false)
    }
  })

  it('两栖字在 runtime 集合中被剔除，且不产生证据', () => {
    const hansProfile: Profile = { language: 'zh', expected: 'Hans', siblings: ['Hant'] }
    const hantProfile: Profile = { language: 'zh', expected: 'Hant', siblings: ['Hans'] }
    expect(scanProfile(hantProfile, '台灣批准游泳長征山峰文采')).toBeNull()
    expect(scanProfile(hansProfile, '台湾批准游泳长征山峰文采')).toBeNull()
  })

  it('兄弟文字系统列表与 Go 注册表顺序一致', () => {
    const cases = fixture.cases.filter((c) => c.op === 'script.resolve')
    expect(cases.length).toBeGreaterThan(0)
    for (const testCase of cases) {
      const ok = testCase.expect.ok as boolean
      const siblings = argStringArray(testCase.expect, 'siblings')
      if (!ok) {
        expect(siblings).toEqual([])
      } else {
        // 期望文字系统不得出现在 siblings 中
        expect(siblings).not.toContain(testCase.expect.expected)
      }
    }
  })
})
