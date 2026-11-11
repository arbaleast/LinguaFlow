/**
 * 注音守恒类检查（对应 Go `backend/internal/qa/conservation.go`）。
 *
 * 这类 issue 不由 checker 注册表产出，而是由 pipeline（translate 轮注音还原）与
 * service（人工编辑）在特定写路径上按文本事实直接产出，同样持久化到 `quality_issues`。
 */
import { CODE_RUBY_TAG_LOSS } from './codes'
import { SEVERITY_WARNING, type QualityIssue } from './types'

/**
 * 检测人工编辑导致的译文注音全丢失（Go `RubyTagLossIssues`）：编辑前译文含
 * `<ruby>` 注音标签而编辑后一条不剩时，产出一条 warning 级 issue。
 *
 * 判据用基线对比（编辑前 vs 编辑后）而非 source 对比：零配置依赖、对 ruby 关闭的
 * 资源零误报。检测为 `<ruby>` 字面计数——标签形态变形（大小写/属性）视为丢失。
 * issue 不带 Span，指纹稳定为 code 本身：用户对一次全丢失标注 dismissed 后，
 * 后续编辑若仍全丢失会继承该裁决。
 */
export function rubyTagLossIssues(
  segmentIndex: number,
  prev: string,
  next: string,
): QualityIssue[] {
  const n = countLiteral(prev, '<ruby>')
  if (n > 0 && !next.includes('<ruby>')) {
    return [
      {
        segmentIndex,
        severity: SEVERITY_WARNING,
        code: CODE_RUBY_TAG_LOSS,
        message: `译文注音全部丢失：编辑前 ${n} 条`,
        disposition: '',
      },
    ]
  }
  return []
}

/** 统计字面量出现次数（Go `strings.Count`）。 */
function countLiteral(haystack: string, needle: string): number {
  if (needle === '') {
    return countRunes(haystack) + 1
  }
  let count = 0
  let from = 0
  for (;;) {
    const i = haystack.indexOf(needle, from)
    if (i < 0) {
      return count
    }
    count++
    from = i + needle.length
  }
}

/** 码点数（`strings.Count(s, "")` 的语义是 rune 数 + 1，仅供空 needle 分支使用）。 */
function countRunes(s: string): number {
  let n = 0
  for (const _ch of s) n++
  return n
}
