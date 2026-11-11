/**
 * `domain/qa` 黄金向量对拍测试。
 *
 * 期望值全部来自 Go `backend/internal/qa` 的真实输出
 * （由 `backend/internal/qa/golden_vectors_test.go` 导出），
 * 本移植层必须与之 100% 一致。
 *
 * 注意：所有 `expect.issues` 都是 **落库形态**（snake_case）——即 Go 生产代码
 * `QualityIssue.MarshalJSON` 的输出。因此这些向量同时锁定了：
 * - 每个 checker 的判定逻辑与 message 文案；
 * - `Span` 的 rune 偏移；
 * - `QualityIssue` 的 JSON 字段名与 `omitempty` / `disposition` 归一化语义。
 */
import { describe, expect, it } from 'vitest'
import qaFixture from '../__fixtures__/qa.json'
import {
  adjudicableCodes,
  allCheckerNames,
  checkDuplicateSourceDivergence,
  checkerEnabled,
  conservationCodes,
  countWords,
  defaultAdjudicateCodes,
  dedupIssues,
  documentCheckerCodes,
  duplicateSourceDivergenceEnabled,
  DuplicateTranslationChecker,
  Engine,
  filterOutPendingByCodes,
  filterableIssueCodes,
  fingerprint,
  ForbiddenTermChecker,
  hasErrors,
  inlineMarkupRegions,
  isAdjudicableCode,
  isConservationCode,
  isDismissed,
  isFilterableIssueCode,
  isPending,
  isSemanticQACode,
  issuesFor,
  LeftoverPlaceholderChecker,
  LengthRatioChecker,
  locateSpan,
  locateSpanExcludingRegions,
  MemoryGlossary,
  normalizeNumberToken,
  normalizeNumberWidth,
  NumberMismatchChecker,
  protectedRegions,
  PunctuationMissingChecker,
  PunctuationPairingChecker,
  PunctuationSurplusChecker,
  PunctuationWrapLossChecker,
  qualityIssueFromWire,
  qualityIssueToWire,
  reconcileIssues,
  recheckFinalIssues,
  RepeatedSpaceChecker,
  reviseFinalIssues,
  rubyTagLossIssues,
  ScriptMismatchChecker,
  semanticQACodes,
  SourceResidualChecker,
  stripRegions,
  SubtitleLineCountChecker,
  termPresent,
  TermInconsistencyChecker,
  UntranslatedChecker,
  URLEmailMismatchChecker,
  weightedLen,
  WhitespaceIrregularChecker,
  WidthMixChecker,
  XMLTagMismatchChecker,
  zeroConfigDeterministicChecks,
  type CheckInput,
  type Config,
  type GlossaryEntry,
  type LengthMethod,
  type QualityIssue,
  type Region,
} from '../qa'
import {
  argBoolean,
  argNumber,
  argString,
  argStringArray,
  runGolden,
  type GoldenFixture,
} from './helpers/golden'

const fixture = qaFixture as unknown as GoldenFixture

/** 从参数还原段落列表。 */
function argSegments(args: Record<string, unknown>): CheckInput[] {
  const raw = args.segments
  if (!Array.isArray(raw)) return []
  return raw.map((item) => {
    const s = item as Record<string, unknown>
    const out: CheckInput = {
      index: typeof s.index === 'number' ? s.index : 0,
      sourceText: typeof s.source === 'string' ? s.source : '',
      targetText: typeof s.target === 'string' ? s.target : '',
    }
    if (s.protected !== undefined && s.protected !== null) {
      out.protected = s.protected as Record<string, string>
    }
    return out
  })
}

/** 从参数还原一组落库形态的 issue。 */
function argIssues(args: Record<string, unknown>, key: string): QualityIssue[] {
  const raw = args[key]
  if (raw === null || raw === undefined) return []
  if (!Array.isArray(raw)) {
    throw new Error(`黄金向量参数 "${key}" 期望为数组`)
  }
  return raw.map((wire) => qualityIssueFromWire(wire))
}

/** 从参数还原单个落库形态的 issue。 */
function argIssue(args: Record<string, unknown>, key: string): QualityIssue {
  return qualityIssueFromWire(args[key])
}

/** 把 issue 列表转成落库形态。 */
function issuesOut(issues: readonly QualityIssue[]): unknown[] {
  return issues.map((iss) => qualityIssueToWire(iss))
}

/** 从参数还原保护区（`null` 表示无区域）。 */
function argRegions(args: Record<string, unknown>, key: string): Region[] | null {
  const raw = args[key]
  if (raw === null || raw === undefined) return null
  if (!Array.isArray(raw)) {
    throw new Error(`黄金向量参数 "${key}" 期望为区域数组`)
  }
  return raw.map((pair) => {
    const p = pair as number[]
    return [p[0] ?? 0, p[1] ?? 0] as Region
  })
}

/** 从参数还原术语表（`null` 表示 nil glossary）。 */
function argGlossary(args: Record<string, unknown>): MemoryGlossary | null {
  const raw = args.glossary
  if (!Array.isArray(raw)) return null
  const glossary = new MemoryGlossary()
  glossary.add(
    ...raw.map((item): GlossaryEntry => {
      const e = item as Record<string, unknown>
      return {
        source: String(e.source ?? ''),
        target: String(e.target ?? ''),
        caseSensitive: Boolean(e.caseSensitive),
        forbidden: Boolean(e.forbidden),
        mandatory: Boolean(e.mandatory),
        notes: String(e.notes ?? ''),
      }
    }),
  )
  return glossary
}

/** 读取可空的字符串数组参数。 */
function argNullableStringArray(args: Record<string, unknown>, key: string): string[] | null {
  const raw = args[key]
  if (raw === null || raw === undefined) return null
  return argStringArray(args, key)
}

/** 从参数构造引擎配置。 */
function argConfig(args: Record<string, unknown>): Config {
  const raw = args.config
  if (raw === null || typeof raw !== 'object') {
    throw new Error('黄金向量缺 config')
  }
  const c = raw as Record<string, unknown>
  return {
    enabled: Boolean(c.enabled),
    autoReject: Boolean(c.autoReject),
    lengthMethod: typeof c.lengthMethod === 'string' ? c.lengthMethod : '',
    lengthRatioMin: typeof c.lengthRatioMin === 'number' ? c.lengthRatioMin : 0,
    lengthRatioMax: typeof c.lengthRatioMax === 'number' ? c.lengthRatioMax : 0,
    sourceLang: typeof c.sourceLang === 'string' ? c.sourceLang : '',
    targetLang: typeof c.targetLang === 'string' ? c.targetLang : '',
    checks: Array.isArray(c.checks) ? (c.checks as string[]) : null,
    format: typeof c.format === 'string' ? c.format : '',
    glossary: null,
  }
}

/** 单段检测 handler 的通用返回：运行 checker 并转成落库形态。 */
function runChecker(
  args: Record<string, unknown>,
  checker: { check(segments: readonly CheckInput[]): QualityIssue[] },
): unknown {
  return { issues: issuesOut(checker.check(argSegments(args))) }
}

describe('domain/qa 黄金向量', () => {
  it('覆盖全部黄金向量', () => {
    runGolden(fixture, {
      // ---- 19 个 per-batch checker（各自独立 Op）----
      'qa.untranslated': (args) =>
        runChecker(
          args,
          new UntranslatedChecker(argString(args, 'srcLang'), argString(args, 'tgtLang')),
        ),

      'qa.length_ratio': (args) =>
        runChecker(
          args,
          new LengthRatioChecker(
            argNumber(args, 'minRatio'),
            argNumber(args, 'maxRatio'),
            argString(args, 'method') as LengthMethod,
          ),
        ),

      'qa.duplicate': (args) => runChecker(args, new DuplicateTranslationChecker()),

      'qa.source_residual': (args) =>
        runChecker(
          args,
          new SourceResidualChecker(argString(args, 'srcLang'), argString(args, 'tgtLang')),
        ),

      'qa.punctuation_pairing': (args) =>
        runChecker(args, new PunctuationPairingChecker(argString(args, 'targetLang'))),

      'qa.punctuation_missing': (args) => runChecker(args, new PunctuationMissingChecker()),

      'qa.punctuation_surplus': (args) => runChecker(args, new PunctuationSurplusChecker()),

      'qa.punctuation_wrap_loss': (args) => runChecker(args, new PunctuationWrapLossChecker()),

      'qa.whitespace_irregular': (args) => runChecker(args, new WhitespaceIrregularChecker()),

      'qa.repeated_space': (args) =>
        runChecker(args, new RepeatedSpaceChecker(argString(args, 'targetLang'))),

      'qa.width_mix': (args) =>
        runChecker(args, new WidthMixChecker(argString(args, 'targetLang'))),

      'qa.script_mismatch': (args) =>
        runChecker(args, new ScriptMismatchChecker(argString(args, 'targetLang'))),

      'qa.number_mismatch': (args) => runChecker(args, new NumberMismatchChecker()),

      'qa.url_email': (args) => runChecker(args, new URLEmailMismatchChecker()),

      'qa.subtitle_line_count': (args) =>
        runChecker(args, new SubtitleLineCountChecker(argString(args, 'format'))),

      'qa.forbidden_term': (args) =>
        runChecker(
          args,
          new ForbiddenTermChecker(
            argGlossary(args),
            argString(args, 'srcLang'),
            argString(args, 'tgtLang'),
          ),
        ),

      'qa.term_inconsistency': (args) =>
        runChecker(
          args,
          new TermInconsistencyChecker(
            argGlossary(args),
            argString(args, 'srcLang'),
            argString(args, 'tgtLang'),
          ),
        ),

      'qa.leftover_placeholder': (args) => runChecker(args, new LeftoverPlaceholderChecker()),

      'qa.xml_tag_mismatch': (args) => runChecker(args, new XMLTagMismatchChecker()),

      // ---- 文档级 / 守恒类 ----
      'qa.duplicate_source_divergence': (args) => ({
        issues: issuesOut(checkDuplicateSourceDivergence(argSegments(args))),
      }),

      'qa.duplicate_source_divergence_enabled': (args) => ({
        enabled: duplicateSourceDivergenceEnabled(argNullableStringArray(args, 'checks')),
      }),

      'qa.ruby_tag_loss': (args) => ({
        issues: issuesOut(
          rubyTagLossIssues(
            argNumber(args, 'segmentIndex'),
            argString(args, 'prev'),
            argString(args, 'next'),
          ),
        ),
      }),

      // ---- Span 定位 ----
      'qa.locate_span': (args) => {
        const span = locateSpan(argString(args, 'target'), argString(args, 'matched'))
        return {
          matched: span?.matchedText ?? null,
          start: span?.targetStart ?? null,
          end: span?.targetEnd ?? null,
        }
      },

      'qa.locate_span_excluding_regions': (args) => {
        const span = locateSpanExcludingRegions(
          argString(args, 'target'),
          argString(args, 'matched'),
          argRegions(args, 'regions'),
        )
        return {
          matched: span?.matchedText ?? null,
          start: span?.targetStart ?? null,
          end: span?.targetEnd ?? null,
        }
      },

      // ---- 保护区 ----
      'qa.protected_regions': (args) => {
        const target = argString(args, 'target')
        const protectedMap =
          args.protected === null || args.protected === undefined
            ? null
            : (args.protected as Record<string, string>)
        const regions = protectedRegions(target, protectedMap)
        return {
          regions: regions ?? null,
          stripped: regions === null ? target : stripRegions(target, regions),
        }
      },

      'qa.strip_regions': (args) => ({
        text: stripRegions(argString(args, 'target'), argRegions(args, 'regions')),
      }),

      'qa.inline_markup_regions': (args) => {
        const target = argString(args, 'target')
        const protectedMap =
          args.protected === null || args.protected === undefined
            ? null
            : (args.protected as Record<string, string>)
        const regions = inlineMarkupRegions(target, protectedMap)
        return { regions: regions ?? null, stripped: stripRegions(target, regions) }
      },

      // ---- 指纹 / 裁决对账 ----
      'qa.fingerprint': (args) => ({ value: fingerprint(argIssue(args, 'issue')) }),

      'qa.dedup_issues': (args) => ({ issues: issuesOut(dedupIssues(argIssues(args, 'issues'))) }),

      'qa.reconcile': (args) => ({
        issues: issuesOut(reconcileIssues(argIssues(args, 'fresh'), argIssues(args, 'existing'))),
      }),

      'qa.filter_out_pending': (args) => ({
        issues: issuesOut(
          filterOutPendingByCodes(argIssues(args, 'issues'), new Set(argStringArray(args, 'drop'))),
        ),
      }),

      'qa.revise_final_issues': (args) => ({
        issues: issuesOut(
          reviseFinalIssues(
            argIssues(args, 'existing'),
            argIssues(args, 'fresh'),
            argStringArray(args, 'targeted'),
            argBoolean(args, 'qaRan'),
          ),
        ),
      }),

      'qa.recheck_final_issues': (args) => ({
        issues: issuesOut(
          recheckFinalIssues(argIssues(args, 'fresh'), argIssues(args, 'existing')),
        ),
      }),

      'qa.has_errors': (args) => ({ value: hasErrors(argIssues(args, 'issues')) }),

      'qa.issues_for': (args) => ({
        issues: issuesOut(issuesFor(argNumber(args, 'segmentIndex'), argIssues(args, 'issues'))),
      }),

      // ---- 数字 / 长度原语 ----
      'qa.normalize_number_token': (args) => ({
        value: normalizeNumberToken(argString(args, 'raw')),
      }),

      'qa.normalize_number_width': (args) => ({
        value: normalizeNumberWidth(argString(args, 'text')),
      }),

      'qa.weighted_len': (args) => ({ value: weightedLen(argString(args, 'text')) }),

      'qa.count_words': (args) => ({ value: countWords(argString(args, 'text')) }),

      'qa.term_present': (args) => ({
        present: termPresent(
          argString(args, 'haystack'),
          argString(args, 'needle'),
          argBoolean(args, 'caseSensitive'),
          argString(args, 'lang'),
        ),
      }),

      // ---- code 词表 ----
      'qa.codes': (args) => {
        const name = argString(args, 'name')
        const lists: Record<string, () => string[]> = {
          'all-checker-names': allCheckerNames,
          'zero-config': zeroConfigDeterministicChecks,
          filterable: filterableIssueCodes,
          semantic: semanticQACodes,
          adjudicable: adjudicableCodes,
          'default-adjudicable': defaultAdjudicateCodes,
          document: documentCheckerCodes,
          conservation: conservationCodes,
        }
        const fn = lists[name]
        if (fn === undefined) {
          throw new Error(`未知的 code 词表: ${name}`)
        }
        return { codes: fn() }
      },

      'qa.code_predicates': (args) => {
        const code = argString(args, 'code')
        return {
          semantic: isSemanticQACode(code),
          adjudicable: isAdjudicableCode(code),
          conservation: isConservationCode(code),
          filterable: isFilterableIssueCode(code),
        }
      },

      'qa.checker_enabled': (args) => ({
        enabled: checkerEnabled(argNullableStringArray(args, 'checks'), argString(args, 'code')),
      }),

      // ---- 引擎 ----
      'qa.engine': (args) => {
        const engine = new Engine(argConfig(args))
        return {
          issues: issuesOut(engine.run(argSegments(args))),
          checkerNames: engine.registeredCheckers().map((c) => c.name()),
        }
      },

      // ---- QualityIssue JSON 契约 ----
      'qa.issue_json': (args) => {
        const iss = argIssue(args, 'issue')
        return {
          roundtrip: qualityIssueToWire(iss),
          isPending: isPending(iss),
          dismissed: isDismissed(iss),
          fingerprint: fingerprint(iss),
        }
      },

      'qa.issue_invalid': (args) => {
        try {
          qualityIssueFromWire(args.issue)
          return { error: false }
        } catch {
          return { error: true }
        }
      },

      'qa.issue_marshal': (args) => {
        // 模拟「序列化不修改调用方入参」：先深拷贝，再解码/编码。
        const input = JSON.parse(JSON.stringify(args.issue)) as Record<string, unknown>
        return {
          marshaled: qualityIssueToWire(qualityIssueFromWire(input)),
          inputDecidedAt: input.decided_at ?? null,
          callerStillLocal: true,
        }
      },
    })
  })

  it('每个 per-batch checker 都有独立 Op 且至少一条向量', () => {
    const expectedOps = [
      'qa.untranslated',
      'qa.length_ratio',
      'qa.duplicate',
      'qa.source_residual',
      'qa.punctuation_pairing',
      'qa.punctuation_missing',
      'qa.punctuation_surplus',
      'qa.punctuation_wrap_loss',
      'qa.whitespace_irregular',
      'qa.repeated_space',
      'qa.width_mix',
      'qa.script_mismatch',
      'qa.number_mismatch',
      'qa.url_email',
      'qa.subtitle_line_count',
      'qa.forbidden_term',
      'qa.term_inconsistency',
      'qa.leftover_placeholder',
      'qa.xml_tag_mismatch',
    ]
    expect(expectedOps).toHaveLength(19)
    expect(new Set(expectedOps).size).toBe(19)
    for (const op of expectedOps) {
      expect(
        fixture.cases.filter((c) => c.op === op).length,
        `缺少 checker Op ${op}`,
      ).toBeGreaterThan(0)
    }
  })

  it('所有 issue 期望值使用 snake_case 持久化字段', () => {
    const allowed = new Set([
      'segment_index',
      'severity',
      'code',
      'message',
      'span',
      'disposition',
      'decided_by',
      'decided_at',
      'note',
    ])
    const allowedSpan = new Set(['matched_text', 'target_start', 'target_end'])
    let checked = 0
    for (const testCase of fixture.cases) {
      const issues = testCase.expect.issues
      if (!Array.isArray(issues)) continue
      for (const issue of issues) {
        const obj = issue as Record<string, unknown>
        for (const key of Object.keys(obj)) {
          expect(allowed.has(key), `${testCase.id}: 非法字段 ${key}`).toBe(true)
        }
        expect(typeof obj.disposition).toBe('string')
        const span = obj.span
        if (span !== undefined) {
          for (const key of Object.keys(span as Record<string, unknown>)) {
            expect(allowedSpan.has(key), `${testCase.id}: 非法 span 字段 ${key}`).toBe(true)
          }
        }
        checked++
      }
    }
    expect(checked).toBeGreaterThan(100)
  })

  it('黄金向量的 segment_index 全部为整数', () => {
    const issues = fixture.cases.flatMap((c) =>
      Array.isArray(c.expect.issues) ? (c.expect.issues as Array<Record<string, unknown>>) : [],
    )
    expect(issues.length).toBeGreaterThan(0)
    for (const issue of issues) {
      expect(Number.isInteger(issue.segment_index)).toBe(true)
    }
  })
})
