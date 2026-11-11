/**
 * bootstrap 纯文本协议（对应 Go `backend/internal/repair/bootstrap_text.go`）。
 *
 * 输出协议：
 *
 * ```text
 * [glossary]
 * source | target | notes
 * ```
 *
 * 若无 `[glossary]` header，回退扫描全文中符合术语行格式的行。零条目也成功
 * 返回（空列表），与 JSON 路径 `{"glossary":[]}` 语义一致。
 */
import { stripCodeFence } from './deps/prompt_protocol'
import { stripBOMAndZeroWidth } from './json'
import { equalFoldAscii, hasPrefix, hasSuffix, splitString, trimSpaceGo } from './strings'
import { tryRepairBootstrap } from './repair'
import { parseGlossaryLine } from './text'
import { dedupeBootstrapEntries } from './deps/prompt_protocol'
import type { BootstrapEntry, RepairOptions } from './types'

/**
 * text 模式响应无可解析术语，且缺少显式 `[glossary]` 空协议。
 * 精简路径用此错误避免把乱输出当成「全删」。
 */
export const ERR_BOOTSTRAP_TEXT_EMPTY = 'empty bootstrap text without [glossary] header'

/** `tryRepairBootstrapText` 的返回。 */
export interface BootstrapTextResult {
  entries: BootstrapEntry[]
  repaired: string[]
  hasHeader: boolean
  error: string | null
}

/**
 * 解析 `[glossary]` 段或全文中的术语行，去重保留首次（Go
 * `parseBootstrapTextGlossary`）。
 */
export function parseBootstrapTextGlossary(text: string): {
  entries: BootstrapEntry[]
  hasHeader: boolean
} {
  const lines = splitString(text, '\n')
  let inGlossary = false
  let hasHeader = false
  const raw: BootstrapEntry[] = []

  for (const rawLine of lines) {
    const line = trimSpaceGo(rawLine)
    if (line === '') continue
    if (equalFoldAscii(line, '[glossary]')) {
      inGlossary = true
      hasHeader = true
      continue
    }
    // 遇到其他 section header 则退出 glossary 段
    if (hasPrefix(line, '[') && hasSuffix(line, ']')) {
      if (hasHeader) inGlossary = false
      continue
    }
    if (hasHeader && !inGlossary) continue
    const entry = parseGlossaryLine(line)
    if (entry !== null) raw.push(entry)
  }

  return { entries: dedupeBootstrapEntries(raw), hasHeader }
}

/**
 * 从纯文本响应中解析术语抽取/精简结果（Go `tryRepairBootstrapText`）。
 * error 仅在内部逻辑异常时返回；正常空结果不报错。
 */
export function tryRepairBootstrapTextInternal(
  text: string,
  opt: RepairOptions,
): BootstrapTextResult {
  let repaired: string[] = []

  if (opt.jsonStructural) {
    const cleaned = stripBOMAndZeroWidth(text)
    if (cleaned.did) repaired = [...repaired, 'text.strip-bom-zw']
    text = cleaned.text
  }

  const stripped = stripCodeFence(text)
  if (stripped !== text) {
    text = stripped
    repaired = [...repaired, 'text.strip-code-fence']
  }

  const parsed = parseBootstrapTextGlossary(text)
  return { entries: parsed.entries, repaired, hasHeader: parsed.hasHeader, error: null }
}

/** Go `TryRepairBootstrapText`（丢弃 hasHeader）。 */
export function tryRepairBootstrapText(
  text: string,
  opt: RepairOptions,
): { entries: BootstrapEntry[]; repaired: string[]; error: string | null } {
  const result = tryRepairBootstrapTextInternal(text, opt)
  return { entries: result.entries, repaired: result.repaired, error: result.error }
}

/**
 * 按 response mode 解析抽取/精简响应（Go `ParseBootstrapByMode`）。
 *
 * text 模式优先纯文本协议，失败或空列表时 fallback JSON（模型常仍吐 JSON）。
 * `requireHeaderForEmpty`：text 路径得到空列表且无 `[glossary]` 头、JSON 也失败时
 * 返回 `ERR_BOOTSTRAP_TEXT_EMPTY`。
 */
export function parseBootstrapByMode(
  text: string,
  isTextMode: boolean,
  opt: RepairOptions,
  requireHeaderForEmpty: boolean,
): { entries: BootstrapEntry[]; repaired: string[]; error: string | null } {
  if (!isTextMode) {
    return tryRepairBootstrap(text, opt)
  }

  const textResult = tryRepairBootstrapTextInternal(text, opt)
  if (textResult.error === null && textResult.entries.length > 0) {
    return { entries: textResult.entries, repaired: textResult.repaired, error: null }
  }

  const jsonResult = tryRepairBootstrap(text, opt)
  if (jsonResult.error === null) {
    const ops = [...textResult.repaired, ...jsonResult.repaired]
    if (textResult.entries.length === 0 && jsonResult.entries.length > 0) {
      ops.push('text.fallback-json')
    }
    return { entries: jsonResult.entries, repaired: ops, error: null }
  }

  if (textResult.error === null) {
    if (textResult.entries.length === 0 && requireHeaderForEmpty && !textResult.hasHeader) {
      return { entries: [], repaired: textResult.repaired, error: ERR_BOOTSTRAP_TEXT_EMPTY }
    }
    return { entries: textResult.entries, repaired: textResult.repaired, error: null }
  }
  return { entries: [], repaired: textResult.repaired, error: textResult.error }
}
