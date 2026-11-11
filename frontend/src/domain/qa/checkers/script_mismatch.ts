/**
 * `script_mismatch` checker（对应 Go `checker_script_mismatch.go`）。
 *
 * 检测译文文字系统与目标语言不符：同语言多文字系统的语言（`zh-Hans`/`zh-Hant`、
 * `sr-Latn`/`sr-Cyrl`）中，译文出现兄弟文字系统专属字符（≥1 即报，与 `width_mix`
 * 的「出现即报」口径一致）。
 *
 * 仅对多文字系统语言（`resolveProfile` 成功）活跃；单文字系统语言（en/ja）、`auto`
 * 与无法解析的目标语一律静默不活跃，不产生任何 issue。
 */
import { trimSpace } from '../../ruby'
import { resolveProfile, scanProfile, scriptDisplayName, type Profile } from '../../script'
import { CHECK_SCRIPT_MISMATCH } from '../codes'
import { inlineMarkupRegions, locateSpanExcludingRegions, stripRegions } from '../protect_region'
import { SEVERITY_WARNING, type CheckInput, type Checker, type QualityIssue } from '../types'

/** 文字系统不符检测器。 */
export class ScriptMismatchChecker implements Checker {
  /** 原始 tag，用于 message 展示（不截断、不改写）。 */
  private readonly targetLang: string
  private readonly profile: Profile | null

  /**
   * 创建文字系统不符检测器。
   *
   * `targetLang` 为原始 BCP-47 tag（如 `zh-Hans`），仅用于 message 展示；
   * 是否活跃由 `script.resolveProfile` 决定。
   */
  constructor(targetLang: string) {
    this.targetLang = targetLang
    this.profile = resolveProfile(targetLang)
  }

  name(): string {
    return CHECK_SCRIPT_MISMATCH
  }

  check(segments: readonly CheckInput[]): QualityIssue[] {
    const profile = this.profile
    if (profile === null) {
      return []
    }
    const issues: QualityIssue[] = []
    for (const seg of segments) {
      const tgt = seg.targetText
      if (trimSpace(tgt) === '') {
        continue
      }
      // 占位符/内联标记保护区不参与判别（与 width_mix 同一屏蔽出口）。
      const regions = inlineMarkupRegions(tgt, seg.protected)
      const cleanTgt = stripRegions(tgt, regions)
      const ev = scanProfile(profile, cleanTgt)
      if (ev === null) {
        continue
      }
      let sample = ev.sample
      if (!tgt.includes(sample)) {
        // sample 来自 strip 后的文本，可能横跨被保护区隔开的两个原文片段
        // （原文中并不连续）；退化为首字符，保证 span 与 message 均可在原文定位。
        sample = Array.from(sample)[0] ?? ''
      }
      const span = locateSpanExcludingRegions(tgt, sample, regions) ?? { matchedText: sample }
      issues.push({
        segmentIndex: seg.index,
        severity: SEVERITY_WARNING,
        code: CHECK_SCRIPT_MISMATCH,
        message: `译文使用了${scriptDisplayName(ev.script)}（如「${sample}」），目标语言 ${this.targetLang} 期望${scriptDisplayName(profile.expected)}`,
        span,
        disposition: '',
      })
    }
    return issues
  }
}
