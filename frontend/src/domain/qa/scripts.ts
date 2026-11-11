/**
 * 语言 → Unicode Script 集合（对应 Go `backend/internal/qa/scripts.go`）。
 *
 * Go 用 `*unicode.RangeTable` 指针做集合成员判定；TS 侧改用**表名**（字符串）
 * 做同一判定的键，语义等价且可序列化：{@link tableIn} 比较表名，
 * {@link ruleBelongs} 用 `shared/re2.ts` 的 `compile('\\p{Script}')` 判定成员。
 *
 * 与 `domain/script` 的分工：本模块回答「这门语言用什么文字系统」（用于残留检测与
 * 回传判定），`domain/script` 回答「同语言的简繁/正字变体」（用于 script_mismatch）。
 */
import { compile, matchString } from '../shared/re2'
import { isSpace } from '../shared/unicode'

/** 本包用到的 Unicode Script 表名。 */
export type ScriptTable =
  | 'Han'
  | 'Hiragana'
  | 'Katakana'
  | 'Hangul'
  | 'Cyrillic'
  | 'Arabic'
  | 'Hebrew'
  | 'Thai'
  | 'Lao'
  | 'Devanagari'
  | 'Bengali'
  | 'Tamil'
  | 'Telugu'
  | 'Kannada'
  | 'Malayalam'
  | 'Gujarati'
  | 'Gurmukhi'
  | 'Sinhala'
  | 'Tibetan'
  | 'Myanmar'
  | 'Georgian'
  | 'Armenian'
  | 'Ethiopic'
  | 'Khmer'
  | 'Greek'
  | 'Latin'

/** 表名 → 成员判定正则（RE2 `\p{Script}`，等价 Go 的 RangeTable 成员判定）。 */
const TABLE_MATCHERS: ReadonlyMap<ScriptTable, ReturnType<typeof compile>> = new Map(
  (
    [
      'Han',
      'Hiragana',
      'Katakana',
      'Hangul',
      'Cyrillic',
      'Arabic',
      'Hebrew',
      'Thai',
      'Lao',
      'Devanagari',
      'Bengali',
      'Tamil',
      'Telugu',
      'Kannada',
      'Malayalam',
      'Gujarati',
      'Gurmukhi',
      'Sinhala',
      'Tibetan',
      'Myanmar',
      'Georgian',
      'Armenian',
      'Ethiopic',
      'Khmer',
      'Greek',
      'Latin',
    ] as ScriptTable[]
  ).map((name) => [name, compile(`\\p{${name}}`)] as const),
)

/** 判断 rune（码点）是否属于给定脚本表（Go `unicode.Is(t, r)`）。 */
export function tableMatches(table: ScriptTable, cp: number): boolean {
  const matcher = TABLE_MATCHERS.get(table)
  if (matcher === undefined) return false
  return matchString(matcher, String.fromCodePoint(cp))
}

/** 判断 rune 是否属于 tables 中任一脚本（Go `ruleBelongs`）。 */
export function ruleBelongs(r: number, tables: readonly ScriptTable[]): boolean {
  for (const t of tables) {
    if (tableMatches(t, r)) return true
  }
  return false
}

/**
 * 返回语言主标签对应的 Unicode 脚本表集合（Go `primaryScripts`）。
 *
 * 未知语言、`auto` 或空串返回 `null`（Go 的 nil slice）。
 */
export function primaryScripts(lang: string): ScriptTable[] | null {
  switch (normalizeLang(lang)) {
    case 'ja':
      return ['Hiragana', 'Katakana', 'Han']
    case 'ko':
      // Hangul + Han：韩文混用汉字；使 zh→ko 走弱档而非准强档
      return ['Hangul', 'Han']
    case 'zh':
      return ['Han']
    case 'ru':
    case 'uk':
    case 'be':
    case 'bg':
    case 'mk':
    case 'sr':
    case 'mn':
      return ['Cyrillic']
    case 'ar':
    case 'ur':
    case 'fa':
    case 'ps':
    case 'az':
      return ['Arabic']
    case 'he':
    case 'yi':
      return ['Hebrew']
    case 'th':
      return ['Thai']
    case 'lo':
      return ['Lao']
    case 'hi':
    case 'mr':
    case 'sa':
    case 'ne':
      return ['Devanagari']
    case 'bn':
    case 'as':
      return ['Bengali']
    case 'ta':
      return ['Tamil']
    case 'te':
      return ['Telugu']
    case 'kn':
      return ['Kannada']
    case 'ml':
      return ['Malayalam']
    case 'gu':
      return ['Gujarati']
    case 'pa':
      return ['Gurmukhi']
    case 'si':
      return ['Sinhala']
    case 'bo':
    case 'dz':
      return ['Tibetan']
    case 'my':
      return ['Myanmar']
    case 'ka':
      return ['Georgian']
    case 'hy':
      return ['Armenian']
    case 'am':
    case 'ti':
      return ['Ethiopic']
    case 'km':
      return ['Khmer']
    case 'el':
      return ['Greek']
    case 'en':
    case 'fr':
    case 'de':
    case 'es':
    case 'it':
    case 'pt':
    case 'nl':
    case 'vi':
    case 'tr':
    case 'pl':
    case 'sv':
    case 'da':
    case 'no':
    case 'fi':
    case 'cs':
    case 'sk':
    case 'hu':
    case 'ro':
    case 'hr':
    case 'sl':
    case 'lt':
    case 'lv':
    case 'et':
    case 'sq':
    case 'ca':
    case 'gl':
    case 'eu':
    case 'id':
    case 'ms':
    case 'tl':
    case 'sw':
    case 'af':
    case 'is':
    case 'ga':
    case 'cy':
    case 'mt':
    case 'lb':
    case 'bs':
      return ['Latin']
    default:
      return null
  }
}

/** 取 BCP-47 首个子标签并小写（支持 `-` / `_` 分隔；Go `normalizeLang`）。 */
export function normalizeLang(lang: string): string {
  let s = trimSpaceGo(lang)
  if (s === '') return ''
  s = s.toLowerCase()
  const i = firstIndexAny(s, '-_')
  if (i >= 0) {
    s = s.slice(0, i)
  }
  return s
}

/** 判断表名 `t` 是否在 `tables` 集合内（Go `tableIn`，指针相等 → 表名相等）。 */
export function tableIn(tables: readonly ScriptTable[], t: ScriptTable): boolean {
  for (const x of tables) {
    if (x === t) return true
  }
  return false
}

/**
 * 返回源语主脚本中目标语不使用的部分（Go `sourceOnlyScripts`）。
 *
 * 与 `source_residual` 的规则解析不同：不排除 Han，也不分档——判定的是整段回传，
 * Han 本身就是有效证据。任一语言为空/auto/无法解析时 `ok=false`。
 */
export function sourceOnlyScripts(
  srcLang: string,
  tgtLang: string,
): { tables: ScriptTable[]; ok: boolean } {
  const src = normalizeLang(srcLang)
  const tgt = normalizeLang(tgtLang)
  if (src === '' || src === 'auto' || tgt === '' || tgt === 'auto') {
    return { tables: [], ok: false }
  }
  const srcS = primaryScripts(src)
  const tgtS = targetWritingScripts(tgt)
  if (srcS === null || tgtS === null) {
    return { tables: [], ok: false }
  }
  const only: ScriptTable[] = []
  for (const t of srcS) {
    if (!tableIn(tgtS, t)) {
      only.push(t)
    }
  }
  return { tables: only, ok: true }
}

/**
 * 返回目标语现代规范正文实际使用的脚本集（Go `targetWritingScripts`）。
 *
 * 仅 `ko` 与 `primaryScripts` 不同：现代韩文正文以谚文书写，汉字只见于古文与
 * 少量括注。沿用它会让 zh→ko 的差集为空，整段中文回传降为 warning。
 */
export function targetWritingScripts(lang: string): ScriptTable[] | null {
  const scripts = primaryScripts(lang)
  if (scripts === null || normalizeLang(lang) !== 'ko') {
    return scripts
  }
  return scripts.filter((t) => !isHanTable(t))
}

/** 报告 `text` 中是否出现属于 tables 任一脚本的字符（Go `containsAnyScript`）。 */
export function containsAnyScript(text: string, tables: readonly ScriptTable[]): boolean {
  if (tables.length === 0) return false
  for (const ch of text) {
    if (ruleBelongs(ch.codePointAt(0) ?? 0, tables)) {
      return true
    }
  }
  return false
}

/** 判断是否 Han 表（Go `isHanTable`）。 */
export function isHanTable(t: ScriptTable): boolean {
  return t === 'Han'
}

/** 判断是否假名表（Go `isKanaTable`）。 */
export function isKanaTable(t: ScriptTable): boolean {
  return t === 'Hiragana' || t === 'Katakana'
}

/** 判断是否谚文表（Go `isHangulTable`）。 */
export function isHangulTable(t: ScriptTable): boolean {
  return t === 'Hangul'
}

/** 取首个 `-` 或 `_` 的下标（Go `strings.IndexAny`）。 */
function firstIndexAny(s: string, chars: string): number {
  let best = -1
  for (const ch of chars) {
    const i = s.indexOf(ch)
    if (i >= 0 && (best < 0 || i < best)) best = i
  }
  return best
}

/** Go `strings.TrimSpace`。 */
function trimSpaceGo(s: string): string {
  const runes = Array.from(s)
  let start = 0
  let end = runes.length
  while (start < end && isSpace(runes[start]!.codePointAt(0) ?? 0)) start++
  while (end > start && isSpace(runes[end - 1]!.codePointAt(0) ?? 0)) end--
  return runes.slice(start, end).join('')
}
