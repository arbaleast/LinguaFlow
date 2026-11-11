/**
 * `untranslated` checker（对应 Go `checker_untranslated.go`）。
 *
 * 检测未翻译的段落（`source == target`）。severity 按语言对三分：
 * 源语独有脚本出现于译文 → error；源语与目标语共用文字系统 → warning
 * （同形文本可能是有意保留的专有名词/原文片段，交由裁决轮降噪）。
 * 语言对无法解析时保守报 error（`source_lang` 默认即 `auto`，降级等于默认关掉防线）。
 */
import { stripRubyTags, trimSpace } from '../../ruby'
import { isLetter } from '../../shared/unicode'
import { CHECK_UNTRANSLATED } from '../codes'
import { stripProtectedRegions } from '../protect_region'
import { containsAnyScript, sourceOnlyScripts, type ScriptTable } from '../scripts'
import { locateSpan } from '../span'
import {
  SEVERITY_ERROR,
  SEVERITY_WARNING,
  type CheckInput,
  type Checker,
  type IssueSeverity,
  type QualityIssue,
} from '../types'

/** 未翻译检测器。 */
export class UntranslatedChecker implements Checker {
  private readonly sourceOnly: ScriptTable[]
  private readonly langsResolved: boolean

  /**
   * 创建一个未翻译检测器。语言对解析失败时不报错，`check` 内按保守策略（error）处理。
   */
  constructor(srcLang: string, tgtLang: string) {
    const resolved = sourceOnlyScripts(srcLang, tgtLang)
    this.sourceOnly = resolved.tables
    this.langsResolved = resolved.ok
  }

  name(): string {
    return CHECK_UNTRANSLATED
  }

  check(segments: readonly CheckInput[]): QualityIssue[] {
    const issues: QualityIssue[] = []
    for (const seg of segments) {
      const rawTgt = trimSpace(seg.targetText)
      // 相等比较用基底形态：LLM 原样回传 ruby 剥离形态时 译文 == strip(原文)，
      // 与含标签的原文精确比较永不相等，检测会被绕过（与 LengthRatioChecker 同口径）。
      // span 定位仍用原始译文形态，MatchedText 必须是用户可见的真实译文。
      const src = trimSpace(stripRubyTags(seg.sourceText))
      const tgt = trimSpace(stripRubyTags(seg.targetText))
      if (src === '' || tgt === '') {
        continue
      }
      if (src !== tgt) {
        continue
      }
      // 豁免判定剥离全部内联标记（Protected 区 ∪ ruby 元素 ∪ 裸标签 ∪ __LF_ 占位符），
      // 与标点/空白类 checker 同一口径；相等判定仍用完整文本。
      if (isExempt(stripProtectedRegions(src, seg.protected))) {
        continue
      }
      const verdict = untranslatedVerdict(this.langsResolved, this.sourceOnly, tgt)
      const span = locateSpan(seg.targetText, rawTgt) ?? { matchedText: rawTgt }
      issues.push({
        segmentIndex: seg.index,
        severity: verdict.severity,
        code: CHECK_UNTRANSLATED,
        message: verdict.message,
        span,
        disposition: '',
      })
    }
    return issues
  }
}

/**
 * 对确认 `src === tgt` 且未豁免的段落给出 severity 与 message。
 *
 * 三分的理由：ja→zh 的纯汉字标题（如「北海道大学」）在确定性层面与正确翻译不可
 * 区分；而源语独有脚本（假名、谚文、西里尔等）出现在回传文本中则是真回传的强证据。
 */
function untranslatedVerdict(
  langsResolved: boolean,
  sourceOnly: readonly ScriptTable[],
  tgt: string,
): { severity: IssueSeverity; message: string } {
  if (!langsResolved || containsAnyScript(tgt, sourceOnly)) {
    return { severity: SEVERITY_ERROR, message: '译文与原文相同' }
  }
  return {
    severity: SEVERITY_WARNING,
    message: '译文与原文相同（源语与目标语共用文字系统，可能为有意保留的专有名词或原文片段）',
  }
}

/**
 * 检查文本是否属于豁免类型（纯数字、纯标点、纯符号、纯占位符）。
 *
 * 调用方应先剥离内联标记：保护区值与裸标签本身含字母，不剥离会令
 * 「无意义符号 + HTML 标签」这类无需翻译的内容漏判。
 */
export function isExempt(text: string): boolean {
  if (text === '') {
    return true
  }
  for (const ch of text) {
    if (isLetter(ch.codePointAt(0) ?? 0)) {
      return false
    }
  }
  return true
}
