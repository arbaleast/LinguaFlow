/**
 * bootstrap（术语抽取）提示词渲染（对应 Go `backend/internal/prompt/bootstrap.go`）。
 */
import { goStruct, marshalGoJSON, type GoValue } from './json'
import { Template } from './template'
import type { Protocol } from './prompt'
import { isTextProtocol } from './prompt'

/** bootstrap stage 渲染时的数据模型。 */
export interface BootstrapData {
  sourceLang: string
  targetLang: string
  texts: string[]
  existing: string[]
  maxTerms: number
  /** 控制 system/user 协议与解析通道。 */
  protocol: Protocol
}

/** LLM 抽取出的一条候选术语。 */
export interface BootstrapEntry {
  source: string
  target: string
  notes: string
}

/** bootstrap system 模板渲染器。 */
export class BootstrapRenderer {
  private readonly system: Template

  constructor(systemContent: string) {
    if (systemContent === '') {
      throw new Error('prompt: bootstrap system template content is empty')
    }
    this.system = new Template(systemContent)
  }

  /** 返回 `(system, user)`。 */
  render(data: BootstrapData): { system: string; user: string } {
    const maxTerms = data.maxTerms < 1 ? 20 : data.maxTerms
    const protocol: Protocol = data.protocol === '' ? 'json_strict' : data.protocol
    const view = {
      SourceLang: data.sourceLang,
      TargetLang: data.targetLang,
      Texts: data.texts,
      Existing: data.existing,
      MaxTerms: maxTerms,
      Protocol: protocol,
    }
    const system = this.system.execute(view)

    if (isTextProtocol(protocol)) {
      return { system, user: buildBootstrapTextUser({ ...data, maxTerms }) }
    }
    const envelope = goStruct([
      { name: 'task', value: 'extract_terms' },
      { name: 'source_lang', value: data.sourceLang, omitEmpty: true },
      { name: 'target_lang', value: data.targetLang, omitEmpty: true },
      { name: 'existing', value: data.existing ?? [], omitEmpty: true },
      { name: 'texts', value: data.texts ?? [] },
    ])
    return { system, user: marshalGoJSON(envelope) }
  }
}

/**
 * 构建 text 模式的 bootstrap user message。
 *
 * ```text
 * source_lang: ...
 * target_lang: ...
 * max_terms: N
 *
 * [existing]
 * term1
 * ...
 *
 * [texts]
 * ---
 * <text0>
 * ---
 * <text1>
 * ```
 */
export function buildBootstrapTextUser(data: BootstrapData): string {
  let sb = ''
  sb += `source_lang: ${data.sourceLang}\n`
  sb += `target_lang: ${data.targetLang}\n`
  sb += `max_terms: ${data.maxTerms}\n`

  const existing = data.existing ?? []
  if (existing.length > 0) {
    sb += '\n[existing]\n'
    for (const e of existing) {
      sb += `${e}\n`
    }
  }

  sb += '\n[texts]\n'
  for (const t of data.texts ?? []) {
    sb += '---\n'
    sb += `${t}\n`
  }
  return sb
}

/**
 * OpenAI 严格 JSON schema：`{glossary:[{source,target,notes}]}`。
 *
 * 严格模式要求每个对象列出 required = 所有属性、additionalProperties=false。
 */
export function bootstrapSchema(): Record<string, unknown> {
  const itemProps: Record<string, unknown> = {
    source: { type: 'string' },
    target: { type: 'string' },
    notes: { type: 'string' },
  }
  return {
    type: 'object',
    properties: {
      glossary: {
        type: 'array',
        items: {
          type: 'object',
          properties: itemProps,
          required: ['source', 'target', 'notes'],
          additionalProperties: false,
        },
      },
    },
    required: ['glossary'],
    additionalProperties: false,
  }
}

/**
 * 从 LLM 回复中提取首个 JSON 对象并解析 `{glossary:[...]}`。
 *
 * 容错：允许 ```json 围栏与前后说明文字。
 *
 * 返回 `{entries, error}`：Go 侧是 `(entries, error)` 二元返回，
 * `error !== null` 表示未找到 JSON 对象或解析失败。
 */
export function parseBootstrapResponse(text: string): {
  entries: BootstrapEntry[]
  error: string | null
} {
  const body = jsonObjectSlice(text)
  if (body === '') {
    return { entries: [], error: 'no JSON object found in bootstrap response' }
  }
  let env: { glossary?: BootstrapEntry[] }
  try {
    env = JSON.parse(body) as { glossary?: BootstrapEntry[] }
  } catch (error) {
    return {
      entries: [],
      error: `unmarshal glossary: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const list = env.glossary ?? []
  const out: BootstrapEntry[] = []
  const seen = new Set<string>()
  for (const raw of list) {
    const e: BootstrapEntry = {
      source: (raw.source ?? '').trim(),
      target: (raw.target ?? '').trim(),
      notes: (raw.notes ?? '').trim(),
    }
    if (e.source === '' || e.target === '') continue
    // LLM 偶尔重复同一 source；保留首次出现。
    if (seen.has(e.source)) continue
    seen.add(e.source)
    out.push(e)
  }
  return { entries: out, error: null }
}

/**
 * 从 text 中截取首个 `{` 到与之配对的 `}` 之间的子串。
 *
 * （Go 侧同名函数 `jsonObjectSlice`。）
 */
export function jsonObjectSlice(text: string): string {
  const start = text.indexOf('{')
  if (start < 0) return ''
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i] as string
    if (inStr) {
      if (esc) {
        esc = false
        continue
      }
      if (c === '\\') {
        esc = true
      } else if (c === '"') {
        inStr = false
      }
      continue
    }
    if (c === '"') {
      inStr = true
    } else if (c === '{') {
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0) {
        return text.slice(start, i + 1)
      }
    }
  }
  return ''
}

/** 供其他模块复用的 Go 值构造辅助。 */
export function goStringArray(values: readonly string[]): GoValue {
  return values.slice()
}
