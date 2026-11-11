/**
 * `source_residual` checker（对应 Go `checker_source_residual.go`）。
 *
 * 检测译文中夹带的源语脚本片段。规则按语言对解析，分四档（强 / 准强 / 中 / 弱），
 * 弱档（zh→ja/ko 的 Han）默认关闭。同段只应用首个命中规则档（强档优先）。
 *
 * 与 `untranslated` 的分工：整段未译（`strip(src) === strip(tgt)`）由 untranslated
 * 负责，本 checker 跳过，避免同一段刷两条冗余 warning。
 */
import { stripRubyTags, trimSpace } from '../../ruby'
import { runeCount } from '../../shared/unicode'
import { CHECK_SOURCE_RESIDUAL } from '../codes'
import {
  inlineMarkupRegions,
  locateSpanExcludingRegions,
  stripProtectedRegions,
} from '../protect_region'
import {
  isHanTable,
  isHangulTable,
  isKanaTable,
  normalizeLang,
  primaryScripts,
  tableIn,
  tableMatches,
  type ScriptTable,
} from '../scripts'
import { SEVERITY_WARNING, type CheckInput, type Checker, type QualityIssue } from '../types'

/** 可调常量：强档独立脚本默认最小连续长度；kana/hangul 为 1。 */
const MIN_RUN_KANA = 1 // 假名在非目标脚本中几乎必为残留
const MIN_RUN_HANGUL = 1 // 谚文同上
const MIN_RUN_DEFAULT = 2 // 其余独立脚本强档默认，规避单字符噪声
const MIN_RUN_HAN_SEMI = 2 // 准强档 Han
const MIN_RUN_HAN_MED = 2 // 中等档 Han
const MIN_RUN_HAN_WEAK = 3 // 弱档 Han

/** 弱档（zh→ja/ko Han）默认关闭；路径保留便于后续开启。 */
const WEAK_TIER_ENABLED = false

/** 规则档位（Go `residualTier`）。 */
type ResidualTier = 'strong' | 'semi_strong' | 'medium' | 'weak'

/** 锚定模式：optional = 译文侧 run 直接命中；required = 需源/译双向包含。 */
type AnchorMode = 'optional' | 'required'

/** 一条源语残留检测规则（Go `residualRule`）。 */
export interface ResidualRule {
  tier: ResidualTier
  script: ScriptTable[]
  minRun: number
  anchor: AnchorMode
}

/** 源语残留检测器。 */
export class SourceResidualChecker implements Checker {
  private readonly rules: ResidualRule[]

  /** 按语言对解析规则并创建检测器。 */
  constructor(srcLang: string, tgtLang: string) {
    this.rules = resolveRules(srcLang, tgtLang)
  }

  name(): string {
    return CHECK_SOURCE_RESIDUAL
  }

  check(segments: readonly CheckInput[]): QualityIssue[] {
    if (this.rules.length === 0) {
      return []
    }
    const issues: QualityIssue[] = []
    for (const seg of segments) {
      const rawSrc = seg.sourceText
      const rawTgt = seg.targetText
      const src = trimSpace(rawSrc)
      const tgt = trimSpace(rawTgt)
      if (src === '' || tgt === '') {
        continue
      }
      // 交接守卫与 untranslated 同口径：比较在 ruby 剥离形态上进行。
      if (trimSpace(stripRubyTags(src)) === trimSpace(stripRubyTags(tgt))) {
        continue // 整段未译由 untranslated 负责
      }
      // 与其他文本类 checker 保持同一口径：内联标签、ruby 元素和占位符均不参与残留判定。
      const regions = inlineMarkupRegions(rawTgt, seg.protected)
      const cleanedTgt = trimSpace(stripProtectedRegions(rawTgt, seg.protected))
      const cleanedSrc = trimSpace(stripProtectedRegions(rawSrc, seg.protected))
      // 在原始目标文本上定位偏移，并跳过保护区内同名文本。
      const seen = new Set<string>()
      for (const rule of this.rules) {
        const hits = collectResidualHits(cleanedSrc, cleanedTgt, rule)
        for (const hit of hits) {
          if (seen.has(hit)) {
            continue
          }
          seen.add(hit)
          const span = locateSpanExcludingRegions(rawTgt, hit, regions) ?? { matchedText: hit }
          issues.push({
            segmentIndex: seg.index,
            severity: SEVERITY_WARNING,
            code: CHECK_SOURCE_RESIDUAL,
            message: `译文残留源语片段：${hit}`,
            span,
            disposition: '',
          })
        }
        if (hits.length > 0) {
          break // 同段只应用首个命中规则档
        }
      }
    }
    return issues
  }
}

/** 按源/目标语言解析适用的残留检测规则（Go `resolveRules`）。 */
export function resolveRules(sourceLang: string, targetLang: string): ResidualRule[] {
  const src = normalizeLang(sourceLang)
  const tgt = normalizeLang(targetLang)
  if (src === '' || src === 'auto' || tgt === '' || tgt === 'auto') {
    return []
  }
  const srcS = primaryScripts(src)
  const tgtS = primaryScripts(tgt)
  if (srcS === null || tgtS === null) {
    return []
  }

  const rules: ResidualRule[] = []

  // 非 Han 的源特有脚本 → 强档（kana 合并为一条）
  const distinctive: ScriptTable[] = []
  const kanaTables: ScriptTable[] = []
  for (const t of srcS) {
    if (isHanTable(t)) {
      continue
    }
    if (tableIn(tgtS, t)) {
      continue
    }
    if (isKanaTable(t)) {
      kanaTables.push(t)
      continue
    }
    distinctive.push(t)
  }
  if (kanaTables.length > 0) {
    rules.push({ tier: 'strong', script: kanaTables, minRun: MIN_RUN_KANA, anchor: 'optional' })
  }
  for (const t of distinctive) {
    rules.push({
      tier: 'strong',
      script: [t],
      minRun: isHangulTable(t) ? MIN_RUN_HANGUL : MIN_RUN_DEFAULT,
      anchor: 'optional',
    })
  }

  // Han 相关
  const srcHasHan = tableIn(srcS, 'Han')
  const tgtHasHan = tableIn(tgtS, 'Han')
  if (srcHasHan && !tgtHasHan) {
    // zh→en/fr/ru…：Han 在目标不应出现 → 准强（锚定）
    rules.push({
      tier: 'semi_strong',
      script: ['Han'],
      minRun: MIN_RUN_HAN_SEMI,
      anchor: 'required',
    })
  } else if (srcHasHan && tgtHasHan && src !== tgt) {
    if ((src === 'zh' && tgt === 'ja') || (src === 'zh' && tgt === 'ko')) {
      if (WEAK_TIER_ENABLED) {
        rules.push({
          tier: 'weak',
          script: ['Han'],
          minRun: MIN_RUN_HAN_WEAK,
          anchor: 'required',
        })
      }
    } else if (src === 'ja' && tgt === 'zh') {
      rules.push({ tier: 'medium', script: ['Han'], minRun: MIN_RUN_HAN_MED, anchor: 'required' })
    }
  }

  return rules
}

/**
 * 收集命中的残留片段（Go `collectResidualHits`）。
 *
 * 无锚定：译文侧脚本 run 直接命中。
 * 需锚定：双向匹配——源 run 出现在译文，或译文 run 出现在源（覆盖 CJK 粘连与部分残留）。
 */
export function collectResidualHits(
  cleanedSrc: string,
  cleanedTgt: string,
  rule: ResidualRule,
): string[] {
  if (rule.anchor !== 'required') {
    const hits: string[] = []
    for (const run of extractScriptRuns(cleanedTgt, rule.script)) {
      if (runeCount(run) < rule.minRun) {
        continue
      }
      hits.push(run)
    }
    return hits
  }

  const seen = new Set<string>()
  const hits: string[] = []
  const add = (run: string): void => {
    if (seen.has(run)) {
      return
    }
    seen.add(run)
    hits.push(run)
  }
  for (const run of extractScriptRuns(cleanedSrc, rule.script)) {
    if (runeCount(run) < rule.minRun) {
      continue
    }
    if (cleanedTgt.includes(run)) {
      add(run)
    }
  }
  for (const run of extractScriptRuns(cleanedTgt, rule.script)) {
    if (runeCount(run) < rule.minRun) {
      continue
    }
    if (cleanedSrc.includes(run)) {
      add(run)
    }
  }
  return hits
}

/** 收集属于给定脚本集合的连续极大段（Go `extractScriptRuns`）。 */
export function extractScriptRuns(text: string, scripts: readonly ScriptTable[]): string[] {
  if (text === '' || scripts.length === 0) {
    return []
  }
  const runs: string[] = []
  let buf: string[] = []
  const flush = (): void => {
    if (buf.length > 0) {
      runs.push(buf.join(''))
      buf = []
    }
  }
  for (const ch of text) {
    if (tableMatchesAny(ch.codePointAt(0) ?? 0, scripts)) {
      buf.push(ch)
    } else {
      flush()
    }
  }
  flush()
  return runs
}

/** rune 是否属于任一脚本表。 */
function tableMatchesAny(cp: number, scripts: readonly ScriptTable[]): boolean {
  for (const t of scripts) {
    if (tableMatches(t, cp)) return true
  }
  return false
}
