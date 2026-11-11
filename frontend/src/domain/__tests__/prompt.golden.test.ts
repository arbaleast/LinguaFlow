/**
 * `domain/prompt` 黄金向量对拍测试。
 *
 * 期望值全部来自 Go `backend/internal/prompt` 的真实输出
 * （由 `backend/internal/prompt/golden_vectors_test.go` 导出），
 * 本移植层必须与之 100% 一致。
 *
 * 覆盖：Go `text/template` 渲染（用**后端内置模板**）、JSON / text 两种 user 协议、
 * 注音内联与 section 输出、bootstrap / prune / revise / adjudication / semantic_qa
 * 五个渲染器、各协议的响应解析器。
 */
import { describe, expect, it } from 'vitest'
import promptFixture from '../__fixtures__/prompt.json'
import {
  AdjudicationRenderer,
  adjudicationVerdictSchema,
  BootstrapRenderer,
  bootstrapSchema,
  hasRuby,
  inlineRubyInSource,
  parseAdjudicationTextVerdicts,
  parseBootstrapResponse,
  parseReviseTextRevisions,
  parseSemanticQATextIssues,
  protocolFromResponseMode,
  PruneRenderer,
  Renderer,
  ReviseRenderer,
  SemanticQARenderer,
  semanticQAIssueSchema,
  stripCodeFence,
  BUILTIN_ADJUDICATION_PROMPT_TEMPLATE,
  BUILTIN_BOOTSTRAP_PROMPT_TEMPLATE,
  BUILTIN_PRUNE_PROMPT_TEMPLATE,
  BUILTIN_REVISE_PROMPT_TEMPLATE,
  BUILTIN_SEMANTIC_QA_PROMPT_TEMPLATE,
  BUILTIN_TRANSLATION_PROMPT_TEMPLATE,
  type AdjudicationData,
  type AdjudicationIssue,
  type BootstrapData,
  type GlossaryEntry,
  type PromptData,
  type PruneEntry,
  type Protocol,
  type ReviseIssue,
  type ReviseSegment,
  type RubyAnnotation,
  type SemanticQASegment,
  type SegmentInput,
  type TMHint,
} from '../prompt'
import { argString, runGolden, type GoldenFixture } from './helpers/golden'

const fixture = promptFixture as unknown as GoldenFixture

/** 黄金向量中的渲染数据（snake_case 线格式）。 */
interface WireData {
  source_lang: string
  target_lang: string
  source: string
  segments: Array<{ id: string; source: string; translate: boolean }>
  glossary: Array<{ source: string; target: string; notes: string }>
  tm_hints: Array<{ source: string; target: string; score: number }>
  inline_bootstrap: boolean
  max_bootstrap_terms: number
  protocol: Protocol
  ruby_annotations: Record<string, Array<{ id: string; base: string; text: string }>>
  ruby_mode: string
}

function wireToPromptData(wire: WireData): PromptData {
  return {
    sourceLang: wire.source_lang,
    targetLang: wire.target_lang,
    source: wire.source,
    segments: (wire.segments ?? []).map((s) => ({
      id: s.id,
      source: s.source,
      translate: s.translate,
    })),
    glossary: (wire.glossary ?? []).map((g) => ({
      source: g.source,
      target: g.target,
      notes: g.notes,
    })),
    tmHints: (wire.tm_hints ?? []).map((h) => ({
      source: h.source,
      target: h.target,
      score: h.score,
    })),
    vars: {},
    inlineBootstrap: wire.inline_bootstrap,
    maxBootstrapTerms: wire.max_bootstrap_terms,
    protocol: wire.protocol,
    rubyAnnotations: Object.fromEntries(
      Object.entries(wire.ruby_annotations ?? {}).map(([id, list]) => [
        id,
        list.map((a) => ({ id: a.id, base: a.base, text: a.text })),
      ]),
    ),
    rubyMode: wire.ruby_mode,
  }
}

/** 读取黄金向量中的渲染数据。 */
function wireData(args: Record<string, unknown>): WireData {
  return args.data as unknown as WireData
}

/** 裁决 issue 的线格式 → 领域类型。 */
function wireAdjudicationIssues(
  issues: Array<{ code: string; message: string; matched_text: string }>,
): AdjudicationIssue[] {
  return (issues ?? []).map((i) => ({
    code: i.code,
    message: i.message,
    matchedText: i.matched_text,
  }))
}

/** 修订 issue 的线格式 → 领域类型。 */
function wireReviseIssues(
  issues: Array<{ code: string; message: string; snippet: string }>,
): ReviseIssue[] {
  return issues.map((i) => ({
    code: i.code,
    message: i.message,
    snippet: i.snippet,
  }))
}

describe('domain/prompt 黄金向量', () => {
  it('覆盖全部黄金向量', () => {
    runGolden(fixture, {
      'prompt.protocol_from_response_mode': (args) => ({
        protocol: protocolFromResponseMode(argString(args, 'mode')),
      }),

      'prompt.render': (args) => {
        const renderer = new Renderer(BUILTIN_TRANSLATION_PROMPT_TEMPLATE)
        const { system, user } = renderer.render(wireToPromptData(wireData(args)))
        return { system, user }
      },

      'prompt.bootstrap.render': (args) => {
        const wire = wireData(args) as unknown as BootstrapData & {
          texts: string[]
          existing: string[]
          max_terms: number
        }
        const renderer = new BootstrapRenderer(BUILTIN_BOOTSTRAP_PROMPT_TEMPLATE)
        const { system, user } = renderer.render({
          sourceLang: wire.source_lang,
          targetLang: wire.target_lang,
          texts: wire.texts,
          existing: wire.existing,
          maxTerms: wire.max_terms,
          protocol: wire.protocol,
        })
        return { system, user }
      },

      'prompt.prune.render': (args) => {
        const wire = wireData(args) as unknown as {
          source_lang: string
          target_lang: string
          entries: PruneEntry[]
          protocol: Protocol
        }
        const renderer = new PruneRenderer(BUILTIN_PRUNE_PROMPT_TEMPLATE)
        const { system, user } = renderer.render({
          sourceLang: wire.source_lang,
          targetLang: wire.target_lang,
          entries: wire.entries,
          protocol: wire.protocol,
        })
        return { system, user }
      },

      'prompt.revise.render': (args) => {
        const wire = wireData(args) as unknown as {
          source_lang: string
          target_lang: string
          segments: ReviseSegment[]
          protocol: Protocol
          ruby_annotations: Record<string, RubyAnnotation[]>
          ruby_mode: string
        }
        const renderer = new ReviseRenderer(BUILTIN_REVISE_PROMPT_TEMPLATE)
        const { system, user } = renderer.render({
          sourceLang: wire.source_lang,
          targetLang: wire.target_lang,
          segments: wire.segments.map((s) => ({
            id: s.id,
            source: s.source,
            target: s.target,
            issues: wireReviseIssues(s.issues ?? []),
          })),
          protocol: wire.protocol,
          rubyAnnotations: wire.ruby_annotations,
          rubyMode: wire.ruby_mode,
        })
        return { system, user }
      },

      'prompt.adjudication.render': (args) => {
        const wire = wireData(args) as unknown as {
          source_lang: string
          target_lang: string
          segments: Array<{
            id: string
            source: string
            target: string
            issues: Array<{ code: string; message: string; matched_text: string }>
          }>
          protocol: Protocol
        }
        const renderer = new AdjudicationRenderer(BUILTIN_ADJUDICATION_PROMPT_TEMPLATE)
        const { system, user } = renderer.render({
          sourceLang: wire.source_lang,
          targetLang: wire.target_lang,
          segments: wire.segments.map((s) => ({
            id: s.id,
            source: s.source,
            target: s.target,
            issues: wireAdjudicationIssues(s.issues ?? []),
          })),
          protocol: wire.protocol,
        })
        return { system, user }
      },

      'prompt.semantic_qa.render': (args) => {
        const wire = wireData(args) as unknown as {
          source_lang: string
          target_lang: string
          segments: SemanticQASegment[]
          protocol: Protocol
        }
        const renderer = new SemanticQARenderer(BUILTIN_SEMANTIC_QA_PROMPT_TEMPLATE)
        const { system, user } = renderer.render({
          sourceLang: wire.source_lang,
          targetLang: wire.target_lang,
          segments: wire.segments,
          protocol: wire.protocol,
        })
        return { system, user }
      },

      'prompt.parse_bootstrap': (args) => {
        const result = parseBootstrapResponse(argString(args, 'text'))
        return { entries: result.entries, ok: result.error === null }
      },

      'prompt.parse_revisions': (args) => {
        const [revisions, recognized] = parseReviseTextRevisions(argString(args, 'text'))
        return { revisions, recognized }
      },

      'prompt.parse_verdicts': (args) => {
        const [verdicts, recognized] = parseAdjudicationTextVerdicts(argString(args, 'text'))
        return { verdicts, recognized }
      },

      'prompt.parse_issues': (args) => {
        const [issues, recognized] = parseSemanticQATextIssues(argString(args, 'text'))
        return { issues, recognized }
      },

      'prompt.strip_code_fence': (args) => ({
        text: stripCodeFence(argString(args, 'text')),
      }),

      'prompt.inline_ruby_in_source': (args) => {
        const annotations = (args.annotations ?? []) as Array<{
          id: string
          base: string
          text: string
        }>
        return {
          text: inlineRubyInSource(
            argString(args, 'source'),
            annotations.map((a) => ({ id: a.id, base: a.base, text: a.text })),
          ),
        }
      },
    })
  })

  it('内置种子模板与执行策略已导出', () => {
    expect(BUILTIN_TRANSLATION_PROMPT_TEMPLATE).toContain('你是 LinguaFlow')
    expect(BUILTIN_TRANSLATION_PROMPT_TEMPLATE).toContain('{{- if eq .SourceLang "auto"}}')
    expect(BUILTIN_BOOTSTRAP_PROMPT_TEMPLATE.length).toBeGreaterThan(100)
    expect(BUILTIN_PRUNE_PROMPT_TEMPLATE.length).toBeGreaterThan(100)
    expect(BUILTIN_ADJUDICATION_PROMPT_TEMPLATE.length).toBeGreaterThan(100)
    expect(BUILTIN_SEMANTIC_QA_PROMPT_TEMPLATE.length).toBeGreaterThan(100)
    expect(BUILTIN_REVISE_PROMPT_TEMPLATE.length).toBeGreaterThan(100)
  })

  it('schema 生成器与 Go 的结构一致', () => {
    expect(bootstrapSchema()).toEqual({
      type: 'object',
      properties: {
        glossary: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              source: { type: 'string' },
              target: { type: 'string' },
              notes: { type: 'string' },
            },
            required: ['source', 'target', 'notes'],
            additionalProperties: false,
          },
        },
      },
      required: ['glossary'],
      additionalProperties: false,
    })
    expect(adjudicationVerdictSchema().required).toEqual(['verdicts'])
    expect(semanticQAIssueSchema().required).toEqual(['issues'])
  })

  it('hasRuby 判定与 Go 的方法语义一致', () => {
    expect(hasRuby({})).toBe(false)
    expect(hasRuby({ '1': [] })).toBe(false)
    expect(hasRuby({ '1': [{ id: '1', base: 'a', text: 'b' }] })).toBe(true)
  })

  it('类型别名可用于下游模块', () => {
    const segment: SegmentInput = { id: '1', source: 'x', translate: true }
    const glossary: GlossaryEntry = { source: 'a', target: 'b', notes: '' }
    const hint: TMHint = { source: 'a', target: 'b', score: 1 }
    const issue: ReviseIssue = { code: 'c', message: 'm', snippet: '' }
    const adjIssue: AdjudicationIssue = { code: 'c', message: 'm', matchedText: '' }
    expect([segment.id, glossary.source, hint.score, issue.code, adjIssue.code]).toEqual([
      '1',
      'a',
      1,
      'c',
      'c',
    ])
    const adjud: AdjudicationData = {
      sourceLang: 'en',
      targetLang: 'zh',
      segments: [],
      protocol: 'json_strict',
    }
    expect(adjud.protocol).toBe('json_strict')
  })
})
