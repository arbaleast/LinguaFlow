/**
 * 字词计数（对应 Go `backend/internal/pipeline/batch_utils.go` 的 `CountWords` / `IsCJK`）。
 *
 * Go 侧原文：
 *
 * ```go
 * func CountWords(text string) int {
 *     count := 0
 *     inWord := false
 *     for _, r := range text {          // 按 rune（Unicode 码点）迭代
 *         if IsCJK(r) {
 *             count++
 *             inWord = false
 *         } else if unicode.IsSpace(r) {
 *             inWord = false
 *         } else {
 *             if !inWord { count++; inWord = true }
 *         }
 *     }
 *     return count
 * }
 *
 * func IsCJK(r rune) bool {
 *     return unicode.Is(unicode.Han, r) ||
 *         unicode.Is(unicode.Hiragana, r) ||
 *         unicode.Is(unicode.Katakana, r) ||
 *         unicode.Is(unicode.Hangul, r)
 * }
 * ```
 *
 * 口径：**CJK 字符每个计 1 词**；拉丁文字按空白分隔的连续非空白段计 1 词。
 * 迭代单位是 Unicode 码点（rune），不是 UTF-8 字节，也不是 UTF-16 code unit，
 * 故生僻字与 Emoji 代理对都按 1 个字符处理。
 */
import { isCJK, isSpace } from './unicode'

/** 判断码点是否为 CJK（Han / Hiragana / Katakana / Hangul）。 */
export function isCJKCodePoint(cp: number): boolean {
  return isCJK(cp)
}

/**
 * 计算文本的字词数。等价 Go `pipeline.CountWords`。
 *
 * @param text 待统计文本
 * @returns 字词数（CJK 每字符 1 词，其余按空白分段）
 */
export function countWords(text: string): number {
  let count = 0
  let inWord = false
  // `for...of` 字符串迭代按 Unicode 码点进行，与 Go 的 rune 迭代一致。
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (isCJK(cp)) {
      count++
      inWord = false
    } else if (isSpace(cp)) {
      inWord = false
    } else if (!inWord) {
      count++
      inWord = true
    }
  }
  return count
}

/**
 * 批量统计。等价 Go 侧对多个段落逐个调用 `CountWords`。
 */
export function countWordsAll(texts: readonly string[]): number[] {
  return texts.map(countWords)
}
