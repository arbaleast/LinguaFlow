import { describe, expect, it } from 'vitest'

import {
  HISTORY_LIMIT,
  MAIL_ASSISTANT_SCENES,
  PREFERRED_FOREIGN_LANG,
  QUICK_REFINE_ACTIONS,
  QUICK_TARGET_LANGS,
  buildSensitiveProtector,
  composeAssistantInstructions,
  composeEmailSourceText,
  composeRefineInstructions,
  countResultWords,
  detectDominantScript,
  formatBilingualCopy,
  isMailAssistantSceneKey,
  pushMailAssistantHistory,
  isGenerationBusy,
  resolveFailureNotice,
  typewriterProgress,
  resolveEffectiveTarget,
  shouldUseDefaultBackend,
  type MailAssistantSceneKey,
} from '@/components/dashboard/mail-assistant'
import { protectText, restoreText } from '@/domain/protect'

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

describe('detectDominantScript', () => {
  it('以中文为主', () => {
    expect(detectDominantScript('MOQ 500 件不能降低')).toBe('han')
    expect(detectDominantScript('你好，世界！请回复报价。')).toBe('han')
  })

  it('以外语为主', () => {
    expect(detectDominantScript('Could you confirm the lead time?')).toBe('latin')
  })

  it('无可判定文字时返回 neutral', () => {
    expect(detectDominantScript('12345 ... \n')).toBe('neutral')
  })
})

describe('resolveEffectiveTarget', () => {
  it('源语言非 auto 时不介入', () => {
    const resolved = resolveEffectiveTarget({
      sourceLang: 'en',
      targetLang: 'zh-Hans',
      text: '中文输入也一样',
    })
    expect(resolved).toEqual({ lang: 'zh-Hans', detected: null, switched: false })
  })

  it('auto + 中文输入 + 目标锁死中文 → 自动切到首选外语', () => {
    const resolved = resolveEffectiveTarget({
      sourceLang: 'auto',
      targetLang: 'zh-Hans',
      text: 'MOQ 500 件不能降低，但可以免费寄送样品。',
    })
    expect(resolved.lang).toBe(PREFERRED_FOREIGN_LANG)
    expect(resolved.detected).toBe('han')
    expect(resolved.switched).toBe(true)
  })

  it('auto + 中文输入 + 目标已是外语 → 尊重用户选择', () => {
    const resolved = resolveEffectiveTarget({
      sourceLang: 'auto',
      targetLang: 'es',
      text: '请回复交期。',
    })
    expect(resolved).toEqual({ lang: 'es', detected: 'han', switched: false })
  })

  it('auto + 外语输入 + 目标恰为首选外语 → 改译简体中文', () => {
    const resolved = resolveEffectiveTarget({
      sourceLang: 'auto',
      targetLang: 'en',
      text: 'Could you confirm the MOQ and lead time?',
    })
    expect(resolved.lang).toBe('zh-Hans')
    expect(resolved.detected).toBe('latin')
    expect(resolved.switched).toBe(true)
  })

  it('auto + 外语输入 + 目标为中文 → 保持中文', () => {
    const resolved = resolveEffectiveTarget({
      sourceLang: 'auto',
      targetLang: 'zh-Hant',
      text: 'Please send the invoice.',
    })
    expect(resolved).toEqual({ lang: 'zh-Hant', detected: 'latin', switched: false })
  })

  it('auto + 纯中性文本 → 不切换', () => {
    const resolved = resolveEffectiveTarget({
      sourceLang: 'auto',
      targetLang: 'zh-Hans',
      text: '123456 12.50',
    })
    expect(resolved).toEqual({ lang: 'zh-Hans', detected: 'neutral', switched: false })
  })
})

describe('composeEmailSourceText', () => {
  it('来信与要点按标签块拼接', () => {
    const text = composeEmailSourceText({
      incomingMail: 'Dear sir, please quote.',
      replyPoints: '报价 USD 2.0，交期 30 天。',
      incomingLabel: '【客户来信】',
      pointsLabel: '【中文回复要点】',
    })
    expect(text).toBe(
      '【客户来信】\nDear sir, please quote.\n\n【中文回复要点】\n报价 USD 2.0，交期 30 天。',
    )
  })

  it('没有来信时只包含要点块', () => {
    const text = composeEmailSourceText({
      incomingMail: '  ',
      replyPoints: '确认后发货',
      incomingLabel: '【客户来信】',
      pointsLabel: '【中文回复要点】',
    })
    expect(text).toBe('【中文回复要点】\n确认后发货')
  })

  it('两个都为空时返回空串', () => {
    expect(
      composeEmailSourceText({
        incomingMail: '',
        replyPoints: '',
        incomingLabel: 'A',
        pointsLabel: 'B',
      }),
    ).toBe('')
  })
})

describe('composeRefineInstructions', () => {
  it('基础意图与微调指令换行拼接', () => {
    expect(composeRefineInstructions('基础', '缩短')).toBe('基础\n缩短')
  })

  it('无基础意图时只保留微调指令', () => {
    expect(composeRefineInstructions('', ' 缩短 ')).toBe('缩短')
  })
})

describe('QUICK_TARGET_LANGS / QUICK_REFINE_ACTIONS', () => {
  it('常用外贸语种快捷胶囊覆盖七个语种', () => {
    expect(QUICK_TARGET_LANGS).toEqual(['en', 'es', 'ru', 'ar', 'fr', 'de', 'ja'])
  })

  it('快捷微调动作覆盖四个方向', () => {
    expect(QUICK_REFINE_ACTIONS).toEqual(['shorten', 'polite', 'firm', 'bullets'])
  })
})

describe('buildSensitiveProtector / protectText / restoreText', () => {
  it('保护金额、邮箱与 URL 并在还原后逐字复原', () => {
    const protector = buildSensitiveProtector()
    const source =
      '单价 USD 12.50，MOQ 500 件，样品寄到 sales@acme.com，详情见 https://www.acme.com/quote?id=7'
    const { text, mapping } = protectText(protector, source)
    expect(text).not.toContain('USD 12.50')
    expect(text).not.toContain('sales@acme.com')
    expect(text).not.toContain('https://www.acme.com')
    expect(mapping).not.toBeNull()
    expect(restoreText(text, mapping ?? {})).toBe(source)
  })

  it('普通文本不产生占位符', () => {
    const { mapping } = protectText(buildSensitiveProtector(), '请确认交期与数量。')
    expect(mapping).toBeNull()
  })

  it('结果中出现未还原占位符时还原保持可读', () => {
    const protector = buildSensitiveProtector()
    const { text, mapping } = protectText(protector, 'USD 12.50 per piece')
    expect(mapping).not.toBeNull()
    // 模型丢失占位符时 restore 只是原样返回，不产生副作用
    expect(restoreText('价格保持不变', mapping ?? {})).toBe('价格保持不变')
  })
})

describe('countResultWords', () => {
  it('英文按词统计，中文按字统计', () => {
    expect(countResultWords('Dear customer, thanks a lot')).toEqual({ words: 5, chars: 27 })
    expect(countResultWords('您好，请回复')).toEqual({ words: 5, chars: 6 })
    expect(countResultWords('')).toEqual({ words: 0, chars: 0 })
  })
})

describe('pushMailAssistantHistory', () => {
  const entry = (id: string) => ({
    id,
    mode: 'translate' as const,
    scene: null,
    source: `src-${id}`,
    target: `dst-${id}`,
    created_at: '2026-09-30T00:00:00Z',
  })

  it('新条目插到最前并裁剪到上限', () => {
    const list = Array.from({ length: HISTORY_LIMIT }, (_, i) => entry(String(i)))
    const next = pushMailAssistantHistory(list, entry('new'))
    expect(next[0]?.id).toBe('new')
    expect(next).toHaveLength(HISTORY_LIMIT)
    expect(next.at(-1)?.id).toBe(String(HISTORY_LIMIT - 2))
  })

  it('limit 传 1 时只保留一条', () => {
    const next = pushMailAssistantHistory([entry('a'), entry('b')], entry('c'), 1)
    expect(next).toHaveLength(1)
    expect(next[0]?.id).toBe('c')
  })
})

describe('resolveFailureNotice', () => {
  const fallback = '翻译失败'

  it('已有译文时不进入失败态（警告不吞译文）', () => {
    expect(
      resolveFailureNotice(
        null,
        { status: 'failed', warnings: ['round 1 failed'] },
        true,
        fallback,
      ),
    ).toBeNull()
  })

  it('请求异常时优先展示具体错误信息', () => {
    expect(
      resolveFailureNotice(
        '上游 AI 后端返回 502',
        { status: 'failed', warnings: ['round 1 failed'] },
        false,
        fallback,
      ),
    ).toBe('上游 AI 后端返回 502')
  })

  it('failed 且无译文时展示后端 warnings（多行合并）', () => {
    expect(
      resolveFailureNotice(
        null,
        { status: 'failed', warnings: ['round 1 (translate) failed: 502', 'round 2 failed'] },
        false,
        fallback,
      ),
    ).toBe('round 1 (translate) failed: 502\nround 2 failed')
  })

  it('failed 且无 warnings 时回退到通用文案', () => {
    expect(resolveFailureNotice(null, { status: 'failed', warnings: [] }, false, fallback)).toBe(
      fallback,
    )
  })

  it('无结果且无异常时不进入失败态（保持空状态示例）', () => {
    expect(resolveFailureNotice(null, null, false, fallback)).toBeNull()
    expect(
      resolveFailureNotice(null, { status: 'success', warnings: [] }, false, fallback),
    ).toBeNull()
  })
})

describe('typewriterProgress', () => {
  const sentence = 'Dear customer, our MOQ is 500 pcs and samples ship in 7 days.'

  it('0ms 时不展示任何字符', () => {
    expect(typewriterProgress(sentence, 0)).toBe('')
  })

  it('按 45 字符/秒推进：500ms 展示 22 个字符', () => {
    expect(typewriterProgress(sentence, 500)).toBe(sentence.slice(0, 22))
  })

  it('超过所需时长后一次性返回完整文本', () => {
    expect(typewriterProgress(sentence, 60_000)).toBe(sentence)
  })

  it('空文本与非法时长安全返回空串', () => {
    expect(typewriterProgress('', 500)).toBe('')
    expect(typewriterProgress(sentence, Number.NaN)).toBe('')
    expect(typewriterProgress(sentence, -10)).toBe('')
  })

  it('支持自定义速度（cps）', () => {
    expect(typewriterProgress(sentence, 1000, 10)).toBe(sentence.slice(0, 10))
  })
})

describe('isGenerationBusy', () => {
  it('preparing 与 streaming 视为进行中', () => {
    expect(isGenerationBusy('preparing')).toBe(true)
    expect(isGenerationBusy('streaming')).toBe(true)
  })

  it('终态与空闲不视为进行中（避免误禁用重试与编辑）', () => {
    for (const state of ['idle', 'completed', 'stopped', 'error'] as const) {
      expect(isGenerationBusy(state)).toBe(false)
    }
  })
})
