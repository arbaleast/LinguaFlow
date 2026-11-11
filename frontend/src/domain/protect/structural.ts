/**
 * 保护链结构判定（对应 Go `backend/internal/protect/structural.go`）。
 *
 * 「结构段」= 在当前保护配置下剥离全部可保护跨度后不再含任何字母/数字的段落
 * （只有空白 / 标点 / 占位符），无需送翻。
 */
import { isDigit, isLetter } from '../shared/unicode'
import type { ProtectableSegment, Protector } from './types'

/**
 * 一次保护链结构分析的结果。
 *
 * 判定与保护来自同一次链执行——调用方经 `apply` 落盘产物即可完成保护阶段，
 * 无须对同一段文本二次执行保护链。
 */
export interface StructuralAnalysis {
  /** 是否为结构段。 */
  structural: boolean
  /** 保护后的文本。 */
  protected: string
  /** 「占位符 → 原片段」映射。链未执行时为 `null`（对应 Go 的 nil map）。 */
  mapping: Record<string, string> | null
  /** 保护链写入段级 Meta 的副作用（如 ruby_items）。 */
  meta: Record<string, unknown> | null
  /** 保护链是否失败。 */
  err: boolean
  /**
   * 链是否真正执行过：短路（原文无字母/数字）与 `protector === null` 时为 false，
   * 此时产物全部为零值、apply 无副作用。
   */
  ran: boolean
}

/**
 * 在保护链 p 下分析文本：判定是否结构段，并保留保护链产物。
 *
 * 判定语义与 `isStructuralOnly` 完全一致（同一实现）。
 * 映射 key 固定 14 字符且互无前缀关系，逐 key 替换剥除与顺序无关；
 * 原文里的字面量 `__LF_NNNNNN__` 因 `nextKey` 冲突跳过不进映射，
 * 残留在残余中（含字母数字）→ 判为有内容，fail-safe 方向正确。
 */
export function analyzeStructural(protector: Protector | null, text: string): StructuralAnalysis {
  if (!hasLetterOrDigit(text)) {
    return { structural: true, protected: '', mapping: null, meta: null, err: false, ran: false }
  }
  if (protector === null) {
    return { structural: false, protected: '', mapping: null, meta: null, err: false, ran: false }
  }
  const seg: ProtectableSegment = { source: text, target: '', protected: {} }
  protector.protect(seg)

  let residual = seg.source
  for (const k of Object.keys(seg.protected)) {
    residual = residual.split(k).join('')
  }

  const meta = seg.meta && Object.keys(seg.meta).length > 0 ? seg.meta : null
  // Go 侧 `seg.Protected` 为 nil（未分配过任何占位符）时 `Analysis.Mapping` 也是 nil，
  // 与「空但非 nil 的 map」在 JSON 上不同，故此处显式区分。
  const mapping = Object.keys(seg.protected).length > 0 ? seg.protected : null

  return {
    structural: !hasLetterOrDigit(residual),
    protected: seg.source,
    mapping,
    meta,
    err: false,
    ran: true,
  }
}

/**
 * 判断文本在保护链 p 下是否为「结构段」。
 *
 * 复用 protectText 的完整保护链（含 link 子跨度替换、相邻占位符合并、ruby 剥离）
 * 得到占位符形态文本，再将映射 key 全部替换为空得残余文本；
 * 残余不含任何字母或数字（汉字属 Letter 类别）即为结构段。
 *
 * 原文本身无字母/数字时直接短路返回 true（残余是原文字符集的子集）。
 * `protector` 为 null 时按原文本判定（无保护配置的降级路径）。
 */
export function isStructuralOnly(protector: Protector | null, text: string): boolean {
  return analyzeStructural(protector, text).structural
}

/**
 * 将分析产物落盘到 seg。
 *
 * Source 换为保护后文本、Protected 换为映射、Meta 副作用合并进 seg.meta——
 * 与对同一文本直接执行 protect 的落盘结果完全一致（同一链的同一次执行）。
 * 链未跑过（短路 / null）时无副作用；
 * 链跑过但无占位符时仍落盘 Source 与 Meta（如 ruby-only 段）。
 */
export function applyAnalysis(analysis: StructuralAnalysis, seg: ProtectableSegment): void {
  if (analysis.err) return
  if (!analysis.ran) return
  seg.source = analysis.protected
  seg.protected = analysis.mapping ?? {}
  if (analysis.meta) {
    if (!seg.meta) {
      seg.meta = {}
    }
    for (const [k, v] of Object.entries(analysis.meta)) {
      seg.meta[k] = v
    }
  }
}

/**
 * 判断文本是否含任何 Unicode 字母或数字（汉字属 Letter 类别）。
 *
 * Go `hasLetterOrDigit`：按 rune 迭代，`unicode.IsLetter` / `unicode.IsDigit`。
 */
export function hasLetterOrDigit(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (isLetter(cp) || isDigit(cp)) return true
  }
  return false
}
