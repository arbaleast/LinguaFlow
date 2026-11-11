/**
 * 从目标语言 tag 解析文字系统期望（对应 Go `backend/internal/script/script.go`）。
 *
 * Go 侧用 `golang.org/x/text/language`：`Parse` 校验并规范化 tag，`Base()` 取语言
 * 主子标签，`Script()` 优先取显式 script 子标签、缺失时按 CLDR likely-subtags 兜底
 * （zh→Hans、zh-TW→Hant、sr→Cyrl、uz→Latn）。
 *
 * TS 侧改用 ECMAScript 内建的 `Intl.Locale`（不是 DOM API）：`new Intl.Locale(tag)`
 * 做同等的结构性校验与规范化，`.script` 取显式子标签，`.maximize().script` 取
 * CLDR likely-subtags。两处刻意的实现细节：
 *
 * 1. **语言主子标签按结构解析**，不用 `locale.language`：`Intl.Locale` 会把
 *    `cmn`（ISO 639-3 汉语码）别名归一化为 `zh`，而 Go 的 `Base()` 保留 `cmn`，
 *    注册表也以 `cmn` 为键（Go 测试断言 `Profile.Language == "cmn"`）。
 * 2. **script 一律 Title-case 输出**：`Intl.Locale` 的 `.script` 已是 `Hans` 形态，
 *    与 Go `sc.String()` 的 ISO 15924 四字母码一致。
 */
import { isSpace } from '../shared/unicode'
import {
  SCRIPT_ARAB,
  SCRIPT_CYRL,
  SCRIPT_GURU,
  SCRIPT_HANS,
  SCRIPT_HANT,
  SCRIPT_LATN,
  SCRIPT_MONG,
  type Profile,
  type Script,
} from './types'

/** Go `strings.TrimSpace`（unicode.IsSpace，不含 JS `trim()` 额外的 U+FEFF）。 */
function trimSpaceGo(s: string): string {
  const runes = Array.from(s)
  let start = 0
  let end = runes.length
  while (start < end && isSpace(runes[start]!.codePointAt(0) ?? 0)) start++
  while (end > start && isSpace(runes[end - 1]!.codePointAt(0) ?? 0)) end--
  return runes.slice(start, end).join('')
}

/**
 * 声明式注册表：语言主子标签（小写）→ 该语言全部可用文字系统。
 *
 * 切片顺序即 Scan 并列证据时的决胜顺序，不要随意调换。
 * `cmn` 为汉语的 ISO 639-3 码，与 `zh` 同义。
 */
const LANGUAGE_SCRIPTS: Readonly<Record<string, readonly Script[]>> = {
  zh: [SCRIPT_HANS, SCRIPT_HANT],
  cmn: [SCRIPT_HANS, SCRIPT_HANT],
  sr: [SCRIPT_CYRL, SCRIPT_LATN],
  uz: [SCRIPT_LATN, SCRIPT_CYRL, SCRIPT_ARAB],
  kk: [SCRIPT_CYRL, SCRIPT_LATN, SCRIPT_ARAB],
  az: [SCRIPT_LATN, SCRIPT_CYRL, SCRIPT_ARAB],
  mn: [SCRIPT_CYRL, SCRIPT_MONG],
  pa: [SCRIPT_GURU, SCRIPT_ARAB],
  ms: [SCRIPT_LATN, SCRIPT_ARAB],
  ug: [SCRIPT_ARAB, SCRIPT_CYRL, SCRIPT_LATN],
  ku: [SCRIPT_LATN, SCRIPT_ARAB, SCRIPT_CYRL],
  tg: [SCRIPT_CYRL, SCRIPT_LATN],
}

/** 判断 `s` 是否在 `scripts` 集合内（Go `scriptIn`）。 */
export function scriptIn(scripts: readonly Script[], s: Script): boolean {
  for (const x of scripts) {
    if (x === s) return true
  }
  return false
}

/** 尝试构造 `Intl.Locale`；非法 tag 返回 `null`（Go `language.Parse` 的 error）。 */
function parseLocale(tag: string): Intl.Locale | null {
  try {
    return new Intl.Locale(tag)
  } catch {
    return null
  }
}

/**
 * 取 BCP-47 的语言主子标签（Go `lang.Base()`）。
 *
 * 只取第一个子标签；`Intl.Locale` 已保证 tag 结构合法，故无需再做校验。
 */
function primarySubtag(tag: string): string {
  const first = tag.split('-')[0] ?? ''
  return first.toLowerCase()
}

/**
 * 从目标语言 tag 解析 {@link Profile}（Go `Resolve`）。
 *
 * region 信息仅用于推断 script，不参与注册表匹配（如 zh-TW → Hant）。
 * 空串、`auto`、解析失败、语言主子标签不在注册表（单文字系统语言、垃圾串等），
 * 或推断出的 script 不在该语言的注册表集合内，一律返回 `null`（对应 Go 的
 * `(zero, false)`）。
 */
export function resolveProfile(targetLang: string): Profile | null {
  const raw = trimSpaceGo(targetLang)
  if (raw === '' || raw.toLowerCase() === 'auto') {
    return null
  }
  let parsedTag = raw
  let locale = parseLocale(raw)
  if (locale === null) {
    // 容错：小写化并把下划线换成连字符后再试一次（如 "zh_Hans" / "ZH-HANS"）
    parsedTag = raw.toLowerCase().replaceAll('_', '-')
    locale = parseLocale(parsedTag)
    if (locale === null) {
      return null
    }
  }

  const langKey = primarySubtag(parsedTag)
  if (langKey === '' || langKey === 'und') {
    return null
  }
  const scripts = LANGUAGE_SCRIPTS[langKey]
  if (scripts === undefined) {
    return null
  }

  // `.script` 尊重显式 script 子标签，缺失时按 CLDR likely-subtags 兜底
  // （zh→Hans、zh-TW→Hant、sr→Cyrl、uz→Latn）；其值即 ISO 15924 四字母码。
  let expected = locale.script
  if (expected === undefined) {
    expected = locale.maximize().script
  }
  if (expected === undefined) {
    return null
  }
  if (!scriptIn(scripts, expected)) {
    return null
  }

  const siblings = scripts.filter((s) => s !== expected)
  return { language: langKey, expected, siblings }
}
