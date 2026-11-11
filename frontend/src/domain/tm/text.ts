/**
 * `domain/tm` 的 Go 字符串语义对齐（trim）。
 *
 * 与 `domain/glossary/text.ts` 的 `goTrimSpace` 相同实现：`shared/unicode.ts`
 * 已完成冻结，不能新增导出，故在两个包内各持一份小工具；行为由各自的黄金
 * 向量（含首尾空白用例）交叉验证。
 *
 * 为什么不直接用 `String.prototype.trim`：JS 的 trim 会裁掉 U+FEFF（BOM），
 * 而 Go `strings.TrimSpace` 的 `unicode.IsSpace` 集合**不含** U+FEFF。
 */
import { isSpace } from '../shared/unicode'

/** 取 `index` 之前那个完整码点；越界返回 0。 */
function codePointBefore(text: string, index: number): number {
  if (index <= 0) return 0
  if (index > text.length) index = text.length
  const last = text.charCodeAt(index - 1)
  if (last >= 0xdc00 && last <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2)
    if (high >= 0xd800 && high <= 0xdbff) {
      return text.codePointAt(index - 2) ?? 0
    }
  }
  return text.codePointAt(index - 1) ?? 0
}

/** 等价 Go `strings.TrimSpace`。 */
export function goTrimSpace(text: string): string {
  let start = 0
  while (start < text.length) {
    const cp = text.codePointAt(start) ?? 0
    if (!isSpace(cp)) break
    start += cp > 0xffff ? 2 : 1
  }
  let end = text.length
  while (end > start) {
    const cp = codePointBefore(text, end)
    if (!isSpace(cp)) break
    end -= cp > 0xffff ? 2 : 1
  }
  return text.slice(start, end)
}
