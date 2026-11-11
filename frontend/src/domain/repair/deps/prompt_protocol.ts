/**
 * prompt 协议解析（`backend/internal/prompt` 中 `repair` 依赖的**最小子集** 1:1 移植）。
 *
 * 为什么放在 `domain/repair/deps/` 而不是新建 `domain/prompt/`：本任务是
 * repair 包移植，硬性边界只允许创建 `domain/repair/**`；这些函数是 repair
 * 各入口的输入协议解码器（`StripCodeFence` / `NormalizeSemanticQAIssues` /
 * `ParseReviseTextRevisions` 等）。后续若移植完整 `domain/prompt`，应改为
 * 从那里导出、单点维护。
 *
 * 只移植解析/归一化，不移植模板渲染与 schema 生成（repair 不依赖）。
 */
import {
  equalFoldAscii,
  hasPrefix,
  hasSuffix,
  joinStrings,
  lastIndex,
  splitString,
  trimSpaceGo,
} from '../strings'
import { parseInlineMarkers } from './ruby_protocol'
import type { AdjudicationVerdict, BootstrapEntry, ReviseRevision, SemanticQAIssue } from '../types'

/** 语义质检维护的 issue code 权威清单（Go `qa.SemanticQACodes()`）。 */
export const SEMANTIC_QA_CODES: readonly string[] = [
  'calque',
  'term_fidelity',
  'naturalness',
  'mistranslation',
  'omission',
  'addition',
  'grammar',
  'register',
]

/** 判断 code 是否由语义质检轮次维护（Go `prompt.IsSemanticQACode`）。 */
export function isSemanticQACode(code: string): boolean {
  return SEMANTIC_QA_CODES.includes(code)
}

/** 判断是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 解码 Go 结构体的 string 字段：缺失/null → 零值，string → 原值，其余类型报错。
 * 对应 `json.Unmarshal` 到 `string` 字段的语义。
 */
function decodeStringField(obj: Record<string, unknown>, key: string): string {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return ''
  const value = obj[key]
  if (value === null) return ''
  if (typeof value !== 'string') {
    throw new Error(
      `json: cannot unmarshal ${typeof value} into Go struct field ${key} of type string`,
    )
  }
  return value
}

/** 解码对象数组为 Go 结构体切片形状。null → `[]`（Go nil slice）。 */
function decodeStructArray<T>(
  value: unknown,
  decodeElement: (obj: Record<string, unknown>) => T,
): T[] {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) {
    throw new Error('json: cannot unmarshal non-array into Go slice')
  }
  const out: T[] = []
  for (const item of value) {
    if (item === null) {
      out.push(decodeElement({}))
      continue
    }
    if (!isRecord(item)) {
      throw new Error('json: cannot unmarshal non-object into Go struct')
    }
    out.push(decodeElement(item))
  }
  return out
}

/**
 * 剥离 ```...``` 围栏，返回内部内容（Go `prompt.StripCodeFence`，全仓唯一实现）。
 *
 * 支持首尾有非围栏文本；无换行或无闭合围栏时按 Go 的容错分支返回。
 */
export function stripCodeFence(text: string): string {
  let value = trimSpaceGo(text)
  const start = value.indexOf('```')
  if (start < 0) return value
  let afterStart = value.slice(start + 3)
  const newline = afterStart.indexOf('\n')
  if (newline >= 0) {
    afterStart = afterStart.slice(newline + 1)
  } else {
    return value
  }
  const end = lastIndex(afterStart, '```')
  if (end < 0) {
    return trimSpaceGo(afterStart)
  }
  value = trimSpaceGo(afterStart.slice(0, end))
  return value
}

// ---------------------------------------------------------------------------
// BootstrapEntry
// ---------------------------------------------------------------------------

/** 解码 `[]prompt.BootstrapEntry`（Go `json.Unmarshal` 语义）。 */
export function decodeBootstrapEntries(value: unknown): BootstrapEntry[] {
  return decodeStructArray(value, (obj) => ({
    source: decodeStringField(obj, 'source'),
    target: decodeStringField(obj, 'target'),
    notes: decodeStringField(obj, 'notes'),
  }))
}

/**
 * 过滤空 source/target，按 source 去重保留首次（Go `dedupeBootstrapEntries` /
 * `TryRepairBootstrap` 尾部过滤，两者语义一致）。
 */
export function dedupeBootstrapEntries(entries: readonly BootstrapEntry[]): BootstrapEntry[] {
  const out: BootstrapEntry[] = []
  const seen = new Set<string>()
  for (const raw of entries) {
    const entry: BootstrapEntry = {
      source: trimSpaceGo(raw.source),
      target: trimSpaceGo(raw.target),
      notes: trimSpaceGo(raw.notes),
    }
    if (entry.source === '' || entry.target === '') continue
    if (seen.has(entry.source)) continue
    seen.add(entry.source)
    out.push(entry)
  }
  return out
}

// ---------------------------------------------------------------------------
// SemanticQAIssue
// ---------------------------------------------------------------------------

/** 解码 `[]prompt.SemanticQAIssue`。 */
export function decodeSemanticQAIssues(value: unknown): SemanticQAIssue[] {
  return decodeStructArray(value, (obj) => ({
    id: decodeStringField(obj, 'id'),
    code: decodeStringField(obj, 'code'),
    message: decodeStringField(obj, 'message'),
    snippet: decodeStringField(obj, 'snippet'),
  }))
}

/**
 * trim 并过滤非法语义质检 issue（Go `prompt.NormalizeSemanticQAIssues`）：
 * 丢弃缺 id/code 或 code 不在白名单的条目。
 */
export function normalizeSemanticQAIssues(issues: readonly SemanticQAIssue[]): SemanticQAIssue[] {
  const out: SemanticQAIssue[] = []
  for (const raw of issues) {
    const issue: SemanticQAIssue = {
      id: trimSpaceGo(raw.id),
      code: trimSpaceGo(raw.code),
      message: trimSpaceGo(raw.message),
      snippet: trimSpaceGo(raw.snippet),
    }
    if (issue.id === '' || issue.code === '') continue
    if (!isSemanticQACode(issue.code)) continue
    out.push(issue)
  }
  return out
}

/** 解析单行 `id | code | snippet | message`（Go `parseSemanticQAIssueLine`）。 */
function parseSemanticQAIssueLine(line: string): SemanticQAIssue | null {
  const parts = splitString(line, '|')
  if (parts.length < 2) return null
  const id = trimSpaceGo(parts[0] as string)
  const code = trimSpaceGo(parts[1] as string)
  let snippet = ''
  let message = ''
  if (parts.length === 3) {
    // 兼容旧格式：id | code | message
    message = trimSpaceGo(parts[2] as string)
  } else if (parts.length > 3) {
    // id | code | snippet | message...
    snippet = trimSpaceGo(parts[2] as string)
    message = joinStrings(
      parts.slice(3).map((part) => trimSpaceGo(part)),
      ' | ',
    )
  }
  if (id === '' || code === '') return null
  if (!isSemanticQACode(code)) return null
  return { id, code, message, snippet }
}

/**
 * 解析 text 协议语义质检输出（Go `prompt.ParseSemanticQATextIssues`）。
 *
 * 返回 `{issues, recognized}`：recognized=true 表示命中 `[issues]` 协议（含空列表）。
 */
export function parseSemanticQATextIssues(text: string): {
  issues: SemanticQAIssue[]
  recognized: boolean
} {
  const body = stripCodeFence(text)
  const lines = splitString(body, '\n')
  let inIssues = false
  let hasHeader = false
  let hasIssueContent = false
  const out: SemanticQAIssue[] = []
  for (const rawLine of lines) {
    const line = trimSpaceGo(rawLine)
    if (line === '') continue
    if (equalFoldAscii(line, '[issues]')) {
      inIssues = true
      hasHeader = true
      continue
    }
    if (hasPrefix(line, '[') && hasSuffix(line, ']')) {
      if (hasHeader) inIssues = false
      continue
    }
    if (hasHeader && !inIssues) continue
    if (hasHeader) hasIssueContent = true
    const issue = parseSemanticQAIssueLine(line)
    if (issue === null) continue
    out.push(issue)
  }
  return { issues: out, recognized: out.length > 0 || (hasHeader && !hasIssueContent) }
}

// ---------------------------------------------------------------------------
// AdjudicationVerdict
// ---------------------------------------------------------------------------

/** 解码 `[]prompt.AdjudicationVerdict`。 */
export function decodeAdjudicationVerdicts(value: unknown): AdjudicationVerdict[] {
  return decodeStructArray(value, (obj) => ({
    id: decodeStringField(obj, 'id'),
    issue_code: decodeStringField(obj, 'issue_code'),
    matched_text: decodeStringField(obj, 'matched_text'),
    verdict: decodeStringField(obj, 'verdict'),
    reason: decodeStringField(obj, 'reason'),
  }))
}

/** trim 并过滤缺 id/issue_code 的裁决（Go `NormalizeAdjudicationVerdicts`）。 */
export function normalizeAdjudicationVerdicts(
  verdicts: readonly AdjudicationVerdict[],
): AdjudicationVerdict[] {
  const out: AdjudicationVerdict[] = []
  for (const raw of verdicts) {
    const verdict: AdjudicationVerdict = {
      id: trimSpaceGo(raw.id),
      issue_code: trimSpaceGo(raw.issue_code),
      matched_text: trimSpaceGo(raw.matched_text),
      verdict: trimSpaceGo(raw.verdict),
      reason: trimSpaceGo(raw.reason),
    }
    if (verdict.id === '' || verdict.issue_code === '') continue
    out.push(verdict)
  }
  return out
}

/**
 * 裸数组兜底的领域判别器（Go `ValidBareVerdictEntries`）：真实裁决必带合法
 * verdict 值；只有 issue 字段的回显判为诱饵。
 */
export function validBareVerdictEntries(entries: readonly unknown[]): boolean {
  for (const item of entries) {
    if (!isRecord(item)) return false
    const verdict = item['verdict']
    if (verdict === 'real' || verdict === 'false_positive') return true
  }
  return false
}

/** 解析单行裁决（Go `parseAdjudicationVerdictLine`）。 */
function parseAdjudicationVerdictLine(line: string): AdjudicationVerdict | null {
  const parts = splitString(line, '|')
  if (parts.length < 3) return null
  const id = trimSpaceGo(parts[0] as string)
  const issueCode = trimSpaceGo(parts[1] as string)
  let matchedText = ''
  let verdict = ''
  let reason = ''
  if (parts.length >= 4) {
    const p2 = trimSpaceGo(parts[2] as string)
    const p3 = trimSpaceGo(parts[3] as string)
    if (p2 === 'real' || p2 === 'false_positive') {
      // 旧格式：id | code | verdict | reason...
      verdict = p2
      reason = joinStrings(
        parts.slice(3).map((part) => trimSpaceGo(part)),
        ' | ',
      )
    } else if (p3 === 'real' || p3 === 'false_positive') {
      // 新格式：id | code | matched_text | verdict | reason...
      matchedText = p2
      verdict = p3
      reason = joinStrings(
        parts.slice(4).map((part) => trimSpaceGo(part)),
        ' | ',
      )
    } else {
      return null
    }
  } else {
    verdict = trimSpaceGo(parts[2] as string)
  }
  if (id === '' || issueCode === '') return null
  if (verdict !== 'real' && verdict !== 'false_positive') return null
  return { id, issue_code: issueCode, matched_text: matchedText, verdict, reason }
}

/** 解析 text 协议裁决输出（Go `prompt.ParseAdjudicationTextVerdicts`）。 */
export function parseAdjudicationTextVerdicts(text: string): {
  verdicts: AdjudicationVerdict[]
  recognized: boolean
} {
  const body = stripCodeFence(text)
  const lines = splitString(body, '\n')
  let inVerdicts = false
  let hasHeader = false
  let hasVerdictContent = false
  const out: AdjudicationVerdict[] = []
  for (const rawLine of lines) {
    const line = trimSpaceGo(rawLine)
    if (line === '') continue
    if (equalFoldAscii(line, '[verdicts]')) {
      inVerdicts = true
      hasHeader = true
      continue
    }
    if (hasPrefix(line, '[') && hasSuffix(line, ']')) {
      if (hasHeader) inVerdicts = false
      continue
    }
    if (hasHeader && !inVerdicts) continue
    if (hasHeader) hasVerdictContent = true
    const verdict = parseAdjudicationVerdictLine(line)
    if (verdict === null) continue
    out.push(verdict)
  }
  return { verdicts: out, recognized: out.length > 0 || (hasHeader && !hasVerdictContent) }
}

// ---------------------------------------------------------------------------
// ReviseRevision
// ---------------------------------------------------------------------------

/** 解码 `[]prompt.ReviseRevision`。 */
export function decodeReviseRevisions(value: unknown): ReviseRevision[] {
  return decodeStructArray(value, (obj) => ({
    id: decodeStringField(obj, 'id'),
    target: decodeStringField(obj, 'target'),
  }))
}

/**
 * trim 并过滤缺 id/target 的修订；同一 id 保留首次（Go
 * `NormalizeReviseRevisions`）。
 */
export function normalizeReviseRevisions(revisions: readonly ReviseRevision[]): ReviseRevision[] {
  const out: ReviseRevision[] = []
  const seen = new Set<string>()
  for (const raw of revisions) {
    const revision: ReviseRevision = {
      id: trimSpaceGo(raw.id),
      target: trimSpaceGo(raw.target),
    }
    if (revision.id === '' || revision.target === '') continue
    if (seen.has(revision.id)) continue
    seen.add(revision.id)
    out.push(revision)
  }
  return out
}

/** 解析单行 `id | target`（Go `parseReviseRevisionLine`）。 */
function parseReviseRevisionLine(line: string): ReviseRevision | null {
  const sep = line.indexOf('|')
  if (sep < 0) return null
  const id = trimSpaceGo(line.slice(0, sep))
  const target = trimSpaceGo(line.slice(sep + 1))
  if (id === '' || target === '') return null
  return { id, target }
}

/**
 * 解析 text 协议修订输出（Go `prompt.ParseReviseTextRevisions`）。
 *
 * `recognized` 的判定刻意使用**归一化前**的 out 长度（与 Go 一致）。
 */
export function parseReviseTextRevisions(text: string): {
  revisions: ReviseRevision[]
  recognized: boolean
} {
  const body = stripCodeFence(text)
  const lines = splitString(body, '\n')
  let inRevisions = false
  let hasHeader = false
  let hasRevisionContent = false
  const out: ReviseRevision[] = []
  for (const rawLine of lines) {
    const line = trimSpaceGo(rawLine)
    if (line === '') continue
    if (equalFoldAscii(line, '[revisions]')) {
      inRevisions = true
      hasHeader = true
      continue
    }
    if (hasPrefix(line, '[') && hasSuffix(line, ']')) {
      if (hasHeader) inRevisions = false
      continue
    }
    if (!hasHeader || !inRevisions) continue
    hasRevisionContent = true
    const revision = parseReviseRevisionLine(line)
    if (revision === null) continue
    out.push(revision)
  }
  return {
    revisions: normalizeReviseRevisions(out),
    recognized: hasHeader && (out.length > 0 || !hasRevisionContent),
  }
}

// ---------------------------------------------------------------------------
// 复用导出的注音内联标记解析（供 text.go 的 fallback 路径调用）
// ---------------------------------------------------------------------------

export { parseInlineMarkers }
