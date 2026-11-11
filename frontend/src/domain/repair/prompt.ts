/**
 * 反例式重试提醒（对应 Go `backend/internal/repair/prompt.go`）。
 *
 * Go 侧用 `text/template` 渲染；本移植实现该模板在本领域用到的**最小语法子集**：
 *
 * - `{{.Field}}` 字段插值；
 * - `{{if .Field}}...{{end}}`（可嵌套，无 else）；
 * - `{{printf "%q" .Field}}`；
 * - `Option("missingkey=error")`：访问未知字段报错。
 *
 * 未知动作/未闭合动作一律报错，保持「模板非法即失败」的契约。
 */
import { decodeUtf8Lossy, joinStrings } from './strings'
import { utf8Encode } from '../shared/unicode'
import { goQuote, goQuoteBytes } from './json_parse'

/**
 * 默认重试提醒模板（Go `DefaultRetryReminderTemplate`，逐字符一致）。
 *
 * 冻结进每次执行解析结果，运行期只做数据插值。
 */
export const DEFAULT_RETRY_REMINDER_TEMPLATE = `

IMPORTANT: your previous response could not be processed.{{if .Reason}} Reason: {{.Reason}}.{{end}}{{if .MissingIDs}} Missing IDs: {{.MissingIDs}}.{{end}}{{if .PreviousHead}} The previous response started with: {{printf "%q" .PreviousHead}}.{{end}} Reply with EXACTLY the JSON envelope schema described above: {"translations":{"<id>":"<text>",...}}. Do not include markdown fences, prose, or any other fields.`

/** 模板可用字段（Go 匿名 struct 的三个 string 字段）。 */
interface RetryReminderData {
  Reason: string
  MissingIDs: string
  PreviousHead: string
  /** PreviousHead 的原始 UTF-8 字节（可能被 200 字节边界切断）。 */
  previousHeadBytes: Uint8Array
}

const TEMPLATE_FIELDS = new Set(['Reason', 'MissingIDs', 'PreviousHead'])

/** 模板语法错误。 */
class TemplateError extends Error {}

/** 把一个 `{{...}}` 内的表达式解析为字段名（只接受 `.Field`）。 */
function parseFieldExpr(expr: string): string {
  if (!expr.startsWith('.')) throw new TemplateError('unsupported template expression')
  const name = expr.slice(1)
  if (!TEMPLATE_FIELDS.has(name)) throw new TemplateError('unknown template field')
  return name
}

/** 模板渲染结果。 */
interface RenderState {
  template: string
  pos: number
  data: RetryReminderData
}

/**
 * 渲染一个块；`stopAtEnd` 为真时在遇到 `{{end}}` 后返回。
 *
 * 返回 `{out, ended}`：`ended` 表示是否消费了 `{{end}}`。
 */
function renderBlock(state: RenderState, stopAtEnd: boolean): { out: string; ended: boolean } {
  let out = ''
  while (state.pos < state.template.length) {
    const open = state.template.indexOf('{{', state.pos)
    if (open < 0) {
      out += state.template.slice(state.pos)
      state.pos = state.template.length
      return { out, ended: false }
    }
    out += state.template.slice(state.pos, open)
    const close = state.template.indexOf('}}', open + 2)
    if (close < 0) throw new TemplateError('unclosed action')
    const rawExpr = state.template.slice(open + 2, close).trim()
    state.pos = close + 2

    if (rawExpr === 'end') {
      if (!stopAtEnd) throw new TemplateError('unexpected end')
      return { out, ended: true }
    }
    if (rawExpr.startsWith('if ')) {
      const field = parseFieldExpr(rawExpr.slice(3).trim())
      const inner = renderBlock(state, true)
      if (!inner.ended) throw new TemplateError('unclosed if')
      if (state.data[field as keyof RetryReminderData] !== '') {
        out += inner.out
      }
      continue
    }
    if (rawExpr.startsWith('printf ')) {
      const format = rawExpr.slice('printf '.length).trim()
      const quoted = /^"((?:[^"\\]|\\.)*)"\s+(\.\S+)$/.exec(format)
      if (!quoted) throw new TemplateError('unsupported printf action')
      const formatString = (quoted[1] as string).replace(/\\(.)/g, '$1')
      if (formatString !== '%q') throw new TemplateError('unsupported printf format')
      const field = parseFieldExpr(quoted[2] as string)
      out +=
        field === 'PreviousHead'
          ? goQuoteBytes(state.data.previousHeadBytes)
          : goQuote(state.data[field as keyof RetryReminderData] as string)
      continue
    }
    const field = parseFieldExpr(rawExpr)
    out += state.data[field as keyof RetryReminderData]
  }
  if (stopAtEnd) throw new TemplateError('missing end')
  return { out, ended: false }
}

/**
 * 用冻结模板渲染重试提醒（Go `RenderRetryReminder`）。
 *
 * `previousHead` 按 **UTF-8 字节**截断到 200 字节（Go 的 `s[:200]`），
 * 截断点可能切开多字节 rune——非法序列按 U+FFFD 归一（与 Go 字符串经
 * `encoding/json` 序列化后的可观察结果一致）。
 */
export function renderRetryReminder(
  content: string,
  missingIDs: readonly string[],
  parseErr: string | null,
  previousHead: string,
): { text: string; error: string | null } {
  if (content === '') {
    return { text: '', error: 'missing frozen retry reminder template' }
  }
  let head = previousHead
  let headBytes = utf8Encode(previousHead)
  if (headBytes.length > 200) {
    headBytes = headBytes.slice(0, 200)
    head = decodeUtf8Lossy(headBytes)
    head = `${head}…`
    // Go 的 `s[:200] + "…"`：省略号也是字符串的一部分，故 `%q` 输出必须包含它。
    const ellipsis = utf8Encode('…')
    const merged = new Uint8Array(headBytes.length + ellipsis.length)
    merged.set(headBytes, 0)
    merged.set(ellipsis, headBytes.length)
    headBytes = merged
  }
  const data: RetryReminderData = {
    Reason: parseErr ?? '',
    MissingIDs: joinStrings(missingIDs, ', '),
    PreviousHead: head,
    previousHeadBytes: headBytes,
  }
  try {
    const state: RenderState = { template: content, pos: 0, data }
    const result = renderBlock(state, false)
    if (state.pos < state.template.length) throw new TemplateError('trailing template data')
    return { text: result.out, error: null }
  } catch (error) {
    if (error instanceof TemplateError) {
      return { text: '', error: 'invalid frozen retry reminder template' }
    }
    return { text: '', error: 'render frozen retry reminder template failed' }
  }
}

/**
 * 生成反例式 reminder（Go `BuildRetryReminder`）。
 * 渲染失败时返回空串（Go 忽略 error）。
 */
export function buildRetryReminder(
  missingIDs: readonly string[],
  parseErr: string | null,
  previousHead: string,
): string {
  return renderRetryReminder(DEFAULT_RETRY_REMINDER_TEMPLATE, missingIDs, parseErr, previousHead)
    .text
}
