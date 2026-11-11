/**
 * `forbidden_term` / `term_inconsistency` checkers（对应 Go `checker_terminology.go`）。
 *
 * - **forbidden_term**：源文命中禁译条目且译文含 banned target → error。
 * - **term_inconsistency**：源文命中推荐词条但译文未使用推荐译法 →
 *   mandatory=true 报 error，否则 warning。
 *
 * `termPresent` 的口径与 glossary 替换一致：CJK 语种直接包含；拉丁语种按**词边界**
 * 独立匹配（`wait` 里的 `ai` 不算命中），`caseSensitive=false` 时大小写不敏感
 * （逐 rune 等宽折叠 + 边界，避免大小写折叠改变长度导致切片错位）。
 */
import { trimSpace } from '../../ruby'
import { equalFold, locateSpan } from '../span'
import { isDigit, isLetter } from '../../shared/unicode'
import { CHECK_FORBIDDEN_TERM, CHECK_TERM_INCONSISTENCY } from '../codes'
import { glossaryIsCJK } from '../glossary'
import {
  SEVERITY_ERROR,
  SEVERITY_WARNING,
  type CheckInput,
  type Checker,
  type Glossary,
  type QualityIssue,
} from '../types'

/** 禁译词检测器。 */
export class ForbiddenTermChecker implements Checker {
  private readonly gls: Glossary | null
  private readonly srcLang: string
  private readonly tgtLang: string

  /** 创建禁译检测器；glossary 为 null 时跳过。 */
  constructor(gls: Glossary | null, srcLang: string, tgtLang: string) {
    this.gls = gls
    this.srcLang = srcLang
    this.tgtLang = tgtLang
  }

  name(): string {
    return CHECK_FORBIDDEN_TERM
  }

  check(segments: readonly CheckInput[]): QualityIssue[] {
    const gls = this.gls
    if (gls === null) {
      return []
    }
    const issues: QualityIssue[] = []
    for (const seg of segments) {
      const src = seg.sourceText
      const tgt = seg.targetText
      if (trimSpace(src) === '' || trimSpace(tgt) === '') {
        continue
      }
      const hits = gls.lookup(src, this.srcLang, this.tgtLang)
      if (hits.length === 0) {
        continue
      }
      const seen = new Set<string>()
      for (const e of hits) {
        if (!e.forbidden) {
          continue
        }
        if (e.target === '') {
          continue
        }
        if (!termPresent(src, e.source, e.caseSensitive, this.srcLang)) {
          continue
        }
        if (!termPresent(tgt, e.target, e.caseSensitive, this.tgtLang)) {
          continue
        }
        const key = `${e.source}\u0000${e.target}`
        if (seen.has(key)) {
          continue
        }
        seen.add(key)
        const span = locateSpan(tgt, e.target) ?? { matchedText: e.target }
        issues.push({
          segmentIndex: seg.index,
          severity: SEVERITY_ERROR,
          code: CHECK_FORBIDDEN_TERM,
          message: `译文含禁译词「${e.target}」（源术语「${e.source}」）`,
          span,
          disposition: '',
        })
      }
    }
    return issues
  }
}

/** 术语不一致检测器。 */
export class TermInconsistencyChecker implements Checker {
  private readonly gls: Glossary | null
  private readonly srcLang: string
  private readonly tgtLang: string

  /** 创建术语不一致检测器；glossary 为 null 时跳过。 */
  constructor(gls: Glossary | null, srcLang: string, tgtLang: string) {
    this.gls = gls
    this.srcLang = srcLang
    this.tgtLang = tgtLang
  }

  name(): string {
    return CHECK_TERM_INCONSISTENCY
  }

  check(segments: readonly CheckInput[]): QualityIssue[] {
    const gls = this.gls
    if (gls === null) {
      return []
    }
    const issues: QualityIssue[] = []
    for (const seg of segments) {
      const src = seg.sourceText
      const tgt = seg.targetText
      if (trimSpace(src) === '' || trimSpace(tgt) === '') {
        continue
      }
      const hits = gls.lookup(src, this.srcLang, this.tgtLang)
      if (hits.length === 0) {
        continue
      }
      const seen = new Set<string>()
      for (const e of hits) {
        if (e.forbidden) {
          continue
        }
        if (e.source === '' || e.target === '') {
          continue
        }
        // 源侧须真正命中（尊重边界与大小写）
        if (!termPresent(src, e.source, e.caseSensitive, this.srcLang)) {
          continue
        }
        if (termPresent(tgt, e.target, e.caseSensitive, this.tgtLang)) {
          continue
        }
        const key = `${e.source}\u0000${e.target}`
        if (seen.has(key)) {
          continue
        }
        seen.add(key)
        issues.push({
          segmentIndex: seg.index,
          severity: e.mandatory ? SEVERITY_ERROR : SEVERITY_WARNING,
          code: CHECK_TERM_INCONSISTENCY,
          message: `术语「${e.source}」未使用推荐译法「${e.target}」`,
          span: { matchedText: e.source },
          disposition: '',
        })
      }
    }
    return issues
  }
}

/**
 * 判断 `needle` 是否按 SafeReplace 边界语义出现在 `haystack` 中（Go `termPresent`）。
 *
 * CJK 语种：直接包含；拉丁：词边界独立匹配；`caseSensitive=false` 时大小写不敏感。
 */
export function termPresent(
  haystack: string,
  needle: string,
  caseSensitive: boolean,
  lang: string,
): boolean {
  if (needle === '' || haystack === '') {
    return false
  }
  if (glossaryIsCJK(lang)) {
    if (caseSensitive) {
      return haystack.includes(needle)
    }
    return haystack.toLowerCase().includes(needle.toLowerCase())
  }
  return latinTermPresent(haystack, needle, caseSensitive)
}

/** 拉丁语种的大小写敏感/不敏感词边界匹配（Go `latinTermPresent`）。 */
export function latinTermPresent(
  haystack: string,
  needle: string,
  caseSensitive: boolean,
): boolean {
  if (caseSensitive) {
    return latinIndependentContains(haystack, needle)
  }
  // 大小写不敏感：按 rune 窗口等宽折叠 + 边界（折叠可能改变字节长度，不能按字节定位）
  const hRunes = Array.from(haystack)
  const nRunes = Array.from(needle)
  if (nRunes.length === 0 || hRunes.length < nRunes.length) {
    return false
  }
  for (let i = 0; i + nRunes.length <= hRunes.length; i++) {
    const window = hRunes.slice(i, i + nRunes.length).join('')
    if (!equalFold(window, needle)) {
      continue
    }
    if (isIndependentMatchRunes(hRunes, i, i + nRunes.length)) {
      return true
    }
  }
  return false
}

/** 大小写敏感的词边界独立包含（Go `latinIndependentContains`）。 */
function latinIndependentContains(s: string, from: string): boolean {
  if (from === '') {
    return false
  }
  const runes = Array.from(s)
  const needle = Array.from(from)
  let i = 0
  while (i < runes.length) {
    const j = indexOfRunes(runes, needle, i)
    if (j < 0) {
      return false
    }
    if (isIndependentMatchRunes(runes, j, j + needle.length)) {
      return true
    }
    i = j + needle.length
  }
  return false
}

/** 在 rune 数组中从 `from` 起查找子序列下标；未找到返回 -1。 */
function indexOfRunes(
  haystack: readonly string[],
  needle: readonly string[],
  from: number,
): number {
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        continue outer
      }
    }
    return i
  }
  return -1
}

/** 两侧非词内字符（Go `isIndependentMatchLocal`）。 */
function isIndependentMatchRunes(runes: readonly string[], start: number, end: number): boolean {
  if (start > 0) {
    const prev = runes[start - 1]!.codePointAt(0) ?? 0
    if (isWordCharLocal(prev)) {
      return false
    }
  }
  if (end < runes.length) {
    const next = runes[end]!.codePointAt(0) ?? 0
    if (isWordCharLocal(next)) {
      return false
    }
  }
  return true
}

/** 词内字符：下划线、字母、数字（Go `isWordCharLocal`）。 */
export function isWordCharLocal(r: number): boolean {
  return r === 0x5f || isLetter(r) || isDigit(r)
}
