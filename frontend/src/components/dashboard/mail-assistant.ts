/**
 * 外贸邮件助手：面板模式、高频场景快捷胶囊与请求拼装规则。
 *
 * 这里的函数保持纯函数形态（无 Vue 依赖），便于单测覆盖提示词意图与复制文本的
 * 组装规则；文案本身在语言包中，运行时通过参数传入。
 */

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
