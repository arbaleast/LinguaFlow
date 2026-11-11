/**
 * `domain/qa` 的公共类型契约（对应 Go `backend/internal/qa/qa.go`）。
 *
 * 命名约定：
 * - **内存态**（checker 构造、引擎编排）用驼峰字段；
 * - **持久化 / 前后端互通**（`QualityIssue` / `Span`）由 `issue.ts` 的 wire 层转成
 *   Go 的 snake_case JSON 字段（见该文件），字段名逐字对齐 Go 的 json tag。
 *
 * Go 侧 `QualityIssue` 实现了自定义 `MarshalJSON` / `UnmarshalJSON`：
 * 裁决时刻归一化为 UTC、零值 `disposition` 归一化为 `pending`、非法裁决值报错。
 * 这些语义全部在 `issue.ts` 里逐条复刻。
 */

/** issue 严重程度：warning / error（Go `IssueSeverity`）。 */
export type IssueSeverity = string

/** warning 级。 */
export const SEVERITY_WARNING = 'warning'
/** error 级。 */
export const SEVERITY_ERROR = 'error'

/**
 * 裁决状态（Go `IssueDisposition`）。只回答「这条算不算问题」：
 * - pending：未决，仍是待解决的问题；
 * - dismissed：已判定不是问题，无需再解决。
 */
export type IssueDisposition = string

/** 未决。 */
export const DISPOSITION_PENDING = 'pending'
/** 已判定不是问题。 */
export const DISPOSITION_DISMISSED = 'dismissed'

/** 长度计算方式（Go `LengthMethod`）。 */
export type LengthMethod = string

/** 加权字符计数：CJK 字符×2，拉丁字符×1。 */
export const LENGTH_METHOD_CHAR_WEIGHT = 'char_weight'
/** 语义单元计数：CJK 每字 1 词，拉丁每词 1 词。 */
export const LENGTH_METHOD_WORD_COUNT = 'word_count'

/**
 * 质量问题在目标文本中的跨度（Go `Span`）。
 *
 * `matchedText` 为触发问题的精确文本；`targetStart` / `targetEnd` 为可选的
 * **rune（码点）偏移**（Go 侧由 UTF-8 字节偏移换算而来，见 `span.ts`）。
 */
export interface Span {
  matchedText: string
  targetStart?: number | null
  targetEnd?: number | null
}

/**
 * 质量问题（Go `QualityIssue`，内存态）。
 *
 * `decidedAt` 用 RFC3339Nano 字符串表示 `*time.Time`（领域层禁止 `Date.now()`；
 * 时刻只作为外部传入的数据被归一化，不在这里生成）。
 */
export interface QualityIssue {
  segmentIndex: number
  severity: IssueSeverity
  code: string
  message: string
  span?: Span | null
  disposition: IssueDisposition
  /** nil 表示由 LLM 裁决（adjudicate 轮），非 nil 表示用户裁决（user_id）。 */
  decidedBy?: number | null
  decidedAt?: string | null
  note?: string
}

/** 单个段落的检测输入（Go `CheckInput`）。 */
export interface CheckInput {
  index: number
  sourceText: string
  targetText: string
  meta?: Record<string, unknown> | null
  /** 占位符 → 保护区原文；供标点/空白类 checker 屏蔽。 */
  protected?: Record<string, string> | null
}

/** 单项质量检测规则（Go `Checker`）。 */
export interface Checker {
  /** 规则名（与 issue code 对齐）。 */
  name(): string
  /** 对一批段落运行检测。 */
  check(segments: readonly CheckInput[]): QualityIssue[]
}

/** 术语表条目（Go `glossary.Entry`；不落库，故用驼峰）。 */
export interface GlossaryEntry {
  source: string
  target: string
  caseSensitive: boolean
  forbidden: boolean
  mandatory: boolean
  notes: string
}

/**
 * 术语表接口（Go `glossary.Glossary` 的 Lookup 半边）。
 *
 * 本移植只保留 checker 真正使用的能力；`Add` 由 `MemoryGlossary` 以类方法提供，
 * 不进入接口，避免把写路径带进只读检测。
 */
export interface Glossary {
  /** 在 `text` 中查找命中的术语（顺序决定 issue 顺序）。 */
  lookup(text: string, srcLang: string, tgtLang: string): GlossaryEntry[]
}

/** 控制 QA 引擎行为的配置（Go `Config`）。 */
export interface Config {
  enabled: boolean
  autoReject: boolean
  lengthMethod: LengthMethod
  lengthRatioMin: number
  lengthRatioMax: number
  sourceLang: string
  targetLang: string
  /** `null` 时启用全部 per-batch checker；非 null 时按 `Checker.name()` 精确过滤。 */
  checks: string[] | null
  /** 资源格式（如 srt/ass/vtt/txt），供字幕行数等格式相关检测使用。 */
  format: string
  /** `null` 时术语类 checker 跳过。 */
  glossary: Glossary | null
}
