/**
 * `domain/protect` 黄金向量对拍测试。
 *
 * 期望值全部来自 Go `backend/internal/protect` 的真实输出
 * （由 `backend/internal/protect/golden_vectors_test.go` 导出），
 * 本移植层必须与之 100% 一致。
 */
import { describe, expect, it } from 'vitest'
import protectFixture from '../__fixtures__/protect.json'
import {
  analyzeStructural,
  CodeProtector,
  compose,
  fromRules,
  LinkProtector,
  mergeAdjacentPlaceholders,
  missingPlaceholders,
  PlaceholderProtector,
  placeholderViolations,
  protectText,
  restoreText,
  RubyProtector,
  XMLProtector,
  type ProtectableSegment,
  type Protector,
} from '../protect'
import {
  argBoolean,
  argNullableStringRecord,
  argString,
  argStringArray,
  argStringRecord,
  runGolden,
  type GoldenFixture,
} from './helpers/golden'

const fixture = protectFixture as unknown as GoldenFixture

/** 构造一个待保护的段落（Go `model.Segment` 的最小投影）。 */
function makeSegment(source: string): ProtectableSegment {
  return { source, target: '', protected: {} }
}

/** 依据链名构造保护器（`ruby` 由 `RubyProtector` 承担，其余对齐 Go `FromRules`）。 */
function protectorForChain(chain: string[]): Protector {
  const ps: Protector[] = []
  for (const name of chain) {
    switch (name) {
      case 'code':
        ps.push(new CodeProtector())
        break
      case 'link':
        ps.push(new LinkProtector())
        break
      case 'placeholder':
        ps.push(new PlaceholderProtector())
        break
      case 'xml':
        ps.push(new XMLProtector())
        break
      case 'ruby':
        ps.push(new RubyProtector())
        break
      default:
        break
    }
  }
  return compose(...ps)
}

/** 扫描源文中的 `__LF_NNNNNN__` 字面量（去重、升序）。 */
function placeholderLiterals(src: string): string[] {
  const out = new Set<string>()
  const re = /__LF_\d{6}__/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    out.add(m[0])
  }
  return [...out].sort()
}

describe('domain/protect 黄金向量', () => {
  it('覆盖全部黄金向量', () => {
    runGolden(fixture, {
      'protect.placeholder': (args) => {
        const seg = makeSegment(argString(args, 'source'))
        new PlaceholderProtector().protect(seg)
        return { source: seg.source, protected: seg.protected, meta: seg.meta ?? null }
      },

      'protect.code': (args) => {
        const seg = makeSegment(argString(args, 'source'))
        new CodeProtector().protect(seg)
        return { source: seg.source, protected: seg.protected, meta: seg.meta ?? null }
      },

      'protect.link': (args) => {
        const seg = makeSegment(argString(args, 'source'))
        new LinkProtector().protect(seg)
        return { source: seg.source, protected: seg.protected, meta: seg.meta ?? null }
      },

      'protect.xml': (args) => {
        const seg = makeSegment(argString(args, 'source'))
        new XMLProtector().protect(seg)
        return { source: seg.source, protected: seg.protected, meta: seg.meta ?? null }
      },

      'protect.ruby': (args) => {
        const seg = makeSegment(argString(args, 'source'))
        new RubyProtector().protect(seg)
        return { source: seg.source, protected: seg.protected, meta: seg.meta ?? null }
      },

      'protect.compose': (args) => {
        const seg = makeSegment(argString(args, 'source'))
        protectorForChain(argStringArray(args, 'chain')).protect(seg)
        return { source: seg.source, protected: seg.protected, meta: seg.meta ?? null }
      },

      'protect.from_rules': (args) => {
        const seg = makeSegment(argString(args, 'source'))
        fromRules(argStringArray(args, 'rules')).protect(seg)
        return { source: seg.source, protected: seg.protected, meta: seg.meta ?? null }
      },

      'protect.next_key': (args) => {
        const src = argString(args, 'source')
        const seg = makeSegment(src)
        new PlaceholderProtector().protect(seg)
        return {
          source: seg.source,
          protected: seg.protected,
          collidedKeys: placeholderLiterals(src),
        }
      },

      'protect.merge_adjacent': (args) => {
        const seg = makeSegment(argString(args, 'source'))
        seg.protected = { ...argStringRecord(args, 'protected') }
        mergeAdjacentPlaceholders(seg)
        return { source: seg.source, protected: seg.protected }
      },

      'protect.restore_all': (args) => {
        const seg = makeSegment('')
        seg.target = argString(args, 'text')
        seg.protected = { ...argStringRecord(args, 'protected') }
        // Go 侧 composed.Unprotect 在顶层一次性还原，等价于 restoreAll。
        const p = compose(new CodeProtector(), new LinkProtector())
        p.unprotect(seg)
        return { text: seg.target }
      },

      'protect.violations': (args) => {
        const seg = makeSegment('')
        seg.target = argString(args, 'target')
        seg.protected = { ...argStringRecord(args, 'protected') }
        const v = placeholderViolations(seg)
        return { missing: v.missing, duplicated: v.duplicated, invented: v.invented }
      },

      'protect.analyze_structural': (args) => {
        const rules =
          args.rules === undefined || args.rules === null ? null : argStringArray(args, 'rules')
        const p = rules === null ? null : fromRules(rules)
        const a = analyzeStructural(p, argString(args, 'source'))
        return {
          structural: a.structural,
          protected: a.protected,
          mapping: a.mapping,
          meta: a.meta,
          ran: a.ran,
          err: a.err,
        }
      },

      'protect.protect_text': (args) => {
        const p =
          args.rules === undefined || args.rules === null
            ? null
            : fromRules(argStringArray(args, 'rules'))
        const r = protectText(p, argString(args, 'text'))
        return { text: r.text, mapping: r.mapping }
      },

      'protect.restore_text': (args) => {
        return {
          text: restoreText(argString(args, 'text'), argStringRecord(args, 'mapping')),
        }
      },

      'protect.missing_placeholders': (args) => {
        const seg = makeSegment('')
        seg.target = argString(args, 'target')
        seg.protected = { ...argStringRecord(args, 'protected') }
        return { missing: missingPlaceholders(seg) }
      },

      'protect.ruby_items': (args) => {
        const seg = makeSegment(argString(args, 'source'))
        new RubyProtector().protect(seg)
        const items = seg.meta?.ruby_items
        return { source: seg.source, items: items ?? null }
      },
    })
  })

  it('next_key 的字面量碰撞用例与 Go 的 fail-closed 语义一致', () => {
    const cases = fixture.cases.filter((c) => c.op === 'protect.next_key')
    expect(cases.length).toBeGreaterThan(0)
    for (const testCase of cases) {
      const collided = argStringArray(testCase.expect, 'collidedKeys')
      const protectedMap = argStringRecord(testCase.expect, 'protected')
      for (const key of collided) {
        expect(protectedMap).not.toHaveProperty(key)
      }
    }
  })

  it('analyze_structural 的 nil 映射语义与 Go 一致', () => {
    const cases = fixture.cases.filter((c) => c.op === 'protect.analyze_structural')
    expect(cases.length).toBeGreaterThan(0)
    for (const testCase of cases) {
      const mapping = argNullableStringRecord(testCase.expect, 'mapping')
      const ran = argBoolean(testCase.expect, 'ran')
      if (!ran) {
        expect(mapping).toBeNull()
      }
    }
  })
})
