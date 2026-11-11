/**
 * QA 引擎（对应 Go `backend/internal/qa/qa.go` 的 `Engine` / `NewEngine` /
 * `buildAllCheckers`）。
 *
 * 注册顺序即 `AllCheckerNames()`：`checks` 为 `null` 时注册全部 checker；
 * 非 `null` 时仅注册名单中的 checker（按 `name()` 精确匹配）。
 *
 * 与 Go 的差异：Go 的 `NewEngine(cfg, logger)` 需要 `*slog.Logger`，日志是平台能力，
 * 领域层不引入；引擎在这里只做纯编排。
 */
import { DuplicateTranslationChecker } from './checkers/duplicate'
import { LengthRatioChecker } from './checkers/length'
import { NumberMismatchChecker } from './checkers/number'
import { LeftoverPlaceholderChecker } from './checkers/placeholder_leak'
import { PunctuationMissingChecker } from './checkers/punctuation_missing'
import { PunctuationPairingChecker } from './checkers/punctuation_pairing'
import { PunctuationSurplusChecker } from './checkers/punctuation_surplus'
import { PunctuationWrapLossChecker } from './checkers/punctuation_wrap_loss'
import { ScriptMismatchChecker } from './checkers/script_mismatch'
import { SourceResidualChecker } from './checkers/source_residual'
import { SubtitleLineCountChecker } from './checkers/subtitle_line'
import { ForbiddenTermChecker, TermInconsistencyChecker } from './checkers/terminology'
import { UntranslatedChecker } from './checkers/untranslated'
import { URLEmailMismatchChecker } from './checkers/url_email'
import { RepeatedSpaceChecker, WhitespaceIrregularChecker } from './checkers/whitespace'
import { WidthMixChecker } from './checkers/width_mix'
import { XMLTagMismatchChecker } from './checkers/xml_tag'
import { checkerEnabled } from './qa'
import type { CheckInput, Checker, Config, QualityIssue } from './types'

/** 按配置构造全部 per-batch checker（Go `buildAllCheckers`，顺序不可调换）。 */
export function buildAllCheckers(cfg: Config): Checker[] {
  return [
    new UntranslatedChecker(cfg.sourceLang, cfg.targetLang),
    new LengthRatioChecker(cfg.lengthRatioMin, cfg.lengthRatioMax, cfg.lengthMethod),
    new DuplicateTranslationChecker(),
    new SourceResidualChecker(cfg.sourceLang, cfg.targetLang),
    new PunctuationPairingChecker(cfg.targetLang),
    new PunctuationMissingChecker(),
    new PunctuationSurplusChecker(),
    new PunctuationWrapLossChecker(),
    new WhitespaceIrregularChecker(),
    new RepeatedSpaceChecker(cfg.targetLang),
    new WidthMixChecker(cfg.targetLang),
    new ScriptMismatchChecker(cfg.targetLang),
    new NumberMismatchChecker(),
    new URLEmailMismatchChecker(),
    new SubtitleLineCountChecker(cfg.format),
    new ForbiddenTermChecker(cfg.glossary, cfg.sourceLang, cfg.targetLang),
    new TermInconsistencyChecker(cfg.glossary, cfg.sourceLang, cfg.targetLang),
    new LeftoverPlaceholderChecker(),
    new XMLTagMismatchChecker(),
  ]
}

/** 编排多个 {@link Checker} 并汇总结果。 */
export class Engine {
  private readonly checkers: Checker[]
  private readonly config: Config

  /** 创建一个新的 QA 引擎（Go `NewEngine`）。 */
  constructor(config: Config) {
    this.config = config
    const all = buildAllCheckers(config)
    if (config.checks === null) {
      this.checkers = all
    } else {
      this.checkers = all.filter((c) => checkerEnabled(config.checks, c.name()))
    }
  }

  /** 已注册的 checker 列表（只读快照；测试与调用方用于诊断）。 */
  registeredCheckers(): readonly Checker[] {
    return this.checkers
  }

  /** 对所有段落运行全部检测器（Go `Engine.Run`）；`enabled=false` 时恒为空。 */
  run(segments: readonly CheckInput[]): QualityIssue[] {
    if (!this.config.enabled) {
      return []
    }
    const allIssues: QualityIssue[] = []
    for (const c of this.checkers) {
      allIssues.push(...c.check(segments))
    }
    return allIssues
  }
}
