/**
 * `domain/repair` 的公共类型（对应 Go `backend/internal/repair/` 的结构体）。
 *
 * 命名映射遵循 `domain/README.md` §2：Go 导出字段 → camelCase；只有随
 * `seg.Meta` 落库的持久化字段才保留 snake_case（本包不涉及）。
 */

/** bootstrap 术语条目（Go `prompt.BootstrapEntry`）。 */
export interface BootstrapEntry {
  source: string
  target: string
  notes: string
}

/** 语义质检问题（Go `prompt.SemanticQAIssue`）。 */
export interface SemanticQAIssue {
  id: string
  code: string
  message: string
  snippet: string
}

/** 裁决结果（Go `prompt.AdjudicationVerdict`）。 */
export interface AdjudicationVerdict {
  id: string
  /** 持久化契约字段：沿用 Go 的 `issue_code`。 */
  issue_code: string
  /** 持久化契约字段：沿用 Go 的 `matched_text`。 */
  matched_text: string
  verdict: string
  reason: string
}

/** 修订结果（Go `prompt.ReviseRevision`）。 */
export interface ReviseRevision {
  id: string
  target: string
}

/**
 * 注音对齐输出条目（Go `ruby.OutputEntry`）。
 *
 * `invalid` 对应 Go 的 `Invalid bool json:"-"`：保留畸形行的可识别 ID，
 * 使重复 ID 校验不会因同行字段解码失败而被绕过。
 */
export interface RubyOutputEntry {
  id: string
  base: string
  text: string
  kind: string
  occurrence: number
  invalid: boolean
}

/** segment ID → 注音输出条目。 */
export type RubyOutputMap = Record<string, RubyOutputEntry[]>

/**
 * 修复算子开关（Go `repair.Options`）。
 *
 * 零值（全部 false）等于「不修复」——只做基础 JSON 抽取，与原
 * `jsonObjectSlice` 路径一致。
 */
export interface RepairOptions {
  /** L1：BOM 剥离、尾随逗号、控制字符、括号补齐、多对象合并。 */
  jsonStructural: boolean
  /** L2：字段名同义化（translation→translations 等）。 */
  schemaAliases: boolean
  /** L3：占位符大小写/下划线变体归一。 */
  placeholderNormalize: boolean
  /** L4：解析失败或占位符仍缺失时附加反例 reminder 重试一次。 */
  promptUpgrade: boolean
  /**
   * 裸数组兜底（json.bare-array）的领域判别器；未设置表示仅靠通用形状门控
   * 与 normalize 空结果拒绝。
   */
  bareArrayAccept?: ((entries: unknown[]) => boolean) | null
  /** 调用方显式弃用截断抢救（Go 未导出字段 `salvageDeclined`）。 */
  salvageDeclined?: boolean
  /** 当前调用处于截断抢救递归层内（Go 未导出字段 `inSalvage`）。 */
  inSalvage?: boolean
}

/** 默认（零值）修复选项。 */
export function defaultRepairOptions(): RepairOptions {
  return {
    jsonStructural: false,
    schemaAliases: false,
    placeholderNormalize: false,
    promptUpgrade: false,
    bareArrayAccept: null,
    salvageDeclined: false,
    inSalvage: false,
  }
}

/** 返回禁用截断抢救的 Options 副本（Go `Options.WithoutSalvage`）。 */
export function withoutSalvage(options: RepairOptions): RepairOptions {
  return { ...options, salvageDeclined: true }
}

/**
 * 返回截断抢救递归重跑修复链所携带的 Options 副本（Go `Options.enterSalvage`）。
 *
 * 置位 `inSalvage`，递归层不再进入抢救分支（深度恒为 1）。刻意不动
 * `salvageDeclined`——递归层的 close-braces 兜底必须可用。
 */
export function enterSalvage(options: RepairOptions): RepairOptions {
  return { ...options, inSalvage: true }
}

/**
 * `TryRepair` 的统一返回（Go `repair.Result`）。
 *
 * - `fatal=true`：解析完全无救；调用方应走 shrinkOrFallback。
 * - `fatal=false` 且 `missing` 空：全成功。
 * - `fatal=false` 且 `missing` 非空：partial（含截断抢救保住的前缀）。
 */
export interface RepairResult {
  /** ID → 译文；无结果时为空对象（Go nil map 归一）。 */
  trans: Record<string, string>
  /** 术语条目；无结果时为空数组（Go nil slice 归一）。 */
  glos: BootstrapEntry[]
  /**
   * segment ID → 注音输出条目。
   *
   * `null` 表示协议未携带 ruby_output（Go nil map）；黄金向量按 README §3.2
   * 将 nil map 归一为空对象对拍。
   */
  rubyOutput: RubyOutputMap | null
  /** wantIDs 中未出现在 trans 里的子集。 */
  missing: string[]
  /** 修复算子链，便于日志诊断。 */
  repaired: string[]
  fatal: boolean
  /** 失败原因（人类可读）；成功时为 `null`。 */
  parseErr: string | null
}

/** 空 RepairResult（零值）。 */
export function emptyRepairResult(): RepairResult {
  return {
    trans: {},
    glos: [],
    rubyOutput: null,
    missing: [],
    repaired: [],
    fatal: false,
    parseErr: null,
  }
}

/** `TryRepairBootstrap` 的返回（Go `([]BootstrapEntry, []string, error)`）。 */
export interface BootstrapRepairResult {
  entries: BootstrapEntry[]
  repaired: string[]
  /** 错误码/消息；成功时为 `null`。 */
  error: string | null
}

/** `TryRepairEnvelope` 的返回（Go `(map[string]any, []string, error)`）。 */
export interface EnvelopeRepairResult {
  raw: Record<string, unknown> | null
  repaired: string[]
  error: string | null
}

/** `tryRepairKeyed` 类入口的通用返回。 */
export interface KeyedRepairResult<T> {
  entries: T[]
  repaired: string[]
  error: string | null
}
