import { describe, expect, it } from 'vitest'

import {
  MAIL_ASSISTANT_SCENES,
  composeAssistantInstructions,
  formatBilingualCopy,
  isMailAssistantSceneKey,
  shouldUseDefaultBackend,
  type MailAssistantSceneKey,
} from '@/components/dashboard/mail-assistant'

const sceneInstructions: Record<MailAssistantSceneKey, string> = {
  standard: '标准商务意图',
  quote: '报盘议价意图',
  dunning: '礼貌催款意图',
  whatsapp: 'WhatsApp 简短意图',
}

describe('composeAssistantInstructions', () => {
  it('智能互译且未选场景时不传任何意图', () => {
    const instructions = composeAssistantInstructions({
      mode: 'translate',
      scene: null,
      emailInstruction: '邮件意图',
      sceneInstructions,
    })
    expect(instructions).toBe('')
  })

  it('智能互译只携带场景意图', () => {
    const instructions = composeAssistantInstructions({
      mode: 'translate',
      scene: 'quote',
      emailInstruction: '邮件意图',
      sceneInstructions,
    })
    expect(instructions).toBe('报盘议价意图')
  })

  it('邮件模式叠加模式意图与场景意图', () => {
    const instructions = composeAssistantInstructions({
      mode: 'email',
      scene: 'dunning',
      emailInstruction: '邮件意图',
      sceneInstructions,
    })
    expect(instructions).toBe('邮件意图\n礼貌催款意图')
  })

  it('空文案不会产生空行', () => {
    const instructions = composeAssistantInstructions({
      mode: 'email',
      scene: 'standard',
      emailInstruction: '   ',
      sceneInstructions: { ...sceneInstructions, standard: '' },
    })
    expect(instructions).toBe('')
  })
})

describe('formatBilingualCopy', () => {
  it('原文与译文成对输出并留空行分隔', () => {
    const text = formatBilingualCopy({
      source: 'Dear customer',
      target: '尊敬的客户',
      sourceLabel: '【原文】',
      targetLabel: '【译文】',
    })
    expect(text).toBe('【原文】\nDear customer\n\n【译文】\n尊敬的客户')
  })
})

describe('shouldUseDefaultBackend', () => {
  it('没有选中执行计划时回退到默认后端', () => {
    expect(shouldUseDefaultBackend(null, [1, 2])).toBe(true)
  })

  it('选中的执行计划可用时不回退', () => {
    expect(shouldUseDefaultBackend(2, [1, 2])).toBe(false)
  })

  it('选中的执行计划不含翻译轮次时回退', () => {
    expect(shouldUseDefaultBackend(3, [1, 2])).toBe(true)
  })

  it('系统没有任何可用执行计划时回退', () => {
    expect(shouldUseDefaultBackend(null, [])).toBe(true)
  })
})

describe('场景键', () => {
  it('覆盖四个外贸高频场景', () => {
    expect(MAIL_ASSISTANT_SCENES).toEqual(['standard', 'quote', 'dunning', 'whatsapp'])
  })

  it('只接受已知场景键', () => {
    expect(isMailAssistantSceneKey('whatsapp')).toBe(true)
    expect(isMailAssistantSceneKey('unknown')).toBe(false)
  })
})
