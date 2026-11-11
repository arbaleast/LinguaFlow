/**
 * 术语安全替换（对应 Go `backend/internal/glossary/replace.go`）。
 *
 * 两种边界策略：
 * - **CJK 目标语**（`zh`/`ja`/`ko`/`th`/`lo`/`my`/`km`）：无空格分词，直接全量替换。
 * - **其他目标语**：只替换两侧 rune 都不是「词内字符」（letter / digit / `_`）
 *   的独立匹配；`"AI"` 出现在 `"wait"` 里时保留。
 *
 * 词边界判定必须走 **rune（码点）** 语义：Go 用 `utf8.DecodeLastRuneInString` /
 * `utf8.DecodeRuneInString`，TS 用 `codePointBefore` / `codePointAt`（代理对合并）。
 * 字符分类走 `shared/unicode.ts` 的 `isLetter` / `isDigit`，与 Go 的
 * `unicode.IsLetter` / `unicode.IsDigit`（`\p{Nd}`）一致。
 *
 * 本文件不含任何正则：Go 侧只用 `strings.Index` / `strings.ReplaceAll`，
 * 移植后同样只用字符串查找，避免 JS/RE2 语义差异。
 */
import { isDigit, isLetter } from '../shared/unicode'
import { codePointAt, codePointBefore, goToLower, goTrimSpace, indexAny } from './text'

/** 无空格分词的目标语主 tag（Go `IsCJKTarget` 的 case 列表）。 */
const CJK_LANGUAGE_TAGS: ReadonlySet<string> = new Set(['zh', 'ja', 'ko', 'th', 'lo', 'my', 'km'])

/**
 * 目标语是否属于「无空格分词」语种（Go `IsCJKTarget`）。
 *
 * 只识别 BCP-47 主 tag（`"zh-CN"` → `"zh"`），大小写无关，容许首尾空白；
 * `"zhh"` 不是 `"zh"`。主 tag 前的分隔符（`"-zh"`，下标 0）不参与截断。
 */
export function isCJKTarget(lang: string): boolean {
  let primary = goToLower(goTrimSpace(lang))
  const separator = indexAny(primary, '-_')
  if (separator > 0) primary = primary.slice(0, separator)
  return CJK_LANGUAGE_TAGS.has(primary)
}

/** 安全替换结果（Go 的 `(newText, replaced, warn)` 三元返回）。 */
export interface SafeReplaceResult {
  text: string
  /** 是否发生过实际替换。 */
  replaced: boolean
  /** 非空时调用方应记 Warn 日志。 */
  warn: string
}

/** 词内字符：下划线 / letter / digit（Go `isWordChar`）。 */
function isWordChar(cp: number): boolean {
  return cp === 0x5f || isLetter(cp) || isDigit(cp)
}

/**
 * 判断 `text[start, end)` 两侧是否构成词边界（Go `isIndependentMatch`）。
 *
 * 左侧取 start 之前的完整码点，右侧取 end 处的完整码点；端点视为边界。
 */
function isIndependentMatch(text: string, start: number, end: number): boolean {
  if (start > 0 && isWordChar(codePointBefore(text, start))) return false
  if (end < text.length && isWordChar(codePointAt(text, end))) return false
  return true
}

/**
 * 把 `from` 字面值替换为 `to`（Go `SafeReplace`）。
 *
 * `from === ""` 或 `from === to` 时短路返回原文本（noop）。
 */
export function safeReplace(
  text: string,
  from: string,
  to: string,
  lang: string,
): SafeReplaceResult {
  if (from === '' || from === to) {
    return { text, replaced: false, warn: '' }
  }

  if (isCJKTarget(lang)) {
    if (!text.includes(from)) return { text, replaced: false, warn: '' }
    // 等价 Go `strings.ReplaceAll`：非重叠、从左到右。
    return { text: text.split(from).join(to), replaced: true, warn: '' }
  }

  let out = ''
  let index = 0
  let replaced = false
  let skippedSubstrings = 0
  while (index < text.length) {
    const found = text.indexOf(from, index)
    if (found < 0) {
      out += text.slice(index)
      break
    }
    const start = found
    const end = start + from.length
    if (isIndependentMatch(text, start, end)) {
      out += text.slice(index, start)
      out += to
      replaced = true
    } else {
      out += text.slice(index, end)
      skippedSubstrings++
    }
    index = end
  }

  let warn = ''
  if (skippedSubstrings > 0 && !replaced) {
    warn = 'ambiguous-substring-only'
  } else if (skippedSubstrings > 0 && replaced) {
    warn = `kept ${skippedSubstrings} substring matches`
  }
  return { text: out, replaced, warn }
}

/**
 * 大小写不敏感替换（Go `CaseInsensitiveReplace`）。
 *
 * Go 的实现是「对原文和 needle 同时 ToLower，用 ToLower 文本上找到的下标去
 * 原文本切片」，并假定小写不改变长度。本实现逐行复刻该算法（含其隐含假设），
 * 以保证与后端输出一致；对长度会变化的极少数码点（如 U+0130）两者都不保证
 * 正确，这是 Go 侧的既有行为，不在移植层私自修正。
 */
export function caseInsensitiveReplace(
  text: string,
  old: string,
  replacement: string,
): { text: string; replaced: boolean } {
  if (old === '') return { text, replaced: false }

  const lowerText = goToLower(text)
  const lowerOld = goToLower(old)
  if (!lowerText.includes(lowerOld)) return { text, replaced: false }

  let out = ''
  let index = 0
  let replaced = false
  while (index < text.length) {
    const found = lowerText.indexOf(lowerOld, index)
    if (found < 0) {
      out += text.slice(index)
      break
    }
    out += text.slice(index, found)
    out += replacement
    replaced = true
    index = found + old.length
  }
  return { text: out, replaced }
}
