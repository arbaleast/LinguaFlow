/**
 * `domain/repair` 黄金向量对拍测试。
 *
 * 期望值全部来自 Go `backend/internal/repair` 的真实输出
 * （由 `backend/internal/repair/golden_vectors_test.go` 导出），
 * 本移植层必须与之 100% 一致。
 */
import { describe, it } from 'vitest'
import repairFixture from '../__fixtures__/repair.json'
import {
  buildRetryReminder,
  ERR_BOOTSTRAP_TEXT_EMPTY,
  escapeUnescapedQuotes,
  normalizePlaceholders,
  parseAdjudicationByMode,
  parseBootstrapByMode,
  parseReviseByMode,
  parseSemanticQAByMode,
  renderRetryReminder,
  truncateToLastCompleteValue,
  tryRepair,
  tryRepairAdjudication,
  tryRepairBootstrap,
  tryRepairBootstrapText,
  tryRepairEnvelope,
  tryRepairRubyAlignment,
  tryRepairRubyAlignmentForState,
  tryRepairSemanticQA,
  tryRepairText,
  stripCodeFence,
  type RepairOptions,
  type RubyOutputEntry,
} from '../repair'
import {
  argBoolean,
  argNumber,
  argString,
  argStringArray,
  argStringRecord,
  argNullableStringRecord,
  runGolden,
  type GoldenFixture,
} from './helpers/golden'

const fixture = repairFixture as unknown as GoldenFixture

/** 重建 Go 侧 `optionsArgs` 投影的修复选项。 */
function rebuildOptions(raw: Record<string, unknown>): RepairOptions {
  const record = raw as {
    jsonStructural?: boolean
    schemaAliases?: boolean
    placeholderNormalize?: boolean
    promptUpgrade?: boolean
    withoutSalvage?: boolean
  }
  return {
    jsonStructural: record.jsonStructural === true,
    schemaAliases: record.schemaAliases === true,
    placeholderNormalize: record.placeholderNormalize === true,
    promptUpgrade: record.promptUpgrade === true,
    bareArrayAccept: null,
    salvageDeclined: record.withoutSalvage === true,
    inSalvage: false,
  }
}

/** Go `optionsArgs` 的参数形状（全部键都存在）。 */
function optionsOf(args: Record<string, unknown>): RepairOptions {
  const raw = (args['options'] ?? {}) as Record<string, unknown>
  return rebuildOptions(raw)
}

/** Go `goldenErrorKind`：error → 稳定分类（'' | 'empty' | 'other'）。 */
function errorKind(error: string | null): string {
  if (error === null) return ''
  if (error === ERR_BOOTSTRAP_TEXT_EMPTY) return 'empty'
  return 'other'
}

/** Go `entryViews`：术语条目投影。 */
function entryViews(entries: Array<{ source: string; target: string; notes: string }>): unknown {
  return entries.map((e) => ({ source: e.source, target: e.target, notes: e.notes }))
}

/** Go `outputEntryView`：注音条目投影（含 Go 的 Invalid 运行态字段）。 */
function outputEntryView(e: RubyOutputEntry): unknown {
  return {
    id: e.id,
    base: e.base,
    text: e.text,
    kind: e.kind,
    occurrence: e.occurrence,
    invalid: e.invalid,
  }
}

/** Go `outputMapView`：segment ID → 条目；null → {}。 */
function outputMapView(m: Record<string, RubyOutputEntry[]> | null): unknown {
  const out: Record<string, unknown> = {}
  for (const [id, entries] of Object.entries(m ?? {})) {
    out[id] = entries.map(outputEntryView)
  }
  return out
}

/** Go `tryResultView`：TryRepair 的 Result 投影。 */
function tryResultView(r: {
  fatal: boolean
  trans: Record<string, string>
  glos: Array<{ source: string; target: string; notes: string }>
  rubyOutput: Record<string, RubyOutputEntry[]> | null
  missing: string[]
  repaired: string[]
}): unknown {
  return {
    fatal: r.fatal,
    trans: r.trans,
    glos: entryViews(r.glos),
    rubyOutput: outputMapView(r.rubyOutput),
    missing: r.missing,
    repaired: r.repaired,
  }
}

/** Go `issueViews`：语义质检问题投影。 */
function issueViews(
  items: Array<{ id: string; code: string; message: string; snippet: string }>,
): unknown {
  return items.map((i) => ({ id: i.id, code: i.code, message: i.message, snippet: i.snippet }))
}

/** Go `verdictViews`：裁决结果投影。 */
function verdictViews(
  items: Array<{
    id: string
    issue_code: string
    matched_text: string
    verdict: string
    reason: string
  }>,
): unknown {
  return items.map((v) => ({
    id: v.id,
    issue_code: v.issue_code,
    matched_text: v.matched_text,
    verdict: v.verdict,
    reason: v.reason,
  }))
}

/** Go `revisionViews`：修订结果投影。 */
function revisionViews(items: Array<{ id: string; target: string }>): unknown {
  return items.map((r) => ({ id: r.id, target: r.target }))
}

/** Go `outputListViews`：条目列表投影。 */
function outputListViews(entries: RubyOutputEntry[]): unknown {
  return entries.map(outputEntryView)
}

/** Go `envelopeGolden` 的 valueKind/count 判定。 */
function envelopeValueShape(
  raw: Record<string, unknown> | null,
  key: string,
): { valueKind: string; count: number } {
  if (raw === null) return { valueKind: '', count: 0 }
  const value = raw[key]
  if (value === undefined) return { valueKind: '', count: 0 }
  if (Array.isArray(value)) return { valueKind: 'array', count: value.length }
  if (typeof value === 'object' && value !== null) {
    return { valueKind: 'object', count: Object.keys(value).length }
  }
  return { valueKind: 'other', count: 0 }
}

describe('repair 黄金向量（Go backend/internal/repair 真实输出）', () => {
  it('全部用例与 Go 逐字节一致', () => {
    runGolden(fixture, {
      'json.escape_unescaped_quotes': (args) => ({
        text: escapeUnescapedQuotes(argString(args, 'text')),
      }),
      'json.truncate_to_last_complete_value': (args) => {
        const { cut, ok } = truncateToLastCompleteValue(argString(args, 'text'))
        return { cut, ok }
      },
      'repair.try': (args) => {
        const r = tryRepair(
          argString(args, 'text'),
          argStringArray(args, 'wantIds'),
          optionsOf(args),
        )
        return tryResultView(r)
      },
      'repair.text': (args) => {
        const r = tryRepairText(
          argString(args, 'text'),
          argStringArray(args, 'wantIds'),
          optionsOf(args),
        )
        return tryResultView(r)
      },
      'repair.bootstrap': (args) => {
        const r = tryRepairBootstrap(argString(args, 'text'), optionsOf(args))
        return {
          ok: r.error === null,
          entries: entryViews(r.entries),
          repaired: r.repaired,
          error: errorKind(r.error),
        }
      },
      'repair.bootstrap.text': (args) => {
        const r = tryRepairBootstrapText(argString(args, 'text'), optionsOf(args))
        return {
          ok: r.error === null,
          entries: entryViews(r.entries),
          repaired: r.repaired,
          error: errorKind(r.error),
        }
      },
      'repair.bootstrap.mode': (args) => {
        const r = parseBootstrapByMode(
          argString(args, 'text'),
          argBoolean(args, 'isTextMode'),
          optionsOf(args),
          argBoolean(args, 'requireHeaderForEmpty'),
        )
        return {
          ok: r.error === null,
          entries: entryViews(r.entries),
          repaired: r.repaired,
          error: errorKind(r.error),
        }
      },
      'repair.envelope': (args) => {
        const r = tryRepairEnvelope(
          argString(args, 'text'),
          argString(args, 'key'),
          optionsOf(args),
        )
        return {
          ok: r.error === null,
          repaired: r.repaired,
          ...envelopeValueShape(r.raw, argString(args, 'key')),
          error: errorKind(r.error),
        }
      },
      'repair.semantic.qa': (args) => {
        const r = tryRepairSemanticQA(argString(args, 'text'), optionsOf(args))
        return {
          ok: r.error === null,
          items: issueViews(r.entries),
          repaired: r.repaired,
          error: errorKind(r.error),
        }
      },
      'repair.semantic.qa.mode': (args) => {
        const r = parseSemanticQAByMode(
          argString(args, 'text'),
          argBoolean(args, 'isTextMode'),
          optionsOf(args),
        )
        return {
          ok: r.error === null,
          items: issueViews(r.entries),
          repaired: r.repaired,
          error: errorKind(r.error),
        }
      },
      'repair.adjudication': (args) => {
        const r = tryRepairAdjudication(argString(args, 'text'), optionsOf(args))
        return {
          ok: r.error === null,
          items: verdictViews(r.entries),
          repaired: r.repaired,
          error: errorKind(r.error),
        }
      },
      'repair.adjudication.mode': (args) => {
        const r = parseAdjudicationByMode(
          argString(args, 'text'),
          argBoolean(args, 'isTextMode'),
          optionsOf(args),
        )
        return {
          ok: r.error === null,
          items: verdictViews(r.entries),
          repaired: r.repaired,
          error: errorKind(r.error),
        }
      },
      'repair.revise.mode': (args) => {
        const r = parseReviseByMode(
          argString(args, 'text'),
          argBoolean(args, 'isTextMode'),
          optionsOf(args),
        )
        return {
          ok: r.error === null,
          revisions: revisionViews(r.revisions),
          rubyOutput: outputMapView(r.rubyOutput),
          repaired: r.repaired,
          error: errorKind(r.error),
        }
      },
      'repair.ruby.alignment': (args) => {
        const r = tryRepairRubyAlignment(argString(args, 'text'), optionsOf(args))
        return {
          ok: r.error === null,
          entries: outputListViews(r.entries),
          repaired: r.repaired,
          error: errorKind(r.error),
        }
      },
      'repair.ruby.alignment.state': (args) => {
        const r = tryRepairRubyAlignmentForState(argString(args, 'text'), optionsOf(args))
        return {
          ok: r.error === null,
          entries: outputListViews(r.entries),
          repaired: r.repaired,
          error: errorKind(r.error),
        }
      },
      'repair.placeholder': (args) => {
        const { text, normalized } = normalizePlaceholders(
          argString(args, 'text'),
          argNullableStringRecord(args, 'knownKeys') ?? {},
        )
        return { text, normalized }
      },
      'repair.retry.reminder': (args) => {
        const parseErr = args['parseErr']
        const r = renderRetryReminder(
          argString(args, 'content'),
          argStringArray(args, 'missingIds'),
          typeof parseErr === 'string' ? parseErr : null,
          argString(args, 'prevHead'),
        )
        return { ok: r.error === null, text: r.text }
      },
      'repair.build.retry.reminder': (args) => {
        const parseErr = args['parseErr']
        return {
          text: buildRetryReminder(
            argStringArray(args, 'missingIds'),
            typeof parseErr === 'string' ? parseErr : null,
            argString(args, 'prevHead'),
          ),
        }
      },
      'text.strip_code_fence': (args) => ({ text: stripCodeFence(argString(args, 'text')) }),
    })
  })

  // 防止 vitest 因缺除断言而报警（本文件断言全部在 runGolden 内）。
  it('用例数量充足', () => {
    if (fixture.cases.length < 170) throw new Error(`repair 用例过少: ${fixture.cases.length}`)
  })
})

// 保留 argNumber 引用（部分向量参数为数值时使用）。
void argNumber
void argStringRecord
