/**
 * 裁决轮提示词渲染（对应 Go `backend/internal/prompt/adjudication.go`）。
 */
import { goStruct, marshalGoJSON } from './json'
import { Template } from './template'
import type { Protocol } from './prompt'
import { isTextProtocol } from './prompt'
import { stripCodeFence } from './revise'

/**
 * 可交由裁决轮做 LLM 降噪的质量问题 code 权威清单。
 *
 * 对应 Go `qa.AdjudicableCodes()`；清单本身在 `domain/qa` 中维护，
 * 此处仅作为 schema 生成的默认入参（调用方可注入更新后的清单）。
 */
export const ADJUDICABLE_CODES: readonly string[] = [
  'untranslated',
  'source_residual',
  'length_ratio',
  'punctuation_surplus',
]

/** 裁决输入中的单条规则问题。 */
export interface AdjudicationIssue {
  code: string
  message: string
  matchedText: string
}

/** 裁决输入中的单个段落。 */
export interface AdjudicationSegment {
  id: string
  source: string
  target: string
  issues: AdjudicationIssue[]
}

/** 裁决 prompt 渲染数据模型。 */
export interface AdjudicationData {
  sourceLang: string
  targetLang: string
  segments: AdjudicationSegment[]
  /** 控制 system/user 协议与解析通道。 */
  protocol: Protocol
}

/**
 * LLM 对单条 issue 的裁决结果。
 *
 * **字段名沿用 Go 结构体的 JSON tag**（snake_case）：该结构是 LLM 回复的解析产物，
 * 会与 Go 后端交换并再次序列化，必须逐字节一致。
 * `matched_text` 对应 Go 的 `json:"matched_text,omitempty"`（空值时省略）。
 */
export interface AdjudicationVerdict {
  id: string
  issue_code: string
  matched_text?: string
  /** `"real" | "false_positive"`。 */
  verdict: string
  reason: string
}

/** 裁决 system 模板渲染器。 */
export class AdjudicationRenderer {
  private readonly system: Template

  constructor(systemContent: string) {
    if (systemContent === '') {
      throw new Error('prompt: adjudication system template content is empty')
    }
    this.system = new Template(systemContent)
  }

  /** 返回 `(system, user)`。 */
  render(data: AdjudicationData): { system: string; user: string } {
    const protocol: Protocol = data.protocol === '' ? 'json_strict' : data.protocol
    const system = this.system.execute({
      SourceLang: data.sourceLang,
      TargetLang: data.targetLang,
      Segments: (data.segments ?? []).map((s) => ({
        ID: s.id,
        Source: s.source,
        Target: s.target,
        Issues: s.issues.map((i) => ({
          Code: i.code,
          Message: i.message,
          MatchedText: i.matchedText,
        })),
      })),
      Protocol: protocol,
    })

    if (isTextProtocol(protocol)) {
      return { system, user: buildAdjudicationTextUser(data) }
    }
    const envelope = goStruct([
      { name: 'task', value: 'adjudicate_quality_issues' },
      { name: 'source_lang', value: data.sourceLang, omitEmpty: true },
      { name: 'target_lang', value: data.targetLang, omitEmpty: true },
      {
        name: 'segments',
        value: (data.segments ?? []).map((s) =>
          goStruct([
            { name: 'id', value: s.id },
            { name: 'source', value: s.source },
            { name: 'target', value: s.target },
            {
              name: 'issues',
              value: s.issues.map((i) =>
                goStruct([
                  { name: 'code', value: i.code },
                  { name: 'message', value: i.message },
                  { name: 'matched_text', value: i.matchedText, omitEmpty: true },
                ]),
              ),
            },
          ]),
        ),
      },
    ])
    return { system, user: marshalGoJSON(envelope) }
  }
}

/**
 * 构建 text 模式的裁决 user message。
 *
 * ```text
 * source_lang: ...
 * target_lang: ...
 *
 * [segment] id=<id>
 * source: ...
 * target: ...
 * issues:
 * - code | matched_text: message
 * ```
 */
export function buildAdjudicationTextUser(data: AdjudicationData): string {
  let sb = ''
  sb += `source_lang: ${data.sourceLang}\n`
  sb += `target_lang: ${data.targetLang}\n`
  for (const seg of data.segments ?? []) {
    sb += `\n[segment] id=${seg.id}\n`
    sb += `source: ${seg.source}\n`
    sb += `target: ${seg.target}\n`
    sb += 'issues:\n'
    for (const iss of seg.issues) {
      sb += '- '
      sb += iss.code
      sb += ' | '
      sb += iss.matchedText
      sb += ': '
      sb += iss.message
      sb += '\n'
    }
  }
  return sb
}

/**
 * OpenAI 严格 JSON schema：`{verdicts:[{id,issue_code,matched_text,verdict,reason}]}`。
 *
 * `issue_code` enum 取自可裁决 code 权威清单。
 */
export function adjudicationVerdictSchema(
  codes: readonly string[] = ADJUDICABLE_CODES,
): Record<string, unknown> {
  const itemProps: Record<string, unknown> = {
    id: { type: 'string' },
    issue_code: { type: 'string', enum: codes.slice() },
    matched_text: { type: 'string' },
    verdict: { type: 'string', enum: ['real', 'false_positive'] },
    reason: { type: 'string' },
  }
  return {
    type: 'object',
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          properties: itemProps,
          required: ['id', 'issue_code', 'matched_text', 'verdict', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['verdicts'],
    additionalProperties: false,
  }
}

/**
 * 对解析出的 verdicts 做 trim 与合法性过滤：丢弃缺 id/issue_code 的条目。
 *
 * 与 JSON 路径语义一致（不校验 verdict 取值，那由 text 协议解析器负责）。
 */
export function normalizeAdjudicationVerdicts(
  verdicts: readonly AdjudicationVerdict[],
): AdjudicationVerdict[] {
  const out: AdjudicationVerdict[] = []
  for (const raw of verdicts) {
    const matchedText = raw.matched_text?.trim() ?? ''
    const v: AdjudicationVerdict = {
      id: raw.id.trim(),
      issue_code: raw.issue_code.trim(),
      ...(matchedText === '' ? {} : { matched_text: matchedText }),
      verdict: raw.verdict.trim(),
      reason: raw.reason.trim(),
    }
    if (v.id === '' || v.issue_code === '') continue
    out.push(v)
  }
  return out
}

/**
 * 裸数组兜底的领域判别器：判定候选数组是否像 verdicts 条目而非回显噪声。
 *
 * 真实裁决必带合法 verdict 值（real/false_positive）。
 */
export function validBareVerdictEntries(entries: readonly unknown[]): boolean {
  for (const e of entries) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return false
    const v = (e as { verdict?: unknown }).verdict
    if (v === 'real' || v === 'false_positive') return true
  }
  return false
}

/**
 * 解析 text 协议裁决输出：
 *
 * ```text
 * [verdicts]
 * id | issue_code | matched_text | verdict | reason
 * ```
 *
 * 兼容旧四字段 `id | issue_code | verdict | reason`（matched_text 为空）。
 *
 * @returns `[verdicts, recognized]`；`recognized=true` 表示命中 `[verdicts]` 协议。
 */
export function parseAdjudicationTextVerdicts(text: string): [AdjudicationVerdict[], boolean] {
  const stripped = stripCodeFence(text)
  const lines = stripped.split('\n')
  let inVerdicts = false
  let hasHeader = false
  let hasVerdictContent = false
  const out: AdjudicationVerdict[] = []

  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue
    if (line.toLowerCase() === '[verdicts]') {
      inVerdicts = true
      hasHeader = true
      continue
    }
    if (line.startsWith('[') && line.endsWith(']')) {
      if (hasHeader) inVerdicts = false
      continue
    }
    if (hasHeader && !inVerdicts) continue
    if (hasHeader) hasVerdictContent = true
    const v = parseAdjudicationVerdictLine(line)
    if (!v) continue
    out.push(v)
  }
  return [out, out.length > 0 || (hasHeader && !hasVerdictContent)]
}

/** 解析单行裁决结果。 */
function parseAdjudicationVerdictLine(line: string): AdjudicationVerdict | null {
  const parts = line.split('|')
  if (parts.length < 3) return null
  const id = (parts[0] as string).trim()
  const issueCode = (parts[1] as string).trim()
  let matchedText = ''
  let verdict = ''
  let reason = ''

  if (parts.length >= 4) {
    const p2 = (parts[2] as string).trim()
    const p3 = (parts[3] as string).trim()
    if (p2 === 'real' || p2 === 'false_positive') {
      // 旧格式：id | code | verdict | reason...
      verdict = p2
      reason = parts
        .slice(3)
        .map((p) => p.trim())
        .join(' | ')
    } else if (p3 === 'real' || p3 === 'false_positive') {
      // 新格式：id | code | matched_text | verdict | reason...
      matchedText = p2
      verdict = p3
      reason = parts
        .slice(4)
        .map((p) => p.trim())
        .join(' | ')
    } else {
      return null
    }
  } else {
    // 三段：id | code | verdict
    verdict = (parts[2] as string).trim()
  }

  if (id === '' || issueCode === '') return null
  if (verdict !== 'real' && verdict !== 'false_positive') return null
  return matchedText === ''
    ? { id, issue_code: issueCode, verdict, reason }
    : { id, issue_code: issueCode, matched_text: matchedText, verdict, reason }
}
