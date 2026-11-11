/**
 * 段落文本匹配的契约（对应 Go `backend/internal/service/segmatch`）。
 *
 * 段落窗口查询的 `search` 参数、搜索替换的预览与应用都依赖它，
 * 因此契约在此单点定义，**实现与 Go 的 `segmatch` 逐语义对齐**。
 *
 * ## 偏移单位
 *
 * Go 的 `segmatch.Match` 是 **UTF-8 字节偏移**；本移植统一为
 * **Unicode 码点（rune）偏移**，与 `domain/shared/unicode.ts` 的口径一致。
 * 切片坐标系内截出的子串与 Go 一致。
 */

/** 一次命中的位置（码点偏移，左闭右开）。 */
export interface SearchMatch {
  /** 起始码点下标。 */
  start: number
  /** 结束码点下标（不含）。 */
  end: number
}

/** 匹配器。 */
export interface SearchMatcher {
  /** 查找 text 中所有命中位置（码点偏移，升序）。 */
  find(text: string): SearchMatch[]
  /** 是否存在至少一个命中（语义与 `find(text).length > 0` 一致）。 */
  hasMatch(text: string): boolean
  /** 替换全部命中，返回新文本与替换次数。 */
  replaceAll(text: string, replaceWith: string): { text: string; count: number }
  /** 可用于定位的「安全字面量」锚点。 */
  candidateLiteral(): string
}

/** 匹配模式。 */
export type SearchMatchMode = 'substring' | 'regex'

/** 构造匹配器的选项。 */
export interface SearchOptions {
  /** 查找文本（substring 字面量或 regex 模式）。 */
  find: string
  /** 匹配模式；缺省 `substring`。 */
  matchMode?: SearchMatchMode
  /** 是否区分大小写；缺省 `true`。 */
  caseSensitive?: boolean
  /** 是否整词匹配；缺省 `false`。 */
  wholeWord?: boolean
}

/** 匹配器构造错误码（对应 Go `segmatch` 的哨兵错误）。 */
export const SEARCH_ERROR_INVALID_PATTERN = 'invalid_regex_pattern'
/** 匹配模式不支持。 */
export const SEARCH_ERROR_UNSUPPORTED_MODE = 'unsupported_match_mode'
/** 模式过长（超过 256 个码点）。 */
export const SEARCH_ERROR_PATTERN_TOO_LONG = 'pattern_too_long'

/** 匹配器构造错误。 */
export class SearchError extends Error {
  constructor(
    /** 错误码。 */
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'SearchError'
  }
}

/** 模式最大码点数（对应 Go `segmatch.MaxPatternRunes`）。 */
export const MAX_PATTERN_RUNES = 256
