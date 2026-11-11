/**
 * 工作台草稿的本地持久化（scoped localStorage + 内存兜底）。
 *
 * 设计要点：
 * - 与 `scoped-preferences` 使用同一会话作用域（`getSessionScope()`），按服务/用户隔离，
 *   切换会话后不会把上一会话的客户邮件草稿带出来；
 * - 只存用户输入与已生成的工作成果（原文 / 来信 / 要点 / 译文 / 结果元数据）+ 少量必要
 *   的界面上下文（模式、语种、内联术语），不存任何运行时对象（Promise、AbortController 等）；
 * - 数据不做云端上传，纯浏览器本地；
 * - 读取时做白名单校验与长度上限，损坏数据直接丢弃（返回 null）。
 */

export type WorkbenchDraftMode = 'translate' | 'email'

export interface WorkbenchDraftGlossaryRow {
  id: number
  source: string
  target: string
  notes: string
}

/** 结果区需要的元数据（用于恢复状态 Tag、质量告警与轮次详情）。 */
export interface WorkbenchDraftResult {
  status: string
  warnings: string[]
  quality_issues: unknown[]
  round_summary: unknown[]
}

export interface WorkbenchDraft {
  version: 1
  updated_at: string
  /** 写入该草稿的页面实例标识，用于多标签页冲突检测。 */
  tab_id: string
  mode: WorkbenchDraftMode
  scene: string | null
  source_lang: string
  target_lang: string
  source_text: string
  incoming_mail: string
  reply_points: string
  /** 结果区最终文本（含用户手工后编辑）。 */
  result_text: string
  result: WorkbenchDraftResult | null
  glossary: WorkbenchDraftGlossaryRow[]
  incoming_collapsed: boolean
  advanced_open: boolean
}

export const WORKBENCH_DRAFT_VERSION = 1

/** 单个文本字段上限：约 200k 字符，超出截断，避免撑爆 localStorage 配额。 */
export const WORKBENCH_DRAFT_MAX_TEXT = 200_000
/** 输入防抖窗口：足够短以保证离开页面前能落盘，又不至于每次按键都写存储。 */
export const WORKBENCH_DRAFT_DEBOUNCE_MS = 300
/** 内联术语行上限。 */
export const WORKBENCH_DRAFT_MAX_ROWS = 50

const memory = new Map<string, string>()
const keyFor = (scope: string) => `linguaflow.workbenchDraft.v1:${encodeURIComponent(scope)}`

export const emptyWorkbenchDraft = (tabId = ''): WorkbenchDraft => ({
  version: WORKBENCH_DRAFT_VERSION,
  updated_at: new Date().toISOString(),
  tab_id: tabId,
  mode: 'translate',
  scene: null,
  source_lang: 'auto',
  target_lang: 'zh-Hans',
  source_text: '',
  incoming_mail: '',
  reply_points: '',
  result_text: '',
  result: null,
  glossary: [],
  incoming_collapsed: false,
  advanced_open: false,
})

const text = (value: unknown): string =>
  typeof value === 'string' ? value.slice(0, WORKBENCH_DRAFT_MAX_TEXT) : ''

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback

const sanitizeResult = (value: unknown): WorkbenchDraftResult | null => {
  if (!value || typeof value !== 'object') return null
  const data = value as Record<string, unknown>
  if (typeof data.status !== 'string' || !data.status) return null
  const warnings = Array.isArray(data.warnings)
    ? data.warnings.filter((line): line is string => typeof line === 'string').slice(0, 50)
    : []
  return {
    status: data.status,
    warnings,
    quality_issues: Array.isArray(data.quality_issues) ? data.quality_issues.slice(0, 100) : [],
    round_summary: Array.isArray(data.round_summary) ? data.round_summary.slice(0, 50) : [],
  }
}

const sanitizeGlossary = (value: unknown): WorkbenchDraftGlossaryRow[] => {
  if (!Array.isArray(value)) return []
  return value
    .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
    .map((row, index) => ({
      id:
        typeof row.id === 'number' && Number.isSafeInteger(row.id) && row.id > 0
          ? row.id
          : index + 1,
      source: text(row.source).slice(0, 500),
      target: text(row.target).slice(0, 500),
      notes: text(row.notes).slice(0, 500),
    }))
    .filter((row) => row.source.length > 0 || row.target.length > 0 || row.notes.length > 0)
    .slice(0, WORKBENCH_DRAFT_MAX_ROWS)
}

/** 校验并归一化草稿；版本不符或结构损坏返回 null（调用方按「无草稿」处理）。 */
export const sanitizeWorkbenchDraft = (value: unknown): WorkbenchDraft | null => {
  if (!value || typeof value !== 'object') return null
  const data = value as Partial<WorkbenchDraft>
  if (data.version !== WORKBENCH_DRAFT_VERSION) return null
  const updatedAt =
    typeof data.updated_at === 'string' && Number.isFinite(Date.parse(data.updated_at))
      ? data.updated_at
      : new Date(0).toISOString()
  return {
    version: WORKBENCH_DRAFT_VERSION,
    updated_at: updatedAt,
    tab_id: typeof data.tab_id === 'string' ? data.tab_id.slice(0, 64) : '',
    mode: oneOf<WorkbenchDraftMode>(data.mode, ['translate', 'email'], 'translate'),
    scene: typeof data.scene === 'string' ? data.scene.slice(0, 40) : null,
    source_lang: text(data.source_lang).slice(0, 40) || 'auto',
    target_lang: text(data.target_lang).slice(0, 40) || 'zh-Hans',
    source_text: text(data.source_text),
    incoming_mail: text(data.incoming_mail),
    reply_points: text(data.reply_points),
    result_text: text(data.result_text),
    result: sanitizeResult(data.result),
    glossary: sanitizeGlossary(data.glossary),
    incoming_collapsed: data.incoming_collapsed === true,
    advanced_open: data.advanced_open === true,
  }
}

/** 草稿是否没有任何值得恢复的内容（用于清空判定与「最近使用」提示）。 */
export const isWorkbenchDraftEmpty = (draft: WorkbenchDraft): boolean =>
  draft.source_text.trim().length === 0 &&
  draft.incoming_mail.trim().length === 0 &&
  draft.reply_points.trim().length === 0 &&
  draft.result_text.trim().length === 0 &&
  draft.glossary.length === 0

export interface ReadWorkbenchDraftOptions {
  /** 忽略当天（同一页面实例）写下的草稿，避免本页自己的自动保存被当作冲突。 */
  ignoreTabId?: string
}

export const readWorkbenchDraft = (
  scope: string | null,
  options: ReadWorkbenchDraftOptions = {},
): WorkbenchDraft | null => {
  if (!scope) return null
  const key = keyFor(scope)
  let stored = memory.get(key)
  if (!stored) {
    try {
      stored = globalThis.localStorage?.getItem(key) ?? undefined
    } catch {
      /* 存储被禁用时退回内存 */
    }
  }
  if (!stored) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch {
    return null
  }
  const draft = sanitizeWorkbenchDraft(parsed)
  if (!draft) return null
  if (options.ignoreTabId && draft.tab_id === options.ignoreTabId) return null
  return draft
}

/** 写入草稿；返回是否成功（失败时仅保留内存副本，不打扰用户）。 */
export const writeWorkbenchDraft = (scope: string | null, draft: WorkbenchDraft): boolean => {
  if (!scope) return false
  const key = keyFor(scope)
  const serialized = JSON.stringify(sanitizeWorkbenchDraft(draft) ?? emptyWorkbenchDraft())
  memory.delete(key)
  memory.set(key, serialized)
  while (memory.size > 20) memory.delete(memory.keys().next().value ?? key)
  try {
    globalThis.localStorage?.setItem(key, serialized)
    return true
  } catch {
    return false
  }
}

/** 用户明确清空时调用：同时清掉内存与 localStorage 副本。 */
export const clearWorkbenchDraft = (scope: string | null): void => {
  if (!scope) return
  const key = keyFor(scope)
  memory.delete(key)
  try {
    globalThis.localStorage?.removeItem(key)
  } catch {
    /* 存储不可用时内存已清 */
  }
}

/**
 * 写入前判断是否要让位给其他标签页的草稿。
 *
 * 只有「对方标签页」且「时间比本页已知的更新」才算冲突；同一页面实例自身的
 * 上一次保存、以及刷新后从本地恢复的草稿（恢复时会把 seenAt 对齐到它）都不算。
 */
export const shouldDeferToOtherTab = (
  stored: WorkbenchDraft | null,
  tabId: string,
  seenAtMs: number,
): boolean => {
  if (!stored || !stored.tab_id || stored.tab_id === tabId) return false
  const updatedAt = Date.parse(stored.updated_at)
  return Number.isFinite(updatedAt) && updatedAt > seenAtMs
}
