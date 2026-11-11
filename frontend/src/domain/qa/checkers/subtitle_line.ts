/**
 * `subtitle_line_count` checker（对应 Go `checker_subtitle_line.go`）。
 *
 * 仅在 `format ∈ {srt, ass, vtt}` 时启用，检测源/译行数不一致（字幕行数错位会让
 * 时间轴与文本对不上）。`\r\n` / `\r` 先归一化为 `\n` 再计数。
 */
import { trimSpace } from '../../ruby'
import { CHECK_SUBTITLE_LINE_COUNT } from '../codes'
import { SEVERITY_WARNING, type CheckInput, type Checker, type QualityIssue } from '../types'

/** 字幕行数检测器。 */
export class SubtitleLineCountChecker implements Checker {
  private readonly enabled: boolean

  /** 创建字幕行数检测器。 */
  constructor(format: string) {
    const f = trimSpace(format).toLowerCase()
    this.enabled = f === 'srt' || f === 'ass' || f === 'vtt'
  }

  name(): string {
    return CHECK_SUBTITLE_LINE_COUNT
  }

  /** 报告该格式是否启用本检测（Go 的 `enabled` 字段）。 */
  isEnabled(): boolean {
    return this.enabled
  }

  check(segments: readonly CheckInput[]): QualityIssue[] {
    if (!this.enabled) {
      return []
    }
    const issues: QualityIssue[] = []
    for (const seg of segments) {
      const src = seg.sourceText
      const tgt = seg.targetText
      if (trimSpace(src) === '' || trimSpace(tgt) === '') {
        continue
      }
      const srcLines = countContentLines(src)
      const tgtLines = countContentLines(tgt)
      if (srcLines === tgtLines) {
        continue
      }
      issues.push({
        segmentIndex: seg.index,
        severity: SEVERITY_WARNING,
        code: CHECK_SUBTITLE_LINE_COUNT,
        message: `字幕行数不一致：原文 ${srcLines} 行，译文 ${tgtLines} 行`,
        disposition: '',
      })
    }
    return issues
  }
}

/** 按换行计行；末尾单独空行不额外计（Go `countContentLines`）。 */
export function countContentLines(s: string): number {
  const normalized = s.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  if (normalized === '') {
    return 0
  }
  let n = 0
  for (const ch of normalized) {
    if (ch === '\n') n++
  }
  return n + 1
}
