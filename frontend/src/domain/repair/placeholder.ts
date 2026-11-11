/**
 * 占位符变体归一（对应 Go `backend/internal/repair/placeholder.go`）。
 */
import { compile, findStringSubmatch, replaceAllStringFunc } from '../shared/re2'

/**
 * 匹配 LF 占位符的常见变体形态：
 *
 * - 标准：`__LF_000001__`
 * - 大小写错：`__lf_000001__`
 * - 缺中间下划线：`__LF000001__`
 * - 末尾 0–2 个下划线（LLM 剥离尾部下划线）
 * - 数字位数不规范（少于 6 位补零；多于 6 位拒绝）
 *
 * 注意：`\d` 在 RE2 中是 ASCII `[0-9]`；此处通过 `compile()` 保证 RE2 语义。
 */
const placeholderVariantRE = compile('__[lL][fF]_?(\\d{1,7})_{0,2}')

/**
 * 把 text 中「形态错误」的 LF 占位符归一回标准 `__LF_NNNNNN__`。
 *
 * **Guard**：仅当归一后的 key 在 knownKeys 中存在时才替换；未知 key 的变体
 * 一律不动，以免把正文里偶然出现的类占位符字面值替换成真占位符。
 *
 * 返回 `{text, normalized}`：normalized 为被实际归一的标准 key 列表
 * （按出现顺序、去重）。
 */
export function normalizePlaceholders(
  text: string,
  knownKeys: Record<string, string>,
): { text: string; normalized: string[] } {
  if (Object.keys(knownKeys).length === 0) {
    return { text, normalized: [] }
  }
  const normalized: string[] = []
  const seen = new Set<string>()

  const out = replaceAllStringFunc(placeholderVariantRE, text, (match) => {
    const sub = findStringSubmatch(placeholderVariantRE, match)
    if (sub === null || sub.length < 2) return match
    let digits = sub[1] as string
    if (digits.length > 6) {
      // 超出标准位数，可能是 LLM 编造的；不修复。
      return match
    }
    while (digits.length < 6) digits = `0${digits}`
    const std = `__LF_${digits}__`
    if (!Object.prototype.hasOwnProperty.call(knownKeys, std)) return match
    if (match !== std && !seen.has(std)) {
      seen.add(std)
      normalized.push(std)
    }
    return std
  })
  return { text: out, normalized }
}
