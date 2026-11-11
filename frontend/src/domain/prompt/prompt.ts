/**
 * 翻译轮提示词渲染（对应 Go `backend/internal/prompt/prompt.go`）。
 *
 * JSON 协议：user message 是 JSON envelope
 *
 * ```json
 * {"source_lang":"...","target_lang":"...","segments":{"<id>":{"source":"...","translate":true}}}
 * ```
 *
 * Text 协议：user message 是纯文本编号格式
 *
 * ```text
 * [1] 需要翻译的段落
 * [*] 上下文参考段落
 * ```
 *
 * 模型回复要求：
 *
 * - JSON：`{"translations":{"<id>":"<text>", ...}}`
 * - Text：`[编号] 翻译文本`
 *
 * **字段名约定**：数据模型的字段名沿用 Go 结构体的名字（`SourceLang` / `TargetLang` /
 * `Protocol` / `Glossary` …），因为它们同时是 **Go 模板的访问路径**
 * （模板里写 `{{.SourceLang}}`）。这与「TS 用 camelCase」的常规约定不同，
 * 是刻意的例外。
 */
import { goMap, goStruct, marshalGoJSON, type GoValue } from './json'
import { Template, type FuncMap } from './template'

/** 单段模式下 envelope 内唯一段的 id。translate stage 用它回写。 */
export const SINGLE_ID = '0'

/** Ruby 模式的合法取值。 */
export const RUBY_MODE_JSON = 'json'
export const RUBY_MODE_INLINE = 'inline'
export const RUBY_MODE_SECTION = 'section'

/**
 * 提示词与解析共用的 I/O 协议（三态，非后端 response_format 四值一一对应）。
 *
 * 模板中可用 `eq .Protocol "text"|"json_loose"|"json_strict"`。
 */
export type Protocol = 'text' | 'json_loose' | 'json_strict' | ''

/** Ruby 标注（用于在提示词中展示注音信息）。 */
export interface RubyAnnotation {
  /** 段内条目 id，供 LLM 回显关联。 */
  id: string
  /** 基底文本。 */
  base: string
  /** 标注文本。 */
  text: string
}

/** 术语命中（用于在提示词中展示术语表）。 */
export interface GlossaryEntry {
  source: string
  target: string
  notes: string
}

/** 翻译记忆命中。 */
export interface TMHint {
  source: string
  target: string
  score: number
}

/** 批量翻译时的一段输入。 */
export interface SegmentInput {
  /** 在 envelope 中作为 segments 的 key，需要在批内唯一且稳定。 */
  id: string
  /** 原文。 */
  source: string
  /** 默认 true；false 表示仅作上下文参考，不需要翻译。 */
  translate: boolean
}

/** 渲染时的数据模型。 */
export interface PromptData {
  sourceLang: string
  targetLang: string
  /** 单段模式的原文（批量模式为空）。 */
  source: string
  /** 批量模式的段落列表（单段模式为空）。 */
  segments: SegmentInput[]
  glossary: GlossaryEntry[]
  tmHints: TMHint[]
  /** 提示词模板可访问的全局变量。 */
  vars: Record<string, unknown>
  /** 是否在 system prompt 中追加 inline 抽取指令。 */
  inlineBootstrap: boolean
  /** inline 模式每批返回上限；仅在 `inlineBootstrap` 为 true 时有效。 */
  maxBootstrapTerms: number
  /** 控制 system/user 协议与解析通道。 */
  protocol: Protocol
  /** 段 ID → 标注列表。 */
  rubyAnnotations: Record<string, RubyAnnotation[]>
  /** `"json" | "section" | ""`。 */
  rubyMode: string
}

/**
 * 把 TS 数据模型转换为 **Go 模板视图**。
 *
 * 模板访问的字段名与 Go 结构体一致（`SourceLang` / `TargetLang` / `Protocol` …），
 * `HasRuby` 是 Go 的零参方法，故以函数属性提供。
 */
export function toTemplateView(data: PromptData): Record<string, unknown> {
  return {
    SourceLang: data.sourceLang,
    TargetLang: data.targetLang,
    Source: data.source,
    Segments: data.segments.map((s) => ({
      ID: s.id,
      Source: s.source,
      Translate: s.translate,
    })),
    Glossary: data.glossary.map((g) => ({
      Source: g.source,
      Target: g.target,
      Notes: g.notes,
    })),
    TMHints: data.tmHints.map((h) => ({
      Source: h.source,
      Target: h.target,
      Score: h.score,
    })),
    Vars: data.vars,
    InlineBootstrap: data.inlineBootstrap,
    MaxBootstrapTerms: data.maxBootstrapTerms,
    Protocol: data.protocol,
    RubyAnnotations: data.rubyAnnotations,
    RubyMode: data.rubyMode,
    // Go 的零参方法：模板里 `{{.HasRuby}}` 会调用它。
    HasRuby: () => hasRuby(data.rubyAnnotations),
  }
}

/** 判断当前数据中是否存在 Ruby 标注信息。 */
export function hasRuby(annotations: Record<string, RubyAnnotation[]>): boolean {
  for (const list of Object.values(annotations ?? {})) {
    if (list.length > 0) return true
  }
  return false
}

/** 模板函数表（Go 的 `templateFuncs`）。 */
export const TEMPLATE_FUNCS: FuncMap = {
  mul: (a: unknown, b: unknown) => Number(a) * Number(b),
}

/**
 * 将后端 `options.response_format` 映射为提示词/解析协议。
 *
 * 未知值按 `json_loose` 处理（需在 prompt 中写清形状，避免误当 schema 已约束）。
 */
export function protocolFromResponseMode(mode: string): Protocol {
  switch (mode) {
    case 'text':
      return 'text'
    case '':
    case 'json_schema':
      return 'json_strict'
    case 'json_object':
    case 'none':
      return 'json_loose'
    default:
      return 'json_loose'
  }
}

/** 是否为纯文本协议。 */
export function isTextProtocol(protocol: Protocol): boolean {
  return protocol === 'text'
}

/** 是否为 JSON 协议（loose 或 strict）。 */
export function isJSONProtocol(protocol: Protocol): boolean {
  return protocol === 'json_loose' || protocol === 'json_strict'
}

/** 是否可省略 system 中的完整 JSON 形状示例（仅 `json_strict`）。 */
export function omitsJSONShape(protocol: Protocol): boolean {
  return protocol === 'json_strict'
}

/** 翻译轮 system 模板渲染器。 */
export class Renderer {
  private readonly system: Template

  constructor(systemPrompt: string) {
    if (systemPrompt === '') {
      throw new Error(
        'prompt: system prompt content is empty; configure a prompt template in your config file',
      )
    }
    this.system = new Template(systemPrompt, TEMPLATE_FUNCS)
  }

  /**
   * 返回 `(system, user)`。
   *
   * 协议为 `text` 时 user 为纯文本编号格式，否则为 JSON。
   */
  render(data: PromptData): { system: string; user: string } {
    const protocol: Protocol = data.protocol === '' ? 'json_strict' : data.protocol
    const segs: SegmentInput[] =
      data.segments.length === 0
        ? [{ id: SINGLE_ID, source: data.source, translate: true }]
        : data.segments

    const system = this.system.execute(toTemplateView({ ...data, protocol }))

    if (isTextProtocol(protocol)) {
      const mode = data.rubyMode === '' ? RUBY_MODE_SECTION : data.rubyMode
      return { system, user: buildTextUser(segs, data.rubyAnnotations, mode) }
    }
    return { system, user: buildJSONUser(data, segs) }
  }
}

/**
 * 构建 JSON 模式的 user message。
 *
 * 字段顺序与 Go 的 `userEnvelope` 结构体声明顺序一致（Go 的 `json.Marshal`
 * 对 struct 保留声明顺序）。
 */
export function buildJSONUser(data: PromptData, segs: readonly SegmentInput[]): string {
  const segments = new Map<string, GoValue>()
  for (const s of segs) {
    segments.set(
      s.id,
      goStruct([
        { name: 'source', value: s.source },
        { name: 'translate', value: s.translate },
      ]),
    )
  }
  const envelope = goStruct([
    { name: 'source_lang', value: data.sourceLang, omitEmpty: true },
    { name: 'target_lang', value: data.targetLang, omitEmpty: true },
    { name: 'segments', value: goMap(segments) },
    {
      name: 'ruby_annotations',
      value: buildRubyAnnotationsValue(data.rubyAnnotations),
      omitEmpty: true,
    },
  ])
  return marshalGoJSON(envelope)
}

/** 构建 `ruby_annotations` 字段（Go 的 `map[string][]RubyAnnotation`）。 */
function buildRubyAnnotationsValue(annotations: Record<string, RubyAnnotation[]>): GoValue {
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
 * 构建 text 模式的 user message。
 *
 * 格式固定，与解析逻辑对应：
 *
 * - 需要翻译的段落：`[编号] 原文`
 * - 上下文参考段落：`[*] 原文`
 * - `rubyInputMode="inline"`：注音以 ⟦ruby:base/text⟧ 内联到原文
 * - `rubyInputMode="section"`：注音以 `[ruby]` 独立段落追加；条目带 id 时以 `基底/标注#id` 展示
 */
export function buildTextUser(
  segs: readonly SegmentInput[],
  rubyAnnotations: Record<string, RubyAnnotation[]>,
  rubyInputMode: string,
): string {
  let sb = ''
  segs.forEach((s, i) => {
    if (i > 0) sb += '\n'
    if (s.translate) {
      sb += `[${s.id}] `
      const anns = (rubyAnnotations ?? {})[s.id]
      if (rubyInputMode === RUBY_MODE_INLINE && anns && anns.length > 0) {
        sb += inlineRubyInSource(s.source, anns)
      } else {
        sb += s.source
      }
    } else {
      sb += '[*] '
      sb += s.source
    }
  })

  if (rubyInputMode === RUBY_MODE_SECTION && Object.keys(rubyAnnotations).length > 0) {
    sb += '\n[ruby]'
    for (const s of segs) {
      if (!s.translate) continue
      const anns = rubyAnnotations[s.id]
      if (!anns || anns.length === 0) continue
      sb += '\n'
      sb += `${s.id}: `
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
    }
  }

  return sb
}

/**
 * 将注音以 ⟦ruby:base/text⟧ 格式内联到源文本中。
 *
 * 按注音顺序从左到右匹配基底文本，替换为标记。
 */
export function inlineRubyInSource(source: string, anns: readonly RubyAnnotation[]): string {
  if (anns.length === 0) return source
  let sb = ''
  let pos = 0
  for (const a of anns) {
    // Go 用 `strings.Index(source[pos:], a.Base)`（字节下标）；此处用码点下标，
    // 切片坐标系一致，截出的子串与 Go 相同。
    const idx = source.indexOf(a.base, pos)
    if (idx === -1) continue
    sb += source.slice(pos, idx)
    sb += '⟦ruby:'
    sb += a.base
    sb += '/'
    sb += a.text
    sb += '⟧'
    pos = idx + a.base.length
  }
  sb += source.slice(pos)
  return sb
}
