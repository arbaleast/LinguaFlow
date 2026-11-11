/**
 * `domain/script` 的类型契约（对应 Go `backend/internal/script/script.go` 与 `scan.go`）。
 *
 * 该包是「同一语言、多种文字系统」检测的单一事实来源：从目标语言 tag 解析期望
 * 文字系统与同语言的兄弟文字系统，并扫描文本统计兄弟文字系统的专属字符证据，
 * 供 `domain/qa` 的 `script_mismatch` checker 使用。
 *
 * 零平台依赖：语言 tag 解析用 ECMAScript 内建 `Intl.Locale`（**不是** DOM API），
 * 汉字简繁归属查静态生成表（`tables.ts`），不引入任何 opencc 运行时依赖。
 */

/**
 * ISO 15924 文字系统码。
 *
 * Go 侧是 `type Script string`（未知码原样保留），故这里用 `string` 而非字面量联合，
 * 以保留 `scriptDisplayName('Zzzz') === 'Zzzz'` 的透传语义。
 */
export type Script = string

/** 简体汉字。 */
export const SCRIPT_HANS = 'Hans'
/** 繁体汉字。 */
export const SCRIPT_HANT = 'Hant'
/** 拉丁字母。 */
export const SCRIPT_LATN = 'Latn'
/** 西里尔字母。 */
export const SCRIPT_CYRL = 'Cyrl'
/** 阿拉伯字母。 */
export const SCRIPT_ARAB = 'Arab'
/** 传统蒙文。 */
export const SCRIPT_MONG = 'Mong'
/** 古木基文（旁遮普语）。 */
export const SCRIPT_GURU = 'Guru'

/**
 * `Evidence.sample` 的截断上限（Go `maxSampleRunes`）：够上层定位与指纹比对，
 * 又不易超长。
 */
export const MAX_SAMPLE_RUNES = 12

/** 返回用于 issue message 的中文名；未知码原样返回（Go `Script.DisplayName`）。 */
export function scriptDisplayName(script: Script): string {
  switch (script) {
    case SCRIPT_HANS:
      return '简体汉字'
    case SCRIPT_HANT:
      return '繁体汉字'
    case SCRIPT_LATN:
      return '拉丁字母'
    case SCRIPT_CYRL:
      return '西里尔字母'
    case SCRIPT_ARAB:
      return '阿拉伯字母'
    case SCRIPT_MONG:
      return '传统蒙文'
    case SCRIPT_GURU:
      return '古木基文（旁遮普语）'
    default:
      return script
  }
}

/** 目标语言的文字系统期望（Go `Profile`）。 */
export interface Profile {
  /** 语言主子标签（小写），如 `zh`。 */
  language: string
  /** 期望文字系统。 */
  expected: Script
  /** 同语言的其他文字系统（排除 `expected`，顺序即 Scan 并列决胜顺序）。 */
  siblings: Script[]
}

/** 扫描到的与期望文字系统相悖的证据（Go `Evidence`）。 */
export interface Evidence {
  /** 兄弟文字系统。 */
  script: Script
  /** 该系统专属字符出现总数（按 rune 计，重复累计）。 */
  count: number
  /** 首个连续证据 run 的原文（上限 {@link MAX_SAMPLE_RUNES} 个 rune）。 */
  sample: string
}
