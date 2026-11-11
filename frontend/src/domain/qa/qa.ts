/**
 * QA 核心原语（对应 Go `backend/internal/qa/qa.go` 的问题模型与裁决对账逻辑）。
 *
 * 这里只放**不依赖具体 checker** 的纯函数：
 * - 指纹与去重（`Fingerprint` / `MatchedText` / `DedupIssues`）；
 * - 裁决继承与组合（`ReconcileIssues` / `FilterOutPendingByCodes` /
 *   `ReviseFinalIssues` / `RecheckFinalIssues`）；
 * - 配置开关（`CheckerEnabled`）、结果查询（`HasErrors` / `IssuesFor`）；
 * - 默认配置（`DefaultConfig`）。
 *
 * 引擎编排见 `engine.ts`，Span 定位见 `span.ts`，落库序列化见 `issue.ts`。
 */
import { isSemanticQACode, isConservationCode } from './codes'
import {
  DISPOSITION_PENDING,
  LENGTH_METHOD_CHAR_WEIGHT,
  SEVERITY_ERROR,
  type Config,
  type QualityIssue,
} from './types'

/**
 * 返回问题指纹 `(code, matched_text)`（Go `Fingerprint`）。无跨度时 matched_text 为空。
 *
 * 指纹是裁决继承的唯一键：`dismissed` 只对「同 code 且同 matched_text」的新问题生效。
 */
export function fingerprint(issue: QualityIssue): string {
  return `${issue.code}:${matchedText(issue)}`
}

/** 返回问题的匹配文本；无跨度时为空字符串（Go `MatchedText`）。 */
export function matchedText(issue: QualityIssue): string {
  return issue.span?.matchedText ?? ''
}

/** 报告该问题是否仍未裁决（Go `IsPending`）。兼容零值 `''`。 */
export function isPending(issue: QualityIssue): boolean {
  return issue.disposition === DISPOSITION_PENDING || issue.disposition === ''
}

/** 报告该问题是否已被裁决为「不是问题」（Go `Dismissed`）。 */
export function isDismissed(issue: QualityIssue): boolean {
  return issue.disposition === 'dismissed'
}

/**
 * 将新算出的 issues 与已有 issues 按指纹对账（Go `ReconcileIssues`）。
 *
 * - 同指纹且旧记录**非 pending**（如 dismissed）→ 继承旧裁决
 *   （disposition / decidedBy / decidedAt / note），其余字段用新算值；
 * - 同指纹但旧记录 pending → 不继承；
 * - 指纹消失 → 旧裁决自然清除；
 * - 零值 disposition 归一化为显式 `pending`。
 *
 * 不修改入参（Go 侧 `existing` 也不会被改写；`fresh` 的归一化在此返回副本）。
 */
export function reconcileIssues(
  fresh: readonly QualityIssue[],
  existing: readonly QualityIssue[] | null | undefined,
): QualityIssue[] {
  const prevList = existing ?? []
  if (prevList.length === 0) {
    return fresh.map((iss) =>
      iss.disposition === '' ? { ...iss, disposition: DISPOSITION_PENDING } : { ...iss },
    )
  }
  const prev = new Map<string, QualityIssue>()
  for (const iss of prevList) {
    prev.set(fingerprint(iss), iss)
  }
  const out: QualityIssue[] = []
  for (const source of fresh) {
    const iss: QualityIssue = { ...source }
    const old = prev.get(fingerprint(iss))
    if (old !== undefined && !isPending(old)) {
      iss.disposition = old.disposition
      iss.decidedBy = old.decidedBy
      iss.decidedAt = old.decidedAt
      iss.note = old.note
    } else if (iss.disposition === '') {
      // checker 构造 issue 时省略 disposition，归一化为显式 pending。
      iss.disposition = DISPOSITION_PENDING
    }
    out.push(iss)
  }
  return out
}

/** 按 `(code, matched_text)` 去重，保留首次出现（Go `DedupIssues`）。 */
export function dedupIssues(issues: readonly QualityIssue[]): QualityIssue[] {
  if (issues.length === 0) {
    return []
  }
  const seen = new Set<string>()
  const out: QualityIssue[] = []
  for (const iss of issues) {
    const fp = fingerprint(iss)
    if (seen.has(fp)) {
      continue
    }
    seen.add(fp)
    out.push(iss)
  }
  return out
}

/**
 * 移除 codes 命中且仍为 pending 的 issue，保留 dismissed 记录与范围外 issue
 * （Go `FilterOutPendingByCodes`）。
 *
 * dismissed 的模式可能仍存在于新文本且为用户有意为之，删除会让未来 QA 重跑时
 * 以 pending 复活骚扰用户。
 */
export function filterOutPendingByCodes(
  issues: readonly QualityIssue[],
  drop: ReadonlySet<string>,
): QualityIssue[] {
  const out: QualityIssue[] = []
  for (const iss of issues) {
    if (drop.has(iss.code) && !isDismissed(iss)) {
      continue // 修复轮已声明解决且未 dismissed 的，移除
    }
    out.push(iss)
  }
  return out
}

/**
 * 组合修订轮写回的最终 issue 集合（Go `ReviseFinalIssues`）。
 *
 * 契约（与 correct 轮一致：「声明修什么，就移除什么，其余判决不动」）：
 * - targetedCodes 范围内且仍 pending 的 issue 视为本轮已修复，移除；
 * - 范围外 pending 与 dismissed 记录一律保留；
 * - qaRan 时确定性 issue 以 fresh 重算（按指纹继承旧裁决），
 *   existing 中范围外的语义 issue 不由确定性 QA 维护，保留；
 * - qaRan=false 时不重算，existing 中非目标 issue 原样保留。
 */
export function reviseFinalIssues(
  existing: readonly QualityIssue[],
  fresh: readonly QualityIssue[] | null | undefined,
  targetedCodes: readonly string[],
  qaRan: boolean,
): QualityIssue[] {
  const drop = new Set(targetedCodes)
  const kept = filterOutPendingByCodes(existing, drop)
  if (!qaRan) {
    return kept
  }
  const out = reconcileIssues(fresh ?? [], kept)
  for (const iss of kept) {
    if (isSemanticQACode(iss.code)) {
      out.push(iss)
    }
  }
  return out
}

/**
 * 组合重检写回的最终 issue 集合（Go `RecheckFinalIssues`）。
 *
 * - fresh（本次重算的确定性 issues）经 {@link reconcileIssues} 与 existing 对账；
 * - existing 中的语义类与守恒类 issue 原样追加（重检不可重算也不应清除）；
 * - existing 中其余确定性 issue 若指纹不在 fresh 中则自然清除。
 */
export function recheckFinalIssues(
  fresh: readonly QualityIssue[] | null | undefined,
  existing: readonly QualityIssue[] | null | undefined,
): QualityIssue[] {
  const out = reconcileIssues(fresh ?? [], existing ?? [])
  for (const iss of existing ?? []) {
    if (isSemanticQACode(iss.code) || isConservationCode(iss.code)) {
      out.push(iss)
    }
  }
  return out
}

/**
 * 报告给定 checks 配置下指定 code 的检查是否启用（Go `CheckerEnabled`）。
 *
 * `checks` 为 `null` 表示未显式配置（全开）；显式列表时按名称精确匹配——
 * 注意**显式空列表**与 `null` 语义不同（前者即全关）。
 */
export function checkerEnabled(checks: readonly string[] | null, code: string): boolean {
  if (checks === null) {
    return true
  }
  for (const name of checks) {
    if (name === code) {
      return true
    }
  }
  return false
}

/** 检查问题列表中是否包含 error 级别的问题（Go `HasErrors`）。 */
export function hasErrors(issues: readonly QualityIssue[]): boolean {
  for (const issue of issues) {
    if (issue.severity === SEVERITY_ERROR) {
      return true
    }
  }
  return false
}

/** 返回指定段落索引的问题列表（Go `IssuesFor`）。 */
export function issuesFor(segmentIndex: number, issues: readonly QualityIssue[]): QualityIssue[] {
  const result: QualityIssue[] = []
  for (const issue of issues) {
    if (issue.segmentIndex === segmentIndex) {
      result.push(issue)
    }
  }
  return result
}

/** 返回默认的 QA 配置（Go `DefaultConfig`；默认关闭）。 */
export function defaultConfig(): Config {
  return {
    enabled: false,
    autoReject: false,
    lengthMethod: LENGTH_METHOD_CHAR_WEIGHT,
    lengthRatioMin: 0.2,
    lengthRatioMax: 3.0,
    sourceLang: '',
    targetLang: '',
    checks: null,
    format: '',
    glossary: null,
  }
}
