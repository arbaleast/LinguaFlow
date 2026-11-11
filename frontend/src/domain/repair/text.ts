/**
 * 纯文本协议修复（对应 Go `backend/internal/repair/text.go`）。
 *
 * 三段协议：
 *
 * ```text
 * [1] 译文…
 * [glossary]
 * source | target | notes
 * [ruby]
 * 段号: base | text | kind[ | item_id]
 * ```
 *
 * 修复链：T1 结构清理（BOM / ``` 围栏 / 首尾非 [N] 文本）；T3 部分成功
 * （缺失 ID 记入 missing，不视为 fatal）。
 */
import { findStringSubmatch } from '../shared/re2'
import { compile } from '../shared/re2'
import { parseInlineMarkers, parseSectionRubyOutput } from './deps/ruby_protocol'
import { stripCodeFence } from './deps/prompt_protocol'

export { stripCodeFence }
import { stripBOMAndZeroWidth } from './json'
import { equalFoldAscii, hasPrefix, hasSuffix, splitN, splitString, trimSpaceGo } from './strings'
import type { BootstrapEntry, RepairOptions, RepairResult, RubyOutputMap } from './types'

/** 匹配 `[N]` 开头的翻译行，捕获编号和内容（Go `textLineRe`）。 */
const textLineRe = compile('^\\[(\\d+)\\]\\s*(.*)')

/** `parseTextResponse` 的返回。 */
interface ParsedTextResponse {
  trans: Record<string, string>
  glos: BootstrapEntry[]
  rubyOutput: RubyOutputMap | null
  error: string | null
}

/**
 * 解析 `source | target | notes` 格式的术语行（Go `parseGlossaryLine`）。
 * 字段不足或 source/target 为空返回 `null`。
 */
export function parseGlossaryLine(line: string): BootstrapEntry | null {
  const parts = splitN(line, '|', 3)
  if (parts.length < 2) return null
  const source = trimSpaceGo(parts[0] as string)
  const target = trimSpaceGo(parts[1] as string)
  if (source === '' || target === '') return null
  const entry: BootstrapEntry = { source, target, notes: '' }
  if (parts.length >= 3) {
    entry.notes = trimSpaceGo(parts[2] as string)
  }
  return entry
}

/**
 * 尝试从纯文本响应中提取翻译结果（Go `TryRepairText`）。
 * 永不抛错——失败语义通过 `fatal` + `parseErr` 表达。
 */
export function tryRepairText(
  text: string,
  wantIDs: readonly string[],
  opt: RepairOptions,
): RepairResult {
  let repaired: string[] = []

  // T1 结构清理
  if (opt.jsonStructural) {
    const cleaned = stripBOMAndZeroWidth(text)
    if (cleaned.did) repaired = [...repaired, 'text.strip-bom-zw']
    text = cleaned.text
  }

  // 剥离 ``` 围栏
  const stripped = stripCodeFence(text)
  if (stripped !== text) {
    text = stripped
    repaired = [...repaired, 'text.strip-code-fence']
  }

  const parsed = parseTextResponse(text, wantIDs)
  if (parsed.error !== null) {
    // Pool model always accepts best partial：只要解析出任何译文，就不返回 Fatal，
    // 让调用方按 missing 恢复缺失 ID。
    if (Object.keys(parsed.trans).length > 0) {
      const missing: string[] = []
      for (const id of wantIDs) {
        if (!Object.prototype.hasOwnProperty.call(parsed.trans, id)) missing.push(id)
      }
      return {
        trans: parsed.trans,
        glos: parsed.glos,
        rubyOutput: parsed.rubyOutput,
        missing,
        repaired,
        fatal: false,
        parseErr: null,
      }
    }
    return {
      trans: {},
      glos: [],
      rubyOutput: null,
      missing: [],
      repaired,
      fatal: true,
      parseErr: parsed.error,
    }
  }

  const missing: string[] = []
  for (const id of wantIDs) {
    if (!Object.prototype.hasOwnProperty.call(parsed.trans, id)) missing.push(id)
  }

  return {
    trans: parsed.trans,
    glos: parsed.glos,
    rubyOutput: parsed.rubyOutput,
    missing,
    repaired,
    fatal: false,
    parseErr: null,
  }
}

/** 解析纯文本格式响应（Go `parseTextResponse`）。 */
export function parseTextResponse(text: string, wantIDs: readonly string[]): ParsedTextResponse {
  const trans: Record<string, string> = {}
  const glos: BootstrapEntry[] = []
  let rubyOutput: RubyOutputMap | null = null

  const lines = splitString(text, '\n')
  let lastID = ''
  let inGlossary = false
  let inRuby = false
  const rubyLines: string[] = []

  for (const rawLine of lines) {
    const line = trimSpaceGo(rawLine)
    if (line === '') continue

    if (equalFoldAscii(line, '[glossary]')) {
      inGlossary = true
      inRuby = false
      continue
    }

    if (equalFoldAscii(line, '[ruby]')) {
      inRuby = true
      inGlossary = false
      continue
    }

    // 检查 [N] 开头的翻译行（即使在 glossary/ruby 模式下也优先匹配）。
    const match = findStringSubmatch(textLineRe, line)
    if (match !== null) {
      inGlossary = false
      inRuby = false
      lastID = match[1] as string
      trans[lastID] = match[2] as string
      continue
    }

    if (inGlossary) {
      const entry = parseGlossaryLine(line)
      if (entry !== null) glos.push(entry)
      continue
    }

    if (inRuby) {
      rubyLines.push(line)
      continue
    }

    if (hasPrefix(line, '[*]')) continue

    if (lastID !== '') {
      trans[lastID] = `${trans[lastID] ?? ''}\n${line}`
    }
  }

  if (rubyLines.length > 0) {
    rubyOutput = parseSectionRubyOutput(rubyLines)
  } else {
    // 无 [ruby] 段落时，尝试从译文中提取 inline markers。
    for (const [id, value] of Object.entries(trans)) {
      const entries = parseInlineMarkers(value)
      if (entries.length > 0) {
        if (rubyOutput === null) rubyOutput = {}
        rubyOutput[id] = entries
      }
    }
  }

  if (Object.keys(trans).length === 0) {
    return {
      trans: {},
      glos: [],
      rubyOutput: null,
      error: 'no translations found in text response',
    }
  }

  const missing: string[] = []
  for (const id of wantIDs) {
    if (!Object.prototype.hasOwnProperty.call(trans, id)) missing.push(id)
  }
  if (missing.length > 0) {
    return {
      trans,
      glos,
      rubyOutput,
      error: `missing translations for IDs: ${missing.join(' ')}`,
    }
  }

  return { trans, glos, rubyOutput, error: null }
}

/**
 * 收集 text 中 `[section]` 段落内的非空行（Go `collectSectionLines`）。
 *
 * 先经 `stripCodeFence` 剥围栏，保证段落收集与 `ParseReviseTextRevisions` 的
 * 围栏预处理看到同一文本形态。
 */
export function collectSectionLines(text: string, section: string): string[] {
  const lines: string[] = []
  let inSection = false
  for (const rawLine of splitString(stripCodeFence(text), '\n')) {
    const line = trimSpaceGo(rawLine)
    if (line === '') continue
    if (equalFoldAscii(line, `[${section}]`)) {
      inSection = true
      continue
    }
    if (hasPrefix(line, '[') && hasSuffix(line, ']')) {
      inSection = false
      continue
    }
    if (inSection) lines.push(line)
  }
  return lines
}
