/**
 * 纠错规则引擎（对应 Go `backend/internal/correct/correct.go` 与
 * `engine_with_rules.go`）。
 *
 * 规则按**白名单 canonical 顺序**执行（不是配置顺序），首个 `changed=true` 即停，
 * 不叠加；全部 no-op 时返回最后一条 no-op 结果。
 */
import { allRuleNames, ruleByName } from './rules'
import {
  emptyCorrectionResult,
  type CorrectConfig,
  type CorrectableSegment,
  type CorrectionResult,
  type CorrectRule,
} from './types'

/** 去重并集，保留首次出现顺序（Go `mergeCodes`）。 */
export function mergeCodes(a: readonly string[], b: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of [...a, ...b]) {
    if (seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

/** 有序规则引擎（Go `correct.Engine`）。 */
export class CorrectEngine {
  private readonly rules: CorrectRule[]
  private readonly codes: string[]

  constructor(rules: readonly CorrectRule[] = [], codes: readonly string[] = []) {
    this.rules = [...rules]
    this.codes = [...codes]
  }

  /** 是否有任何生效规则。 */
  enabled(): boolean {
    return this.rules.length > 0
  }

  /**
   * 依次执行规则，返回**首个** `changed=true` 的结果（不叠加）。
   * 全部 no-op 时返回最后一条 no-op 结果；无规则时返回零值。
   */
  apply(seg: CorrectableSegment): CorrectionResult {
    if (this.rules.length === 0) {
      return emptyCorrectionResult()
    }
    let last = emptyCorrectionResult()
    for (const rule of this.rules) {
      last = rule.apply(seg)
      if (last.changed) return last
    }
    return last
  }

  /**
   * 全部生效规则 `resolvedCodes` 的去重并集，供 handler 构建幂等 checker 引擎。
   * 无规则时返回 `null`（与 Go 的 nil slice 一致）。
   */
  consumedIssueCodes(): string[] | null {
    if (this.codes.length === 0) return null
    return [...this.codes]
  }
}

/**
 * 按配置构建引擎（Go `correct.New`）。
 *
 * 只包含白名单内且 `enabled=true` 的规则，顺序固定为 {@link allRuleNames}；
 * 未知规则名被忽略。无生效规则时返回 no-op 引擎。
 */
export function newCorrectEngine(cfg: CorrectConfig): CorrectEngine {
  const enabledByName = new Map<string, boolean>()
  for (const rc of cfg.rules) {
    enabledByName.set(rc.name, rc.enabled)
  }
  const rules: CorrectRule[] = []
  let codes: string[] = []
  for (const name of allRuleNames()) {
    if (!enabledByName.get(name)) continue
    const rule = ruleByName(name)
    if (!rule) continue
    rules.push(rule)
    codes = mergeCodes(codes, rule.resolvedCodes())
  }
  return new CorrectEngine(rules, codes)
}

/**
 * 直接以规则实例构建引擎：保持传入顺序、不做白名单过滤
 * （Go `NewWithRules`，服务测试注入与动态规则组合）。
 */
export function newCorrectEngineWithRules(rules: ReadonlyArray<CorrectRule | null>): CorrectEngine {
  const kept: CorrectRule[] = []
  let codes: string[] = []
  for (const rule of rules) {
    if (!rule) continue
    kept.push(rule)
    codes = mergeCodes(codes, rule.resolvedCodes())
  }
  return new CorrectEngine(kept, codes)
}
