/**
 * 汉字简繁归属判定（对应 Go `backend/internal/script/han.go`）。
 *
 * Go 侧的两张专属字表由 `tables.go` 提供（构建期由 OpenCC 推导、运行时零依赖），
 * 本模块把表展开为码点集合，并剔除「两栖字」（简繁文本中都属规范用法）。
 * **不引入任何 opencc 依赖**。
 *
 * 非 Han 字符按 Unicode Script 归类，与 Go 的 `unicode.Is(unicode.X, r)` 对齐：
 * 这里统一用 `shared/re2.ts` 的 `compile()`（RE2 的 `\p{Script}` 语义），
 * 而不是 JS `RegExp` 字面量，以固定匹配引擎。
 */
import { compile, matchString } from '../shared/re2'
import { HANS_SPECIFIC_CHARS, HANT_SPECIFIC_CHARS } from './tables'
import {
  SCRIPT_ARAB,
  SCRIPT_CYRL,
  SCRIPT_GURU,
  SCRIPT_HANS,
  SCRIPT_HANT,
  SCRIPT_LATN,
  SCRIPT_MONG,
  type Script,
} from './types'

/**
 * 手工维护的「两栖字」清单（Go `sharedOverride`）：推导表会把它们判为某一侧专属，
 * 但它们在简繁文本中均属规范用法，单字证据的误报代价远高于漏报，构建专属表时剔除。
 *
 * 繁体侧（OpenCC t2s 会转写，但简体亦常用）：
 * - 乾（乾隆/乾坤）
 *
 * 简体侧（OpenCC s2t 会转写，但繁体亦常用）：
 * - 后（皇后）、里（公里/里長）、干（干涉/若干）
 * - 范（姓氏）、于（姓氏）、余（文言第一人称）、云（子曰诗云）
 * - 斗（北斗/熨斗）、岩（岩石）、咸（老少咸宜）
 * - 准（批准/准許）、划（划船）、征（遠征/長征）、游（游泳）
 * - 台（台灣）、峰（峰为繁体标准写法，峯反是异体）、迹（跡/迹并通）
 * - 采（文采/采邑）、党（党項/姓氏）、郁（馥郁/姓氏）、雇（僱的异体）
 *
 * 著经实测推导已归为共用（OpenCC 字级不转著→着），无须剔除。
 */
export const SHARED_OVERRIDE = '乾后里干范于余云斗岩咸准划征游台峰迹采党郁雇'

/** Unicode Script 判定（RE2 `\p{Script}`，等价 Go 的 RangeTable 成员判定）。 */
const HAN_RE = compile('\\p{Han}')
const CYRILLIC_RE = compile('\\p{Cyrillic}')
const LATIN_RE = compile('\\p{Latin}')
const ARABIC_RE = compile('\\p{Arabic}')
const MONGOLIAN_RE = compile('\\p{Mongolian}')
const GURMUKHI_RE = compile('\\p{Gurmukhi}')

/** 惰性构建的两张专属码点集合（Go `hanTables` 的 `sync.Once`）。 */
let hansTable: Set<number> | null = null
let hantTable: Set<number> | null = null

/** 把生成表字符串展开为码点集合，剔除 override 中的两栖字（Go `buildSpecific`）。 */
function buildSpecific(chars: string, override: Set<number>): Set<number> {
  const out = new Set<number>()
  for (const ch of chars) {
    const cp = ch.codePointAt(0) ?? 0
    if (override.has(cp)) continue
    out.add(cp)
  }
  return out
}

/** 惰性构建并返回两张 Han 专属码点表（Go `hanTables`）。 */
export function hanTables(): { hans: Set<number>; hant: Set<number> } {
  if (hansTable === null || hantTable === null) {
    const override = new Set<number>()
    for (const ch of SHARED_OVERRIDE) {
      override.add(ch.codePointAt(0) ?? 0)
    }
    hansTable = buildSpecific(HANS_SPECIFIC_CHARS, override)
    hantTable = buildSpecific(HANT_SPECIFIC_CHARS, override)
  }
  return { hans: hansTable, hant: hantTable }
}

/** 单个 rune 的文字系统归属判定结果（Go `(Script, bool)`）。 */
export interface RuneScript {
  /** 判定的文字系统；`ok=false` 时为空串。 */
  script: Script
  /** 是否可判定为管辖内的某个文字系统。 */
  ok: boolean
}

/**
 * 判别单个 rune（码点）的文字系统归属（Go `runeScript`）。
 *
 * 非 Han 字符按 Unicode Script 直接归类；Han 字符查简繁专属表：
 * 落在某一侧专属表则返回该侧，简繁共用或表未收录的返回 `ok=false`（中性，不算证据）。
 * 标点、数字、组合符号（Inherited）等一律中性。
 */
export function runeScript(r: number): RuneScript {
  const ch = String.fromCodePoint(r)
  if (matchString(HAN_RE, ch)) {
    const { hans, hant } = hanTables()
    if (hans.has(r)) return { script: SCRIPT_HANS, ok: true }
    if (hant.has(r)) return { script: SCRIPT_HANT, ok: true }
    // 简繁共用，不算证据
    return { script: '', ok: false }
  }
  if (matchString(CYRILLIC_RE, ch)) return { script: SCRIPT_CYRL, ok: true }
  // `\p{Latin}` 只含拉丁字母本身，ASCII 数字/标点不在其中，可直接用
  if (matchString(LATIN_RE, ch)) return { script: SCRIPT_LATN, ok: true }
  if (matchString(ARABIC_RE, ch)) return { script: SCRIPT_ARAB, ok: true }
  if (matchString(MONGOLIAN_RE, ch)) return { script: SCRIPT_MONG, ok: true }
  if (matchString(GURMUKHI_RE, ch)) return { script: SCRIPT_GURU, ok: true }
  // Common/Inherited/其他文字，中性
  return { script: '', ok: false }
}
