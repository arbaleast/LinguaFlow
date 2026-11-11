/**
 * `domain/ruby` 黄金向量对拍测试。
 *
 * 期望值全部来自 Go `backend/internal/ruby` 的真实输出
 * （由 `backend/internal/ruby/golden_vectors_test.go` 导出），
 * 本移植层必须与之 100% 一致。
 */
import { describe, it } from 'vitest'
import rubyFixture from '../__fixtures__/ruby.json'
import {
  applyOutput,
  assignIds,
  buildTranslationRegions,
  classifyInitialItems,
  isFullResult,
  itemsById,
  mergeByOutput,
  missingItems,
  newAlignmentState,
  newOutputEntry,
  newRubyItem,
  normalizeOutputEntries,
  parseAlignmentJsonV2,
  parseAlignmentTextLegacy,
  parseAlignmentTextV2,
  parseInlineMarkers,
  parseOutputEntries,
  parseOutputMap,
  parseSectionLine,
  parseSectionRubyOutput,
  renderAlignmentState,
  restoreInlineMarkers,
  restoreItems,
  stripLegacyInlineMarkers,
  unaligned,
  validateAlignmentState,
  validBareOutputEntries,
  toWire,
  type AlignmentState,
  type OutputEntry,
  type RubyItem,
} from '../ruby'
import {
  argBoolean,
  argNumber,
  argString,
  argStringArray,
  runGolden,
  type GoldenFixture,
} from './helpers/golden'

const fixture = rubyFixture as unknown as GoldenFixture

/** Go `thisItem` 的 args 形状 → RubyItem（字段名与 Go JSON tag 一致）。 */
function rebuildItem(raw: unknown): RubyItem {
  return newRubyItem((raw ?? {}) as Partial<RubyItem>)
}

function rebuildItems(raw: unknown): RubyItem[] {
  if (!Array.isArray(raw)) return []
  return raw.map(rebuildItem)
}

/** Go `thisEntry` 的 args 形状 → OutputEntry。 */
function rebuildEntry(raw: unknown): OutputEntry {
  return newOutputEntry((raw ?? {}) as Partial<OutputEntry>)
}

function rebuildEntries(raw: unknown): OutputEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.map(rebuildEntry)
}

/** Go `thisItems`：条目列表投影。 */
function itemViews(items: readonly RubyItem[]): unknown {
  return items.map((it) => ({
    id: it.id,
    source_base: it.source_base,
    source_text: it.source_text,
    target_base: it.target_base,
    target_text: it.target_text,
    kind: it.kind,
    aligned: it.aligned,
  }))
}

/** Go `thisEntries`：输出条目列表投影。 */
function entryViews(entries: readonly OutputEntry[]): unknown {
  return entries.map((e) => ({
    base: e.base,
    text: e.text,
    kind: e.kind,
    id: e.id,
    occurrence: e.occurrence,
    invalid: e.invalid,
  }))
}

/** Go `thisRestore`：还原统计投影。 */
function restoreView(r: { matched: number; total: number }): unknown {
  return { matched: r.matched, total: r.total }
}

/**
 * 把 TS AlignmentState 投影为 Go `json.Marshal` 的形态：
 * Go 侧 `Items` / `Verified` 用 nil append 构建，`Regions` 在无区域时也为 nil，
 * 序列化均为 `null`；TS 空数组统一归一为 null。Item 走 `omitempty` 的持久化
 * 形态（`toWire`，空串字段省略、`aligned` 为 json:"-" 不出现）。
 */
function stateJSON(state: AlignmentState): unknown {
  return {
    version: state.version,
    validator_version: state.validator_version,
    protocol_version: state.protocol_version,
    translation: state.translation,
    format: state.format,
    items:
      state.items.length > 0
        ? state.items.map((it) => ({ item: toWire(it.item), preserve: it.preserve }))
        : null,
    regions: state.regions.length > 0 ? state.regions : null,
    digest: state.digest,
    verified: state.verified.length > 0 ? state.verified : null,
  }
}

/** 从 fixture 的 state JSON 重建 AlignmentState（Go nil → TS 空数组）。 */
function rebuildState(raw: unknown): AlignmentState {
  const s = (raw ?? {}) as Partial<AlignmentState>
  return {
    version: s.version ?? 0,
    validator_version: s.validator_version ?? 0,
    protocol_version: s.protocol_version ?? 0,
    translation: s.translation ?? '',
    format: s.format ?? '',
    items: (s.items ?? []).map((it) => ({
      item: rebuildItem((it as { item?: unknown }).item),
      preserve: (it as { preserve?: boolean }).preserve === true,
    })),
    regions: s.regions ?? [],
    digest: s.digest ?? '',
    verified: s.verified ?? [],
  }
}

/** `keep` 参数：fixture 中缺省表示 nil。 */
function rebuildKeep(raw: unknown): Record<string, boolean> | null {
  if (raw === undefined || raw === null) return null
  const out: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = v === true
  return out
}

/** ApplyOutput/Render 共用的状态构造 + 进展计算。 */
function runApply(args: Record<string, unknown>): {
  state: AlignmentState
  progress: ReturnType<typeof applyOutput>
} {
  const state = newAlignmentState(
    argString(args, 'translation'),
    argString(args, 'format'),
    rebuildItems(args['items']),
    rebuildKeep(args['keep']),
    argNumber(args, 'protocol_version'),
  )
  const progress = applyOutput(
    state,
    argStringArray(args, 'requested'),
    rebuildEntries(args['entries']),
    argBoolean(args, 'require_occurrence'),
  )
  return { state, progress }
}

describe('ruby 黄金向量（Go backend/internal/ruby 真实输出）', () => {
  it('全部用例与 Go 逐字节一致', () => {
    runGolden(fixture, {
      'ruby.assign_ids': (args) => {
        const assigned = assignIds(rebuildItems(args['items']))
        return { ids: assigned.map((it) => it.id) }
      },
      'ruby.items_by_id': (args) => {
        const byID = itemsById(rebuildItems(args['items']))
        const map: Record<string, string> = {}
        for (const [id, it] of byID) map[id] = it.source_base
        return { map }
      },
      'ruby.merge_by_output': (args) => {
        const items = rebuildItems(args['items'])
        const output = rebuildEntries(args['output'])
        mergeByOutput(items, output)
        return { items: itemViews(items), unaligned: itemViews(unaligned(items)) }
      },
      'ruby.unaligned': (args) => ({ items: itemViews(unaligned(rebuildItems(args['items']))) }),
      'ruby.restore_items': (args) => {
        const r = restoreItems(argString(args, 'target'), rebuildItems(args['items']))
        return {
          target: r.target,
          matched: r.result.matched,
          total: r.result.total,
          is_full: isFullResult(r.result),
        }
      },
      'ruby.parse_inline_markers': (args) => ({
        entries: entryViews(parseInlineMarkers(argString(args, 'text'))),
      }),
      'ruby.restore_inline_markers': (args) => {
        const r = restoreInlineMarkers(argString(args, 'target'), rebuildEntries(args['entries']))
        return { target: r.target, ...restoreView(r.result) }
      },
      'ruby.parse_section_line': (args) => {
        const line = parseSectionLine(argString(args, 'content'))
        return { base: line.base, text: line.text, kind: line.kind, id: line.itemId, ok: line.ok }
      },
      'ruby.parse_section_ruby_output': (args) => {
        const m = parseSectionRubyOutput(argStringArray(args, 'lines'))
        const map: Record<string, unknown> = {}
        for (const [id, entries] of Object.entries(m)) map[id] = entryViews(entries)
        return { map }
      },
      'ruby.normalize_output_entries': (args) => ({
        entries: entryViews(normalizeOutputEntries(rebuildEntries(args['entries']))),
      }),
      'ruby.valid_bare_output_entries': (args) => {
        const entries = args['entries']
        return { valid: validBareOutputEntries(Array.isArray(entries) ? entries : []) }
      },
      'ruby.strip_legacy_markers': (args) => ({
        text: stripLegacyInlineMarkers(argString(args, 'text')),
      }),
      'ruby.parse_alignment_text_v2': (args) => ({
        entries: entryViews(parseAlignmentTextV2(argString(args, 'text'))),
      }),
      'ruby.parse_alignment_text_legacy': (args) => ({
        entries: entryViews(parseAlignmentTextLegacy(argString(args, 'text'))),
      }),
      'ruby.parse_alignment_json_v2': (args) => {
        const r = parseAlignmentJsonV2(argString(args, 'text'))
        return { ok: r.ok, entries: entryViews(r.entries) }
      },
      'ruby.parse_output_entries': (args) => {
        const r = parseOutputEntries(args['raw'])
        return { ok: r.ok, entries: entryViews(r.entries) }
      },
      'ruby.parse_output_map': (args) => {
        const m = parseOutputMap(args['raw'])
        const map: Record<string, unknown> = {}
        for (const [id, entries] of Object.entries(m ?? {})) map[id] = entryViews(entries)
        return { map }
      },
      'ruby.build_regions': (args) => {
        try {
          const regions = buildTranslationRegions(
            argString(args, 'translation'),
            argString(args, 'format'),
          )
          return {
            regions: regions.map((r) => ({ text: r.text, mappings: r.mappings })),
            err: '',
          }
        } catch (error) {
          return { regions: [], err: (error as Error).message }
        }
      },
      'ruby.new_alignment_state': (args) => {
        try {
          const state = newAlignmentState(
            argString(args, 'translation'),
            argString(args, 'format'),
            rebuildItems(args['items']),
            rebuildKeep(args['keep']),
            argNumber(args, 'protocol_version'),
          )
          return { ok: true, err: '', state: stateJSON(state) }
        } catch (error) {
          return { ok: false, err: (error as Error).message, state: null }
        }
      },
      'ruby.classify_initial_items': (args) => ({
        items: itemViews(
          classifyInitialItems(rebuildItems(args['items']), rebuildEntries(args['output'])),
        ),
      }),
      'ruby.apply_output': (args) => {
        const { state, progress } = runApply(args)
        return {
          added: progress.added,
          rejected: progress.rejected,
          verified: state.verified,
          missing_ids: missingItems(state).map((it) => it.id),
        }
      },
      'ruby.render': (args) => {
        const { state } = runApply(args)
        try {
          const r = renderAlignmentState(state)
          return { text: r.text, matched: r.result.matched, total: r.result.total, err: '' }
        } catch (error) {
          return { text: '', matched: 0, total: 0, err: (error as Error).message }
        }
      },
      'ruby.validate_state': (args) => {
        try {
          validateAlignmentState(rebuildState(args['state']))
          return { ok: true, err: '' }
        } catch (error) {
          return { ok: false, err: (error as Error).message }
        }
      },
    })
  })

  it('用例数量充足', () => {
    if (fixture.cases.length < 130) throw new Error(`ruby 用例过少: ${fixture.cases.length}`)
  })
})
