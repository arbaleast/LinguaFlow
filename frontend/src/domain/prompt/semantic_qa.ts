/**
 * 语义质检提示词渲染（对应 Go `backend/internal/prompt/semantic_qa.go`）。
 */
import { goStruct, marshalGoJSON } from './json'
import { Template } from './template'
import type { Protocol } from './prompt'
import { isTextProtocol } from './prompt'
import { stripCodeFence } from './revise'

/**
 * 语义质检轮次维护的 issue code 清单。
 *
 * 对应 Go `qa.SemanticQACodes()`；清单本身在 `domain/qa` 中维护，
 * 此处仅作为默认入参（调用方可注入更新后的清单）。
 */
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

/** 语义质检输入中的单个段落。 */
export interface SemanticQASegment {
  id: string
  source: string
  target: string
}

/** 语义质检 prompt 渲染数据模型。 */
export interface SemanticQAData {
  sourceLang: string
  targetLang: string
  segments: SemanticQASegment[]
  /** 控制 system/user 协议与解析通道。 */
  protocol: Protocol
}

/** LLM 对单条语义问题的扫描结果。 */
export interface SemanticQAIssue {
  id: string
  code: string
  message: string
  /** 触发问题的精确源/目标文本片段；用于跨度级去重与裁决。 */
  /** （对应 Go 的 json:"snippet,omitempty"：空值时在线格式中省略） */
  snippet?: string
}

/** 语义质检 system 模板渲染器。 */
export class SemanticQARenderer {
  private readonly system: Template

  constructor(systemContent: string) {
    if (systemContent === '') {
      throw new Error('prompt: semantic_qa system template content is empty')
    }
    this.system = new Template(systemContent)
  }

  /** 返回 `(system, user)`。 */
  render(data: SemanticQAData): { system: string; user: string } {
    const protocol: Protocol = data.protocol === '' ? 'json_strict' : data.protocol
    const system = this.system.execute({
      SourceLang: data.sourceLang,
      TargetLang: data.targetLang,
      Segments: (data.segments ?? []).map((s) => ({
        ID: s.id,
        Source: s.source,
        Target: s.target,
      })),
      Protocol: protocol,
    })

    if (isTextProtocol(protocol)) {
      return { system, user: buildSemanticQATextUser(data) }
    }
    const envelope = goStruct([
      { name: 'task', value: 'semantic_quality_scan' },
      { name: 'source_lang', value: data.sourceLang, omitEmpty: true },
      { name: 'target_lang', value: data.targetLang, omitEmpty: true },
      {
        name: 'segments',
        value: (data.segments ?? []).map((s) =>
          goStruct([
            { name: 'id', value: s.id },
            { name: 'source', value: s.source },
            { name: 'target', value: s.target },
          ]),
        ),
      },
    ])
    return { system, user: marshalGoJSON(envelope) }
  }
}

/**
 * 构建 text 模式的语义质检 user message。
 *
 * ```text
 * source_lang: ...
 * target_lang: ...
 *
 * [segment] id=<id>
 * source: ...
 * target: ...
 * ```
 */
export function buildSemanticQATextUser(data: SemanticQAData): string {
  let sb = ''
  sb += `source_lang: ${data.sourceLang}\n`
  sb += `target_lang: ${data.targetLang}\n`
  for (const seg of data.segments ?? []) {
    sb += `\n[segment] id=${seg.id}\n`
    sb += `source: ${seg.source}\n`
    sb += `target: ${seg.target}\n`
  }
  return sb
}

/** 报告 code 是否由语义质检轮次维护。 */
export function isSemanticQACode(
  code: string,
  codes: readonly string[] = SEMANTIC_QA_CODES,
): boolean {
  return codes.includes(code)
}

/**
 * OpenAI 严格 JSON schema：`{issues:[{id,code,message,snippet}]}`。
 */
export function semanticQAIssueSchema(
  codes: readonly string[] = SEMANTIC_QA_CODES,
): Record<string, unknown> {
  const itemProps: Record<string, unknown> = {
    id: { type: 'string' },
    code: { type: 'string', enum: codes.slice() },
    message: { type: 'string' },
    snippet: { type: 'string' },
  }
  return {
    type: 'object',
    properties: {
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: itemProps,
          required: ['id', 'code', 'message', 'snippet'],
          additionalProperties: false,
        },
      },
    },
    required: ['issues'],
    additionalProperties: false,
  }
}

/**
 * 对解析出的 issues 做 trim 与合法性过滤：丢弃缺 id/code 的条目，
 * 丢弃 code 不属于语义质检白名单的条目。
 */
export function normalizeSemanticQAIssues(
  issues: readonly SemanticQAIssue[],
  codes: readonly string[] = SEMANTIC_QA_CODES,
): SemanticQAIssue[] {
  const out: SemanticQAIssue[] = []
  for (const raw of issues) {
    const snippet = raw.snippet?.trim() ?? ''
    const iss: SemanticQAIssue = {
      id: raw.id.trim(),
      code: raw.code.trim(),
      message: raw.message.trim(),
      ...(snippet === '' ? {} : { snippet }),
    }
    if (iss.id === '' || iss.code === '') continue
    if (!isSemanticQACode(iss.code, codes)) continue
    out.push(iss)
  }
  return out
}

/**
 * 解析 text 协议语义质检输出：
 *
 * ```text
 * [issues]
 * id | code | snippet | message
 * ```
 *
 * 兼容旧三字段 `id | code | message`（snippet 为空）。
 * message/snippet 含 `|` 时：四段及以上取前三段为 id/code/snippet，剩余并入 message。
 *
 * @returns `[issues, recognized]`；`recognized=true` 表示命中 `[issues]` 协议。
 */
export function parseSemanticQATextIssues(
  text: string,
  codes: readonly string[] = SEMANTIC_QA_CODES,
): [SemanticQAIssue[], boolean] {
  const stripped = stripCodeFence(text)
  const lines = stripped.split('\n')
  let inIssues = false
  let hasHeader = false
  let hasIssueContent = false
  const out: SemanticQAIssue[] = []

  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue
    if (line.toLowerCase() === '[issues]') {
      inIssues = true
      hasHeader = true
      continue
    }
    if (line.startsWith('[') && line.endsWith(']')) {
      if (hasHeader) inIssues = false
      continue
    }
    if (hasHeader && !inIssues) continue
    if (hasHeader) hasIssueContent = true
    const iss = parseSemanticQAIssueLine(line, codes)
    if (!iss) continue
    out.push(iss)
  }
  return [out, out.length > 0 || (hasHeader && !hasIssueContent)]
}

/** 解析单行语义质检结果。 */
function parseSemanticQAIssueLine(line: string, codes: readonly string[]): SemanticQAIssue | null {
  const parts = line.split('|')
  if (parts.length < 2) return null
  const id = (parts[0] as string).trim()
  const code = (parts[1] as string).trim()
  let snippet = ''
  let message = ''
  if (parts.length === 2) {
    // id | code
  } else if (parts.length === 3) {
    // 兼容旧格式：id | code | message
    message = (parts[2] as string).trim()
  } else {
    // id | code | snippet | message...
    snippet = (parts[2] as string).trim()
    message = parts
      .slice(3)
      .map((p) => p.trim())
      .join(' | ')
  }
  if (id === '' || code === '') return null
  if (!isSemanticQACode(code, codes)) return null
  return snippet === '' ? { id, code, message } : { id, code, message, snippet }
}
