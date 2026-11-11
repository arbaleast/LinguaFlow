/**
 * `domain/correct` 黄金向量对拍测试。
 *
 * 期望值全部来自 Go `backend/internal/correct` 的真实输出
 * （由 `backend/internal/correct/golden_vectors_test.go` 导出）。
 */
import { describe, it } from 'vitest'
import correctFixture from '../__fixtures__/correct.json'
import {
  allRuleNames,
  newCorrectEngine,
  ruleByName,
  type CorrectableSegment,
  type CorrectRuleConfig,
  type CorrectionResult,
  type QualityIssue,
} from '../correct'
import { argString, argStringRecord, runGolden, type GoldenFixture } from './helpers/golden'

const fixture = correctFixture as unknown as GoldenFixture

/** 从黄金向量参数解析引擎配置（缺省为空数组）。 */
function configFromArgs(args: Record<string, unknown>): CorrectRuleConfig[] {
  const raw = args.config
  if (raw === undefined || raw === null) return []
  return (raw as Array<{ name: string; enabled: boolean }>).map((rc) => ({
    name: rc.name,
    enabled: rc.enabled,
  }))
}

/** 从黄金向量参数解析 issue 数组（`span.matched_text` 对齐 Go JSON tag）。 */
function issuesFromArgs(args: Record<string, unknown>): QualityIssue[] {
  const raw = args.issues
  if (!Array.isArray(raw)) return []
  return (raw as Array<Record<string, unknown>>).map((item) => {
    const issue: QualityIssue = {
      code: String(item.code ?? ''),
      disposition: typeof item.disposition === 'string' ? item.disposition : '',
    }
    const span = item.span as Record<string, unknown> | null | undefined
    if (span !== null && span !== undefined) {
      issue.span = { matchedText: String(span.matched_text ?? '') }
    }
    return issue
  })
}

/** 从黄金向量参数重建待纠错段落。 */
function segmentFromArgs(args: Record<string, unknown>): CorrectableSegment {
  return {
    source: argString(args, 'source'),
    target: argString(args, 'target'),
    protected: { ...argStringRecord(args, 'protected') },
    issues: issuesFromArgs(args),
  }
}

/** 把规则输出投影为与 Go 侧 `resultExpect` 同形的对象。 */
function resultToJSON(res: CorrectionResult): Record<string, unknown> {
  return {
    changed: res.changed,
    new_target: res.newTarget,
    op: res.op,
    resolved_codes: res.resolvedCodes,
    reason: res.reason,
  }
}

describe('domain/correct 黄金向量', () => {
  it('覆盖全部黄金向量', () => {
    runGolden(fixture, {
      'correct.rule': (args) => {
        const rule = ruleByName(argString(args, 'rule'))
        if (rule === null) throw new Error(`未知规则: ${argString(args, 'rule')}`)
        return resultToJSON(rule.apply(segmentFromArgs(args)))
      },

      'correct.engine': (args) => {
        const engine = newCorrectEngine({ rules: configFromArgs(args) })
        return resultToJSON(engine.apply(segmentFromArgs(args)))
      },

      'correct.all_rule_names': () => {
        return { names: allRuleNames() }
      },

      'correct.engine_meta': (args) => {
        const engine = newCorrectEngine({ rules: configFromArgs(args) })
        return { enabled: engine.enabled(), codes: engine.consumedIssueCodes() }
      },
    })
  })

  it('dismissed issue 对所有内置规则不可见', () => {
    for (const ruleName of allRuleNames()) {
      const rule = ruleByName(ruleName)
      if (rule === null) throw new Error(`未知规则: ${ruleName}`)
      const code = rule.resolvedCodes()[0] as string
      const res = rule.apply({
        source: '「对话」!',
        target: '对话!',
        protected: {},
        issues: [{ code, disposition: 'dismissed', span: { matchedText: '!' } }],
      })
      if (res.changed) {
        throw new Error(`规则 ${ruleName} 不应被 dismissed issue 触发`)
      }
    }
  })
})
