/**
 * 修订轮提示词渲染（对应 Go `backend/internal/prompt/revise.go`）。
 */
import { goMap, goStruct, marshalGoJSON, type GoValue } from './json'
import { Template } from './template'
import type { Protocol, RubyAnnotation } from './prompt'
import { isTextProtocol } from './prompt'

/** 修订输入中的单条语义问题。 */
export interface ReviseIssue {
  code: string
  message: string
  /** 触发问题的源/目标文本片段，用于让修订范围尽量精确。 */
  /** （对应 Go 的 json:"snippet,omitempty"：空值时在线格式中省略） */
  snippet?: string
}

/** LLM 修订输入中的单个段落。 */
export interface ReviseSegment {
  id: string
  source: string
  target: string
  issues: ReviseIssue[]
}

/** 修订 prompt 渲染数据模型。 */
export interface ReviseData {
  sourceLang: string
  targetLang: string
  segments: ReviseSegment[]
  /** 控制 system/user 协议与解析通道。 */
  protocol: Protocol
  /**
   * 与 translate 轮同源：Segments 中的 target 已剥离注音标签，
   * 注音条目按段 id 经此下发，LLM 按 `rubyMode` 协议回填对齐结果。
   */
  rubyAnnotations: Record<string, RubyAnnotation[]>
  /** `"json" | "section" | ""`。 */
  rubyMode: string
}

/** LLM 对单段的修订结果（整段修订后译文）。 */
export interface ReviseRevision {
  id: string
  target: string
}

/** 修订 system 模板渲染器。 */
export class ReviseRenderer {
  private readonly system: Template

  constructor(systemContent: string) {
    if (systemContent === '') {
      throw new Error('prompt: revise system template content is empty')
    }
    this.system = new Template(systemContent)
  }

  /** 返回 `(system, user)`。 */
  render(data: ReviseData): { system: string; user: string } {
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
          Snippet: i.snippet,
        })),
      })),
      Protocol: protocol,
      RubyAnnotations: data.rubyAnnotations,
      RubyMode: data.rubyMode,
      HasRuby: () => {
        for (const list of Object.values(data.rubyAnnotations ?? {})) {
          if (list.length > 0) return true
        }
        return false
      },
    })

    if (isTextProtocol(protocol)) {
      return { system, user: buildReviseTextUser(data) }
    }
    const envelope = goStruct([
      { name: 'task', value: 'revise_translation' },
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
                  { name: 'snippet', value: i.snippet ?? '', omitEmpty: true },
                ]),
              ),
            },
          ]),
        ),
      },
      {
        name: 'ruby_annotations',
        value: buildRubyAnnotations(data.rubyAnnotations),
        omitEmpty: true,
      },
    ])
    return { system, user: marshalGoJSON(envelope) }
  }
}

/** 构建 `ruby_annotations` 字段（Go 的 `map[string][]RubyAnnotation`）。 */
function buildRubyAnnotations(annotations: Record<string, RubyAnnotation[]>): GoValue {
  const entries = new Map<string, GoValue>()
  for (const [id, list] of Object.entries(annotations ?? {})) {
    entries.set(
      id,
      list.map((a) =>
        goStruct([
          { name: 'id', value: a.id, omitEmpty: true },
          { name: 'base', value: a.base },
          { name: 'text', value: a.text },
        ]),
      ),
    )
  }
  return goMap(entries)
}

/**
 * 构建 text 模式的修订 user message。
 *
 * ```text
 * source_lang: ...
 * target_lang: ...
 *
 * [segment] id=<id>
 * source: ...
 * target: ...
 * ruby: 基底/标注#id, ...（仅含注音条目的段）
 * issues:
 * - code | snippet: message
 * ```
 */
export function buildReviseTextUser(data: ReviseData): string {
  let sb = ''
  sb += `source_lang: ${data.sourceLang}\n`
  sb += `target_lang: ${data.targetLang}\n`
  for (const seg of data.segments ?? []) {
    sb += `\n[segment] id=${seg.id}\n`
    sb += `source: ${seg.source}\n`
    sb += `target: ${seg.target}\n`
    const anns = (data.rubyAnnotations ?? {})[seg.id]
    if (anns && anns.length > 0) {
      sb += 'ruby: '
      anns.forEach((a, j) => {
        if (j > 0) sb += ', '
        sb += a.base
        sb += '/'
        sb += a.text
        if (a.id !== '') {
          sb += '#'
          sb += a.id
        }
      })
      sb += '\n'
    }
    sb += 'issues:\n'
    for (const iss of seg.issues) {
      sb += '- '
      sb += iss.code
      sb += ' | '
      sb += iss.message
      if (iss.snippet !== undefined && iss.snippet !== '') {
        sb += ' | snippet: '
        sb += iss.snippet
      }
      sb += '\n'
    }
  }
  return sb
}

/**
 * OpenAI 严格 JSON schema：`{revisions:[{id,target}]}`。
 *
 * `includeRuby` 时顶层追加必填 `ruby_output`（按 revisionIDs 键控）。
 */
export function reviseRevisionSchema(
  includeRuby: boolean,
  revisionIDs: readonly string[],
  rubyProtocolVersion?: number,
): Record<string, unknown> {
  const itemProps: Record<string, unknown> = {
    id: { type: 'string' },
    target: { type: 'string' },
  }
  const outerProps: Record<string, unknown> = {
    revisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: itemProps,
        required: ['id', 'target'],
        additionalProperties: false,
      },
    },
  }
  const required: string[] = ['revisions']
  if (includeRuby) {
    outerProps.ruby_output = rubyOutputSchema(revisionIDs, rubyProtocolVersion)
    required.push('ruby_output')
  }
  return {
    type: 'object',
    properties: outerProps,
    required,
    additionalProperties: false,
  }
}

/**
 * 构建 `ruby_output` 字段的对象 schema：按 ids 键控，
 * 每个值为 `{id,base,text,kind}` 条目数组。
 */
export function rubyOutputSchema(
  ids: readonly string[],
  protocolVersion?: number,
): Record<string, unknown> {
  const required =
    protocolVersion !== undefined && protocolVersion >= 2
      ? ['id', 'base', 'text', 'kind']
      : ['base', 'text', 'kind']
  const props: Record<string, unknown> = {}
  for (const id of ids) {
    props[id] = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          base: { type: 'string' },
          text: { type: 'string' },
          kind: { type: 'string', enum: ['phonetic', 'semantic', 'creative'] },
        },
        required,
        additionalProperties: false,
      },
    }
  }
  return { type: 'object', properties: props }
}

/**
 * 对解析出的 revisions 做 trim 与结构过滤：丢弃缺 id/target 的条目。
 *
 * 同一 id 的重复结果保留首次出现。
 */
export function normalizeReviseRevisions(revisions: readonly ReviseRevision[]): ReviseRevision[] {
  const out: ReviseRevision[] = []
  const seen = new Set<string>()
  for (const raw of revisions) {
    const rev: ReviseRevision = {
      id: raw.id.trim(),
      target: raw.target.trim(),
    }
    if (rev.id === '' || rev.target === '') continue
    if (seen.has(rev.id)) continue
    seen.add(rev.id)
    out.push(rev)
  }
  return out
}

/**
 * 解析 text 协议修订输出：
 *
 * ```text
 * [revisions]
 * id | target
 * ```
 *
 * target 含 `|` 时只按第一个分隔符切分。
 *
 * @returns `[revisions, recognized]`；`recognized=true` 表示命中 `[revisions]` 协议。
 */
export function parseReviseTextRevisions(text: string): [ReviseRevision[], boolean] {
  const stripped = stripCodeFence(text)
  const lines = stripped.split('\n')
  let inRevisions = false
  let hasHeader = false
  let hasRevisionContent = false
  const out: ReviseRevision[] = []

  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue
    if (line.toLowerCase() === '[revisions]') {
      inRevisions = true
      hasHeader = true
      continue
    }
    if (line.startsWith('[') && line.endsWith(']')) {
      if (hasHeader) inRevisions = false
      continue
    }
    if (!hasHeader || !inRevisions) continue
    hasRevisionContent = true
    const rev = parseReviseRevisionLine(line)
    if (!rev) continue
    out.push(rev)
  }
  return [normalizeReviseRevisions(out), hasHeader && (out.length > 0 || !hasRevisionContent)]
}

/** 解析单行修订结果。 */
function parseReviseRevisionLine(line: string): ReviseRevision | null {
  const sep = line.indexOf('|')
  if (sep < 0) return null
  const id = line.slice(0, sep).trim()
  const target = line.slice(sep + 1).trim()
  if (id === '' || target === '') return null
  return { id, target }
}

/**
 * 剥离 ```...``` 围栏，返回内部内容（支持首尾有非围栏文本）。
 *
 * 全仓唯一实现：repair 的 `stripCodeFence` 委托本函数。
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const start = trimmed.indexOf('```')
  if (start < 0) return trimmed
  let afterStart = trimmed.slice(start + 3)
  const idx = afterStart.indexOf('\n')
  if (idx >= 0) {
    afterStart = afterStart.slice(idx + 1)
  } else {
    return trimmed
  }
  const end = afterStart.lastIndexOf('```')
  if (end < 0) return afterStart.trim()
  return afterStart.slice(0, end).trim()
}
