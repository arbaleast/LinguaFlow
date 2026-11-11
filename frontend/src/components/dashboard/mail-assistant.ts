/**
 * 外贸邮件助手：面板模式、高频场景快捷胶囊与请求拼装规则。
 *
 * 这里的函数保持纯函数形态（无 Vue 依赖），便于单测覆盖提示词意图与复制文本的
 * 组装规则；文案本身在语言包中，运行时通过参数传入。
 *
 * 文字系统检测与专有格式保护复用 `domain/script` 与 `domain/protect` 的既有能力。
 */
import { compile, matchString, replaceAllStringFunc } from '@/domain/shared/re2'
import { compose, nextKey, restoreAll } from '@/domain/protect'
import type { Protector, ProtectableSegment } from '@/domain/protect'

/**
 * 主导文字系统检测用的原始文字类匹配（RE2 `\p{Script}`，与 domain/script 同源引擎）。
 *
 * 不直接用 `domain/script` 的 `runeScript`：它面向简繁证据判定，
 * 简繁共用的常规汉字返回 `ok=false`，而这里需要把所有汉字都算作中文证据。
 */
const HAN_RE = compile('\\p{Han}')
const CYRILLIC_RE = compile('\\p{Cyrillic}')
const ARABIC_RE = compile('\\p{Arabic}')
const LATIN_RE = compile('\\p{Latin}')

/** 面板模式：智能互译 / 外贸邮件回复。 */
export type MailAssistantMode = 'translate' | 'email'

/** 外贸高频场景键（与语言包 quickTranslate.assistant.scenes 的键一一对应）。 */
export type MailAssistantSceneKey = 'standard' | 'quote' | 'dunning' | 'whatsapp'

/** 场景胶囊的展示顺序。 */
export const MAIL_ASSISTANT_SCENES: readonly MailAssistantSceneKey[] = [
  'standard',
  'quote',
  'dunning',
  'whatsapp',
] as const

/** 是否是合法的场景键（语言包与此处必须同步）。 */
export const isMailAssistantSceneKey = (value: string): value is MailAssistantSceneKey =>
  (MAIL_ASSISTANT_SCENES as readonly string[]).includes(value)

/**
 * 组合本次请求的提示词意图：模式意图 + 场景意图。
 *
 * - 邮件模式追加「改写成可直接发送的商务邮件」这一层意图；
 * - 场景追加对应的语气/场景意图（标准商务、报盘议价、礼貌催款、WhatsApp 简短）；
 * - 两者都没有时返回空串，表示不传 instructions，由提示词模板决定默认行为。
 */
export const composeAssistantInstructions = (input: {
  mode: MailAssistantMode
  scene: MailAssistantSceneKey | null
  emailInstruction: string
  sceneInstructions: Record<MailAssistantSceneKey, string>
}): string => {
  const parts: string[] = []
  if (input.mode === 'email') {
    const email = input.emailInstruction.trim()
    if (email) parts.push(email)
  }
  if (input.scene) {
    const scene = input.sceneInstructions[input.scene]?.trim()
    if (scene) parts.push(scene)
  }
  return parts.join('\n')
}

/** 双语对照复制的文本：原文与译文成对输出，便于粘贴到邮件/工单里核对。 */
export const formatBilingualCopy = (input: {
  source: string
  target: string
  sourceLabel: string
  targetLabel: string
}): string =>
  [`${input.sourceLabel}\n${input.source}`, `${input.targetLabel}\n${input.target}`].join('\n\n')

/**
 * 是否需要回退到默认 AI 后端。
 *
 * 没有可用执行计划（未选中计划，或选中的计划不含翻译轮次）时，请求不带
 * execution_plan_id，由后端直接使用默认 AI 后端完成处理。
 */
export const shouldUseDefaultBackend = (
  executionPlanId: number | null,
  translatablePlanIds: readonly number[],
): boolean => executionPlanId == null || !translatablePlanIds.includes(executionPlanId)

/* ── 智能双向语种判定 ─────────────────────────────────────────────── */

/** 输入文本的主导文字系统：汉字 / 拉丁字母 / 无可判定证据。 */
export type MailScriptDetection = 'han' | 'latin' | 'neutral'

/** 源语言为 auto 时，输入中文而目标语言是中文时切换到的首选外语。 */
export const PREFERRED_FOREIGN_LANG = 'en'

/** 常用外贸目标语种（快捷胶囊顺序）。 */
export const QUICK_TARGET_LANGS = ['en', 'es', 'ru', 'ar', 'fr', 'de', 'ja'] as const

/**
 * 判定输入文本的主导文字系统（前端轻量字符检测）。
 *
 * 两种文字系统的可判定字符都为 0 时返回 neutral（纯数字/表情/空白等）；
 * 汉字数 ≥ 拉丁字母数时视为以中文为主，否则以外语为主。
 */
export const detectDominantScript = (text: string): MailScriptDetection => {
  let han = 0
  let latin = 0
  for (const ch of text) {
    if (matchString(HAN_RE, ch)) han += 1
    else if (matchString(LATIN_RE, ch)) latin += 1
  }
  if (han === 0 && latin === 0) return 'neutral'
  return han >= latin ? 'han' : 'latin'
}

export interface EffectiveTarget {
  /** 本次请求实际使用的目标语言 */
  lang: string
  /** 自动检测到的主导文字系统（sourceLang 非 auto 时为 null） */
  detected: MailScriptDetection | null
  /** 是否相对用户选择的目标语言发生了自动切换 */
  switched: boolean
}

/**
 * 解析本次实际生效的目标语言（解决「auto + 目标锁死中文 → 输入中文仍被译为中文」）。
 *
 * 仅在源语言为 auto 时介入：
 * - 输入以中文为主且目标语言是中文（zh-*）→ 改译首选外语（默认英语）；
 * - 输入以外语为主且目标语言恰好是首选外语（同为外语输出无意义）→ 改译简体中文；
 * - 其余情况尊重用户选择，不自动切换。
 */
export const resolveEffectiveTarget = (input: {
  sourceLang: string
  targetLang: string
  text: string
  preferredForeign?: string
}): EffectiveTarget => {
  const preferredForeign = input.preferredForeign ?? PREFERRED_FOREIGN_LANG
  if (input.sourceLang !== 'auto') {
    return { lang: input.targetLang, detected: null, switched: false }
  }
  const detected = detectDominantScript(input.text)
  if (detected === 'han' && input.targetLang.startsWith('zh')) {
    return { lang: preferredForeign, detected, switched: true }
  }
  if (detected === 'latin' && input.targetLang === preferredForeign) {
    return { lang: 'zh-Hans', detected, switched: true }
  }
  return { lang: input.targetLang, detected, switched: false }
}

/* ── 邮件模式：来信上下文 + 回复要点 结构化拼接 ──────────────────── */

/**
 * 「外贸邮件回复」模式的请求原文：客户来信上下文（可选）与中文回复要点
 * 以标签块结构化拼接，供提示词区分上下文与意图。
 */
export const composeEmailSourceText = (input: {
  incomingMail: string
  replyPoints: string
  incomingLabel: string
  pointsLabel: string
}): string => {
  const parts: string[] = []
  const incoming = input.incomingMail.trim()
  const points = input.replyPoints.trim()
  if (incoming) parts.push(`${input.incomingLabel}\n${incoming}`)
  if (points) parts.push(`${input.pointsLabel}\n${points}`)
  return parts.join('\n\n')
}

/* ── 快捷微调（Quick Refine） ───────────────────────────────────── */

/** 快捷微调动作键（与语言包 quickTranslate.assistant.refines 一一对应）。 */
export type MailRefineKey = 'shorten' | 'polite' | 'firm' | 'bullets'

/** 快捷微调按钮的展示顺序。 */
export const QUICK_REFINE_ACTIONS: readonly MailRefineKey[] = [
  'shorten',
  'polite',
  'firm',
  'bullets',
] as const

/** 二次微调指令 = 基础意图 + 微调指令（换行拼接）。 */
export const composeRefineInstructions = (base: string, refine: string): string => {
  const parts = [base.trim(), refine.trim()].filter((part) => part !== '')
  return parts.join('\n')
}

/* ── 专有格式保护（型号 / 金额 / 邮箱 / URL） ───────────────────── */

const EMAIL_RE = compile('[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}')
const BARE_URL_RE = compile('(?:https?://|www\\.)[^\\s<>"\']{2,}')
const CURRENCY_RE = compile(
  '(?:USD|EUR|GBP|CNY|RMB|JPY|AUD|CAD|HKD)\\s?\\d[\\d,]*(?:\\.\\d+)?|\\d[\\d,]*(?:\\.\\d+)?\\s?(?:USD|EUR|GBP|CNY|RMB|JPY|AUD|CAD|HKD)',
)
/** 型号：以大写字母开头（1~6 位）后跟数字/字母/短横线的组合，如 AB-1234、MOQ500。 */
const MODEL_CODE_RE = compile('\\b[A-Z]{1,6}-?\\d[A-Za-z0-9-]{1,18}\\b')

/** 专有格式保护器：邮箱 / 裸 URL / 金额 / 型号代码替换为占位符。 */
export class SensitiveFormatProtector implements Protector {
  readonly name = 'sensitive-format'

  protect(seg: ProtectableSegment): void {
    let s = seg.source
    for (const re of [BARE_URL_RE, EMAIL_RE, CURRENCY_RE, MODEL_CODE_RE]) {
      s = replaceAllStringFunc(re, s, (match) => {
        const k = nextKey(seg)
        seg.protected[k] = match
        return k
      })
    }
    seg.source = s
  }

  unprotect(seg: ProtectableSegment): void {
    seg.target = restoreAll(seg.target, seg.protected)
  }
}

/** 专有格式保护链（复用 domain/protect 的占位符内核与相邻占位符合并）。 */
export const buildSensitiveProtector = (): Protector =>
  compose(new SensitiveFormatProtector())

/* ── 本地快翻历史 ─────────────────────────────────────────────── */

export interface MailAssistantHistoryEntry {
  /** 稳定 id（时间戳 + 序号足够） */
  id: string
  mode: MailAssistantMode
  scene: MailAssistantSceneKey | null
  /** 发送时的原文（邮件模式为拼接后的结构化原文） */
  source: string
  /** 发送后的译文（后编辑后的最终文本） */
  target: string
  created_at: string
}

/** 本地历史保留条数。 */
export const HISTORY_LIMIT = 20

/** 追加一条历史并裁剪到上限（新条目在前；失败/空译文不入史）。 */
export const pushMailAssistantHistory = (
  list: readonly MailAssistantHistoryEntry[],
  entry: MailAssistantHistoryEntry,
  limit: number = HISTORY_LIMIT,
): MailAssistantHistoryEntry[] => [entry, ...list].slice(0, Math.max(1, limit))

/** 译文词数/字符数：CJK（汉字/西里尔/阿拉伯）逐字计 1 词，拉丁连续 token 计 1 词。 */
export const countResultWords = (text: string): { words: number; chars: number } => {
  let words = 0
  for (const token of text.split(/\s+/)) {
    if (!token) continue
    let cjk = false
    for (const ch of token) {
      if (
        matchString(HAN_RE, ch) ||
        matchString(CYRILLIC_RE, ch) ||
        matchString(ARABIC_RE, ch)
      ) {
        words += 1
        cjk = true
      }
    }
    if (!cjk) words += 1
  }
  return { words, chars: [...text].length }
}

/**
 * 失败态的行内原因：
 * - 已有译文（哪怕带警告）→ 不进入失败态；
 * - 请求异常 → 优先展示具体错误信息；
 * - status=failed 且无译文 → 展示后端 warnings（轮次失败原因），缺省给通用文案。
 */
export const resolveFailureNotice = (
  inlineError: string | null,
  result:
    | {
        status?: string
        warnings?: string[]
      }
    | null
    | undefined,
  hasResult: boolean,
  fallbackText: string,
): string | null => {
  if (hasResult) return null
  if (inlineError) return inlineError
  if (result?.status === 'failed') {
    const reason = (result.warnings ?? []).filter((line) => line.trim()).join('\n')
    return reason || fallbackText
  }
  return null
}

/** 模拟流式输出的打字机速度（字符/秒）：40~60 区间取值，兼顾平滑与等待感。 */
export const TYPEWRITER_CPS = 45

/**
 * 打字机进度：按经过时间推算应展示的字符前缀。
 * 后端 quick-translate 为一次性 JSON 返回，前端用该函数把完整译文逐字“吐”出来。
 */
export const typewriterProgress = (
  text: string,
  elapsedMs: number,
  cps: number = TYPEWRITER_CPS,
): string => {
  if (!text) return ''
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return ''
  const shown = Math.floor((elapsedMs / 1000) * Math.max(1, cps))
  return shown >= text.length ? text : text.slice(0, shown)
}

/** 统一生成状态：一次生成在任一时刻只处于一个阶段。 */
export type GenerationState =
  | 'idle'
  | 'preparing'
  | 'streaming'
  | 'completed'
  | 'stopped'
  | 'error'

/** 生成是否仍在进行中（preparing/streaming）——用于禁用重入与切换停止按钮。 */
export const isGenerationBusy = (state: GenerationState): boolean =>
  state === 'preparing' || state === 'streaming'
