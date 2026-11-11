import { beforeEach, describe, expect, it } from 'vitest'

import {
  WORKBENCH_DRAFT_VERSION,
  clearWorkbenchDraft,
  emptyWorkbenchDraft,
  isWorkbenchDraftEmpty,
  readWorkbenchDraft,
  sanitizeWorkbenchDraft,
  shouldDeferToOtherTab,
  writeWorkbenchDraft,
} from '@/utils/workbench-draft'

const draft = (overrides: Record<string, unknown> = {}) => ({
  ...emptyWorkbenchDraft('tab-a'),
  source_text: 'Dear customer, MOQ 500 pcs.',
  result_text: 'MOQ 500 件。',
  mode: 'translate' as const,
  ...overrides,
})

beforeEach(() => {
  globalThis.localStorage?.clear()
  clearWorkbenchDraft('test-scope')
})

describe('workbench draft storage', () => {
  it('round-trips the full work-in-progress state', () => {
    const value = draft({
      mode: 'email',
      incoming_mail: 'Please quote A100.',
      reply_points: 'MOQ 不可降',
      glossary: [{ id: 3, source: 'MOQ', target: '最小起订量', notes: '' }],
      result: { status: 'partial', warnings: ['w'], quality_issues: [], round_summary: [] },
    })
    expect(writeWorkbenchDraft('test-scope', value)).toBe(true)
    const restored = readWorkbenchDraft('test-scope')
    expect(restored?.mode).toBe('email')
    expect(restored?.incoming_mail).toBe('Please quote A100.')
    expect(restored?.reply_points).toBe('MOQ 不可降')
    expect(restored?.source_text).toBe('Dear customer, MOQ 500 pcs.')
    expect(restored?.result_text).toBe('MOQ 500 件。')
    expect(restored?.glossary).toEqual([
      { id: 3, source: 'MOQ', target: '最小起订量', notes: '' },
    ])
    expect(restored?.result?.status).toBe('partial')
  })

  it('treats blank content as empty and clears storage on clear', () => {
    expect(isWorkbenchDraftEmpty(emptyWorkbenchDraft())).toBe(true)
    writeWorkbenchDraft('test-scope', draft())
    expect(readWorkbenchDraft('test-scope')).not.toBeNull()
    clearWorkbenchDraft('test-scope')
    expect(readWorkbenchDraft('test-scope')).toBeNull()
  })

  it('keeps result text even when it exists alone (post-edit survives)', () => {
    writeWorkbenchDraft('test-scope', draft({ source_text: '' }))
    const restored = readWorkbenchDraft('test-scope')
    expect(restored?.result_text).toBe('MOQ 500 件。')
    expect(isWorkbenchDraftEmpty(restored!)).toBe(false)
  })

  it('rejects corrupted JSON and unknown versions instead of throwing', () => {
    globalThis.localStorage?.setItem(
      `linguaflow.workbenchDraft.v1:${encodeURIComponent('test-scope')}`,
      '{not-json',
    )
    expect(readWorkbenchDraft('test-scope')).toBeNull()
    globalThis.localStorage?.setItem(
      `linguaflow.workbenchDraft.v1:${encodeURIComponent('test-scope')}`,
      JSON.stringify({ ...draft(), version: 99 }),
    )
    expect(readWorkbenchDraft('test-scope')).toBeNull()
  })

  it('sanitizes unexpected field types and caps oversized text', () => {
    const value = sanitizeWorkbenchDraft({
      ...draft(),
      mode: 'nope',
      source_lang: 42,
      incoming_collapsed: 'yes',
      source_text: 'x'.repeat(250_000),
      glossary: [{ id: 'bad', source: 1, target: 'ok' }],
    })
    expect(value?.mode).toBe('translate')
    expect(value?.source_lang).toBe('auto')
    expect(value?.incoming_collapsed).toBe(false)
    expect(value?.source_text.length).toBe(200_000)
    expect(value?.glossary[0]?.target).toBe('ok')
  })

  it('ignores drafts written by the same page instance when asked', () => {
    writeWorkbenchDraft('test-scope', draft({ tab_id: 'tab-a' }))
    expect(readWorkbenchDraft('test-scope', { ignoreTabId: 'tab-a' })).toBeNull()
    expect(readWorkbenchDraft('test-scope', { ignoreTabId: 'tab-b' })).not.toBeNull()
  })

  it('stores nothing without a session scope', () => {
    const value = draft()
    expect(writeWorkbenchDraft(null, value)).toBe(false)
    expect(readWorkbenchDraft(null)).toBeNull()
  })

  it('drops drafts from another schema version', () => {
    expect(sanitizeWorkbenchDraft({ version: WORKBENCH_DRAFT_VERSION - 1 })).toBeNull()
  })
})

describe('shouldDeferToOtherTab', () => {
  const at = (iso: string, tab: string) => ({ ...emptyWorkbenchDraft(tab), updated_at: iso })

  it('gives way only to a newer draft written by another tab', () => {
    const stored = at('2026-11-11T10:00:00.000Z', 'tab-b')
    expect(shouldDeferToOtherTab(stored, 'tab-a', Date.parse('2026-11-11T09:59:00.000Z'))).toBe(true)
    expect(shouldDeferToOtherTab(stored, 'tab-a', Date.parse('2026-11-11T10:00:00.000Z'))).toBe(
      false,
    )
  })

  it('never treats its own writes or a missing draft as a conflict', () => {
    const mine = at('2026-11-11T10:00:00.000Z', 'tab-a')
    expect(shouldDeferToOtherTab(mine, 'tab-a', 0)).toBe(false)
    expect(shouldDeferToOtherTab(null, 'tab-a', 0)).toBe(false)
  })

  it('a reloaded page adopts the stored draft instead of reporting a conflict', () => {
    writeWorkbenchDraft('test-scope', { ...emptyWorkbenchDraft('previous-instance'), source_text: 'draft' })
    const stored = readWorkbenchDraft('test-scope')
    expect(stored).not.toBeNull()
    // 恢复时把 seenAt 对齐到 stored.updated_at，因此新实例不会把旧草稿误判为其他标签页。
    expect(shouldDeferToOtherTab(stored, 'reloaded-instance', Date.parse(stored!.updated_at))).toBe(
      false,
    )
  })

  it('ignores drafts with an unparsable timestamp', () => {
    const broken = at('not-a-date', 'tab-b')
    expect(shouldDeferToOtherTab(broken, 'tab-a', 0)).toBe(false)
  })
})
