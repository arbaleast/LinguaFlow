/**
 * prune（术语精简）提示词渲染（对应 Go `backend/internal/prompt/prune.go`）。
 */
import { goStruct, marshalGoJSON } from './json'
import { Template } from './template'
import type { Protocol } from './prompt'
import { isTextProtocol } from './prompt'

/** prune（术语精简）渲染时的数据模型。 */
export interface PruneData {
  sourceLang: string
  targetLang: string
  entries: PruneEntry[]
  /** 控制 system/user 协议与解析通道。 */
  protocol: Protocol
}

/** 术语精简输入的单条术语。 */
export interface PruneEntry {
  source: string
  target: string
  notes: string
}

/** prune system 模板渲染器。 */
export class PruneRenderer {
  private readonly system: Template

  constructor(systemContent: string) {
    if (systemContent === '') {
      throw new Error('prompt: prune system template content is empty')
    }
    this.system = new Template(systemContent)
  }

  /** 返回 `(system, user)`。 */
  render(data: PruneData): { system: string; user: string } {
    const protocol: Protocol = data.protocol === '' ? 'json_strict' : data.protocol
    const system = this.system.execute({
      SourceLang: data.sourceLang,
      TargetLang: data.targetLang,
      Entries: (data.entries ?? []).map((e) => ({
        Source: e.source,
        Target: e.target,
        Notes: e.notes,
      })),
      Protocol: protocol,
    })

    if (isTextProtocol(protocol)) {
      return { system, user: buildPruneTextUser(data) }
    }
    const envelope = goStruct([
      { name: 'task', value: 'refine_glossary' },
      { name: 'source_lang', value: data.sourceLang, omitEmpty: true },
      { name: 'target_lang', value: data.targetLang, omitEmpty: true },
      {
        name: 'entries',
        value: (data.entries ?? []).map((e) =>
          goStruct([
            { name: 'source', value: e.source },
            { name: 'target', value: e.target },
            { name: 'notes', value: e.notes },
          ]),
        ),
      },
    ])
    return { system, user: marshalGoJSON(envelope) }
  }
}

/**
 * 构建 text 模式的 prune user message。
 *
 * ```text
 * source_lang: ...
 * target_lang: ...
 *
 * [entries]
 * source | target | notes
 * ...
 * ```
 */
export function buildPruneTextUser(data: PruneData): string {
  let sb = ''
  sb += `source_lang: ${data.sourceLang}\n`
  sb += `target_lang: ${data.targetLang}\n`
  sb += '\n[entries]\n'
  for (const e of data.entries ?? []) {
    sb += e.source
    sb += ' | '
    sb += e.target
    if (e.notes !== '') {
      sb += ' | '
      sb += e.notes
    }
    sb += '\n'
  }
  return sb
}
