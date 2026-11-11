/**
 * Go 字符串语义的本地对齐工具。
 *
 * 这些行为本应属于 `domain/shared/unicode.ts`，但该目录已完成并冻结，
 * 故在包内补齐（两个包各自持有一份同样的小工具，行为由黄金向量交叉验证）：
 *
 * - `goTrimSpace`：Go `strings.TrimSpace`（`unicode.IsSpace` 集合，**不含** U+FEFF）；
 *   JS 的 `String.prototype.trim` 会裁掉 U+FEFF，语义不同。
 * - `goToLower`：Go `strings.ToLower` 的简单大小写映射；JS `toLowerCase` 是完整
 *   映射（如 U+0130 会展开成两个码点），故按码点取展开后的首个码点，保持
 *   每个 rune → 单个 rune 的 Go 语义，也保证下标可对齐。
 * - `goEqualFold`：表头比较用的近似 EqualFold（小写后比较）。
 */
import { isSpace } from '../shared/unicode'

/** 取 UTF-16 下标处的码点；越界返回 0（调用方均先做边界判断）。 */
export function codePointAt(text: string, index: number): number {
  if (index < 0 || index >= text.length) return 0
  return text.codePointAt(index) ?? 0
}

/** 取 `index` 之前那个完整码点；越界返回 0。代理对会被正确合并。 */
export function codePointBefore(text: string, index: number): number {
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

/** 等价 Go `strings.TrimSpace`：裁掉两侧 `unicode.IsSpace` 码点。 */
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

/** 等价 Go `strings.ToLower`（简单映射，逐码点小写）。 */
export function goToLower(text: string): string {
  let out = ''
  for (const ch of text) {
    const lower = ch.toLowerCase()
    const first = lower.codePointAt(0)
    out += first === undefined ? ch : String.fromCodePoint(first)
  }
  return out
}

/** 近似 Go `strings.EqualFold`（用于表头等 ASCII 场景）。 */
export function goEqualFold(a: string, b: string): boolean {
  return goToLower(a) === goToLower(b)
}

/** Go `strings.IndexAny(s, chars)`：返回首个命中字符的下标，未命中返回 -1。 */
export function indexAny(text: string, chars: string): number {
  for (let i = 0; i < text.length; i++) {
    if (chars.includes(text[i] as string)) return i
  }
  return -1
}
