/**
 * `domain/glossary` 的类型契约（对应 Go `backend/internal/glossary/glossary.go`）。
 *
 * 命名映射：Go `Entry` → `GlossaryEntry`（避免与通用 `Entry` 撞名），字段沿用
 * 驼峰。该结构不落库、不进 `seg.Meta`，唯一持久化形态是 CSV，故无需 snake_case
 * 的持久化例外。
 */
import type { Result } from '../shared/result'

/** 一条术语映射（Go `glossary.Entry`）。 */
export interface GlossaryEntry {
  /** 术语原文。 */
  source: string
  /** 术语译文；禁译条目里表示「应避免的译法」。 */
  target: string
  /** true 时大小写敏感匹配。 */
  caseSensitive: boolean
  /** true 表示禁译条目（Hits 仍返回，调用方据此规避）。 */
  forbidden: boolean
  /** true 表示必须使用该译法。 */
  mandatory: boolean
  /** 备注（不参与匹配）。 */
  notes: string
}

/** Add 时条目未被写入的原因（Go `SkipReason`）。 */
export type SkipReason = 'exists' | 'empty'

/** 一条被丢弃的候选（Go `SkippedEntry`）。 */
export interface SkippedEntry {
  /** 调用方提交的版本（已 trim）。 */
  proposed: GlossaryEntry
  /** 表中已有版本；仅 `reason === 'exists'` 时有意义。 */
  existing: GlossaryEntry
  /** 丢弃原因。 */
  reason: SkipReason
}

/**
 * 一次 Add 的处理详情（Go `AddResult`）。
 *
 * 关键约定：`proposed.target === existing.target` 时视作 noop，既不进 `added`
 * 也不进 `skipped`，避免误触发调用方的冲突修正。
 */
export interface AddResult {
  /** 真正写入表的条目。 */
  added: GlossaryEntry[]
  /** 因冲突或非法被丢弃的条目。 */
  skipped: SkippedEntry[]
}

/** 术语表能力（Go `glossary.Glossary` 接口）。 */
export interface Glossary {
  /**
   * 在 `text` 中查找命中的术语。
   *
   * 返回顺序 = 内部顺序（`source` 的 **UTF-8 字节长度**降序），即长词优先。
   * `srcLang` / `tgtLang` 目前不参与匹配（MVP 单语言对一表），保留参数位。
   */
  lookup(text: string, srcLang: string, tgtLang: string): GlossaryEntry[]
  /** 增量合并；严格合并语义见 `FileGlossary.add`。 */
  add(...entries: GlossaryEntry[]): AddResult
}

/** 一次原子写的计划：目标路径 + 完整内容。落盘时机与原子性由 sink 负责。 */
export interface SavePlan {
  /** 目标路径（浏览器侧可以是虚拟路径或文件名）。 */
  path: string
  /** 完整 CSV 内容（含表头与尾随换行）。 */
  content: string
}

/**
 * 原子写 sink（可注入）。
 *
 * 领域层只生成内容与顺序，**不接触任何 IO API**。浏览器侧实现负责把
 * `content` 写到 `path`：可用 OPFS 的临时文件 + rename，或 IndexedDB 单事务。
 * 采用同步签名是为了让领域层保持纯同步；需要异步落盘的适配器可在 sink 内
 * 自行排队，或直接调用 `prepareSave()` 取内容后异步提交。
 */
export type GlossarySink = (plan: SavePlan) => void

/** 可持久化的 Glossary（Go `glossary.Saver`）。 */
export interface GlossarySaver {
  /** 生成待写入内容（纯函数，零 IO）。 */
  prepareSave(): Result<SavePlan>
  /** 生成内容并交给 sink；成功后清除 dirty。 */
  save(sink: GlossarySink): Result<SavePlan>
}

/** 构造一条零值术语；`init` 覆盖指定字段（对齐 Go 结构体零值语义）。 */
export function glossaryEntry(init: Partial<GlossaryEntry> = {}): GlossaryEntry {
  return {
    source: '',
    target: '',
    caseSensitive: false,
    forbidden: false,
    mandatory: false,
    notes: '',
    ...init,
  }
}

/**
 * Go `glossary.Nop` 的等价物：永不命中，Add 为 no-op。
 *
 * Go 侧是空结构体类型；TS 用一个不可变对象表达即可（无状态）。
 */
export const nopGlossary: Glossary = {
  lookup: () => [],
  add: () => ({ added: [], skipped: [] }),
}

/**
 * 为请求做幂等合并（Go `request.go` 的 `AddForRequest`）。
 *
 * `requestID` 非空且目标实现了 `requestAdder` 时委派给它（落库实现可据此
 * 回放历史冲突决策）；否则退化为普通 `add`。
 */
export function addForRequest(
  target: Glossary | null,
  requestID: string,
  ...entries: GlossaryEntry[]
): AddResult {
  if (target === null) return { added: [], skipped: [] }
  if (requestID !== '') {
    const aware = target as Glossary & Partial<RequestAdder>
    if (typeof aware.addForRequest === 'function') {
      return aware.addForRequest(requestID, ...entries)
    }
  }
  return target.add(...entries)
}

/** 幂等请求合并能力（Go `glossary.RequestAdder`）。 */
export interface RequestAdder {
  addForRequest(requestID: string, ...entries: GlossaryEntry[]): AddResult
}
