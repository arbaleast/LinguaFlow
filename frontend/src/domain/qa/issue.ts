/**
 * `QualityIssue` / `Span` 的 JSON 持久化契约（对应 Go `qa.go` 的自定义序列化）。
 *
 * **为什么单独一层**：这两个类型会随 `quality_issues` 落库并与 Go 后端互通，
 * 因此 JSON 字段名必须逐字对齐 Go 的 json tag（snake_case）。内存态用驼峰、
 * wire 态用蛇形，两者由本模块互转，任何字段名漂移都会在黄金向量里暴露。
 *
 * Go 侧的自定义方法与本模块的对应关系：
 *
 * | Go | TS |
 * |---|---|
 * | `IssueDisposition.MarshalJSON`（""→"pending"） | {@link qualityIssueToWire} |
 * | `QualityIssue.MarshalJSON`（`DecidedAt` 归一化 UTC） | {@link qualityIssueToWire} |
 * | `IssueDisposition.UnmarshalJSON`（null/""→pending，非法值报错） | {@link qualityIssueFromWire} |
 * | `QualityIssue.UnmarshalJSON`（缺失 disposition 兜底 pending） | {@link qualityIssueFromWire} |
 * | `timeutil.NormalizePtr` + RFC3339Nano 编码 | {@link normalizeDecisionTime} |
 *
 * 时间用 **RFC3339Nano 字符串**表示 `*time.Time`：领域层不得调用 `Date.now()`，
 * 时刻只作为外部数据被归一化（不是生成）。`normalizeDecisionTime` 保留纳秒精度：
 * JS `Date` 只有毫秒精度，故秒以下的高位数字直接从原文搬移，不经 `Date` 往返。
 */
import { compile, findStringSubmatch } from '../shared/re2'
import {
  DISPOSITION_PENDING,
  type IssueDisposition,
  type IssueSeverity,
  type QualityIssue,
  type Span,
} from './types'

/** 落库的跨度形态（字段名与 Go json tag 逐字一致）。 */
export interface SpanWire {
  matched_text: string
  target_start?: number
  target_end?: number
}

/** 落库的质量问题形态（字段名与 Go json tag 逐字一致）。 */
export interface QualityIssueWire {
  segment_index: number
  severity: IssueSeverity
  code: string
  message: string
  span?: SpanWire
  disposition: IssueDisposition
  decided_by?: number
  decided_at?: string
  note?: string
}

/**
 * RFC3339 / RFC3339Nano 的解析形态。
 *
 * Go 的 `time.Time.UnmarshalJSON` 走 `time.Parse(time.RFC3339, ...)`：秒后可带
 * 小数（`.` 或 `,`），时区为 `Z` 或 `±HH:MM`。
 */
const DECISION_TIME_RE = compile(
  '^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:[.,](\\d+))?(?:Z|([+-])(\\d{2}):(\\d{2}))$',
)

/** 两位补零。 */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 四位补零（年份）。 */
function pad4(n: number): string {
  let s = String(n)
  while (s.length < 4) s = `0${s}`
  return s
}

/**
 * 把 RFC3339 时刻归一化为 UTC 的 RFC3339Nano 字符串（Go `timeutil.Normalize` +
 * `time.RFC3339Nano` 编码）。
 *
 * `null` / `undefined` / 空串返回 `null`（对应 Go 的 nil 指针，`omitempty` 时字段不出现）。
 * 无法解析的输入抛错（对应 Go `UnmarshalJSON` 返回 error）。
 *
 * 小数位处理与 Go 一致：保留最多 9 位纳秒、去掉尾部多余的 0、全 0 则不输出小数点。
 */
export function normalizeDecisionTime(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const m = findStringSubmatch(DECISION_TIME_RE, value)
  if (m === null) {
    throw new Error(`invalid decided_at ${JSON.stringify(value)}: 需要 RFC3339 时刻`)
  }
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const hour = Number(m[4])
  const minute = Number(m[5])
  const second = Number(m[6])
  const frac = m[7] ?? ''
  const sign = m[8] ?? ''
  const offHour = Number(m[9] ?? '0')
  const offMinute = Number(m[10] ?? '0')

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    throw new Error(`invalid decided_at ${JSON.stringify(value)}: 字段越界`)
  }
  if (frac.length > 9) {
    throw new Error(`invalid decided_at ${JSON.stringify(value)}: 小数秒超过 9 位`)
  }

  const baseMs = Date.UTC(year, month - 1, day, hour, minute, second)
  if (Number.isNaN(baseMs)) {
    throw new Error(`invalid decided_at ${JSON.stringify(value)}: 无法解析日期`)
  }
  const check = new Date(baseMs)
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new Error(`invalid decided_at ${JSON.stringify(value)}: 日期不存在`)
  }

  const offsetMinutes = sign === '' ? 0 : (sign === '-' ? -1 : 1) * (offHour * 60 + offMinute)
  const utc = new Date(baseMs - offsetMinutes * 60_000)

  const fraction = frac.replace(/0+$/, '')
  const ymd = `${pad4(utc.getUTCFullYear())}-${pad2(utc.getUTCMonth() + 1)}-${pad2(utc.getUTCDate())}`
  const hms = `${pad2(utc.getUTCHours())}:${pad2(utc.getUTCMinutes())}:${pad2(utc.getUTCSeconds())}`
  return fraction === '' ? `${ymd}T${hms}Z` : `${ymd}T${hms}.${fraction}Z`
}

/** 把 Span 转为落库形态（`target_start` / `target_end` 为 nil 时省略）。 */
export function spanToWire(span: Span): SpanWire {
  const wire: SpanWire = { matched_text: span.matchedText }
  if (span.targetStart !== null && span.targetStart !== undefined) {
    wire.target_start = span.targetStart
  }
  if (span.targetEnd !== null && span.targetEnd !== undefined) {
    wire.target_end = span.targetEnd
  }
  return wire
}

/** 从落库形态还原 Span。 */
export function spanFromWire(wire: SpanWire): Span {
  return {
    matchedText: wire.matched_text,
    targetStart: wire.target_start ?? null,
    targetEnd: wire.target_end ?? null,
  }
}

/**
 * `QualityIssue` → 落库 JSON（Go `QualityIssue.MarshalJSON`）。
 *
 * 逐条对齐：
 * - `disposition` 永远输出显式枚举值（内存零值 `''` 归一化为 `pending`）；
 * - `decided_at` 归一化为 UTC 的 RFC3339Nano；
 * - `span` / `decided_by` / `decided_at` / `note` 的零值按 Go `omitempty` 省略
 *   （注意 `decided_by`、`target_start` 等是**指针**：值为 0 仍然输出）。
 */
export function qualityIssueToWire(issue: QualityIssue): QualityIssueWire {
  const wire: QualityIssueWire = {
    segment_index: issue.segmentIndex,
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
    disposition: issue.disposition === '' ? DISPOSITION_PENDING : issue.disposition,
  }
  if (issue.span !== null && issue.span !== undefined) {
    wire.span = spanToWire(issue.span)
  }
  if (issue.decidedBy !== null && issue.decidedBy !== undefined) {
    wire.decided_by = issue.decidedBy
  }
  const decidedAt = normalizeDecisionTime(issue.decidedAt)
  if (decidedAt !== null) {
    wire.decided_at = decidedAt
  }
  if (issue.note !== undefined && issue.note !== '') {
    wire.note = issue.note
  }
  return wire
}

/** 判断 JSON 值是否为普通对象。 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 读取整数（缺失返回 `null`；类型不符抛错，对应 Go 的 json 类型错误）。 */
function readInt(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key]
  if (v === undefined || v === null) return null
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new Error(`invalid ${key}: 需要整数`)
  }
  return v
}

/** 读取字符串（缺失返回 `''`；类型不符抛错）。 */
function readString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key]
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string') {
    throw new Error(`invalid ${key}: 需要字符串`)
  }
  return v
}

/**
 * 落库 JSON → `QualityIssue`（Go `QualityIssue.UnmarshalJSON`）。
 *
 * 兼容旧数据：`disposition` 缺失 / `null` / 空串一律归一化为 `pending`；
 * `decided_at` 归一化为 UTC；`null` 时间戳保持 `null`。
 * 非法 `disposition` 抛错（Go 返回 error，避免静默落入未定义状态）。
 */
export function qualityIssueFromWire(raw: unknown): QualityIssue {
  if (!isRecord(raw)) {
    throw new Error('invalid quality issue: 需要 JSON 对象')
  }
  let disposition = readString(raw, 'disposition')
  if (disposition === '') {
    disposition = DISPOSITION_PENDING
  } else if (disposition !== DISPOSITION_PENDING && disposition !== 'dismissed') {
    throw new Error(`invalid disposition ${JSON.stringify(disposition)}: want pending|dismissed`)
  }

  let span: Span | null = null
  const rawSpan = raw.span
  if (rawSpan !== undefined && rawSpan !== null) {
    if (!isRecord(rawSpan)) {
      throw new Error('invalid span: 需要 JSON 对象')
    }
    span = {
      matchedText: readString(rawSpan, 'matched_text'),
      targetStart: readInt(rawSpan, 'target_start'),
      targetEnd: readInt(rawSpan, 'target_end'),
    }
  }

  const decidedAtRaw = raw.decided_at
  if (decidedAtRaw !== undefined && decidedAtRaw !== null && typeof decidedAtRaw !== 'string') {
    throw new Error('invalid decided_at: 需要字符串或 null')
  }
  const decidedAt = normalizeDecisionTime(typeof decidedAtRaw === 'string' ? decidedAtRaw : null)

  return {
    segmentIndex: readInt(raw, 'segment_index') ?? 0,
    severity: readString(raw, 'severity'),
    code: readString(raw, 'code'),
    message: readString(raw, 'message'),
    span,
    disposition,
    decidedBy: readInt(raw, 'decided_by'),
    decidedAt,
    note: readString(raw, 'note'),
  }
}
