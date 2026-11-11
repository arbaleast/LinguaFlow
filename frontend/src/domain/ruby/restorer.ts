/**
 * 注音还原与输出条目处理（对应 Go `backend/internal/ruby/restorer.go`）。
 *
 * 偏移量单位：Go 使用 UTF-8 字节偏移；本移植统一使用 **UTF-16 code unit 偏移**。
 * 因为所有查找（`indexOf`）与切片都在同一坐标系内完成，截取出的子串与 Go 完全
 * 一致；唯一需要显式换算的是「rune 数量」类比较（如 `runeLen`）。
 */
import {
  compile,
  findAllStringIndex,
  findStringSubmatch,
  replaceAllStringFunc,
} from '../shared/re2'
import { isRestorable, newOutputEntry, type OutputEntry, type RubyItem } from './item'
import { parsePrimaryTextEntry, parseSectionLine } from './protocol'
import { trimSpace } from './text'

/** 注音还原的匹配统计（Go `RestoreResult`）。 */
export interface RestoreResult {
  /** 成功匹配并还原的注音条目数。 */
  matched: number
  /** 需要还原的注音条目总数（不含空 base 的条目）。 */
  total: number
}

/** 零值还原结果。 */
export function emptyRestoreResult(): RestoreResult {
  return { matched: 0, total: 0 }
}

/** 是否全部匹配成功（Go `RestoreResult.IsFull`）。 */
export function isFullResult(r: RestoreResult): boolean {
  return r.total > 0 && r.matched === r.total
}

/** 归一化还原结果（用于 JSON 输出）。 */
export function restoreResultJSON(r: RestoreResult): { matched: number; total: number } {
  return { matched: r.matched, total: r.total }
}

/** 一次注音插入的位置与内容（Go `insertInfo`）。 */
interface InsertInfo {
  pos: number
  end: number
  base: string
  text: string
}

/**
 * 在 target 中查找 base 的第一个未分配出现位置（Go `findAndInsert`）。
 *
 * 找到后记录到 inserts 并标记 assigned；未找到返回 false。
 */
function findAndInsert(
  target: string,
  base: string,
  text: string,
  assigned: Set<number>,
  inserts: InsertInfo[],
): boolean {
  let searchFrom = 0
  for (;;) {
    const idx = target.indexOf(base, searchFrom)
    if (idx < 0) break
    if (!assigned.has(idx)) {
      assigned.add(idx)
      inserts.push({ pos: idx, end: idx + base.length, base, text })
      return true
    }
    searchFrom = idx + 1
  }
  return false
}

/**
 * 从统一 Item 结构还原 `<ruby>` 标签（Go `RestoreItems`）。
 *
 * 仅对 `target_base` 非空的条目尝试还原；第一优先用条目自身的 `target_base`
 * 在译文中定位，未命中且 `source_base` 非空且不同于 `target_base` 时，第二优先
 * 回退到该条目自身的 `source_base`。
 *
 * `total` = 需要还原的条目数（`target_base` 或 `source_base` 非空）。
 * 纯函数：不修改 items（含 aligned 字段）。
 */
export function restoreItems(
  target: string,
  items: readonly RubyItem[],
): { target: string; result: RestoreResult } {
  if (target === '' || items.length === 0) {
    return { target, result: emptyRestoreResult() }
  }

  const assigned = new Set<number>()
  const inserts: InsertInfo[] = []
  let total = 0

  for (const it of items) {
    if (!isRestorable(it)) continue
    total++
    if (it.target_base === '') continue
    let found = findAndInsert(target, it.target_base, it.target_text, assigned, inserts)
    if (!found && it.source_base !== '' && it.source_base !== it.target_base) {
      found = findAndInsert(target, it.source_base, it.target_text, assigned, inserts)
    }
  }

  if (inserts.length === 0) {
    return { target, result: { matched: 0, total } }
  }

  // 按位置从右到左排序，避免替换时索引偏移
  inserts.sort((a, b) => b.pos - a.pos)

  let out = target
  for (const ins of inserts) {
    const rubyTag = `<ruby>${ins.base}<rt>${ins.text}</rt></ruby>`
    out = out.slice(0, ins.pos) + rubyTag + out.slice(ins.end)
  }
  return { target: out, result: { matched: inserts.length, total } }
}

/** 匹配 `⟦ruby:base/text⟧` 或 `⟦ruby:base/text/kind⟧` 格式的内联标记。 */
const inlineMarkerRe = compile('⟦ruby:([^/⟧]+)/([^/⟧]+)(?:/([^⟧]+))?⟧')

/** 匹配 section 模式的 ruby 输出行：`编号: content`。 */
const sectionRubyLineRe = compile('^(\\d+):\\s*(.+)')

/**
 * 从译文中提取所有内联标记并转换为 {@link OutputEntry}（Go `ParseInlineMarkers`）。
 *
 * 无匹配返回空数组（Go nil）。
 */
export function parseInlineMarkers(text: string): OutputEntry[] {
  const matches = findAllStringIndex(inlineMarkerRe, text)
  if (matches.length === 0) return []
  const entries: OutputEntry[] = []
  for (const [start, end] of matches) {
    const m = findStringSubmatch(inlineMarkerRe, text.slice(start, end))
    if (m === null || m.length < 3) continue
    entries.push(
      newOutputEntry({
        base: m[1] ?? '',
        text: m[2] ?? '',
        kind: m.length > 3 ? (m[3] ?? '') : '',
      }),
    )
  }
  return entries
}

/**
 * 对解析出的条目做 trim 与合法性过滤（Go `NormalizeOutputEntries`）。
 *
 * trim `base` / `text` / `kind`，丢弃 `base` 为空的条目（**不 trim id**）。
 */
export function normalizeOutputEntries(entries: readonly OutputEntry[]): OutputEntry[] {
  const out: OutputEntry[] = []
  for (const entry of entries) {
    const base = trimSpace(entry.base)
    const text = trimSpace(entry.text)
    const kind = trimSpace(entry.kind)
    if (base === '') continue
    out.push({ ...entry, base, text, kind })
  }
  return out
}

/**
 * 裸数组兜底（repair 的 `json.bare-array` 算子）的领域判别器
 * （Go `ValidBareOutputEntries`）。
 *
 * 真实条目必带非空 text 或合法 kind；仅有 base 的对象（如定向重试 prompt 里
 * `{id, source_base, source_text}` 的回显变体）判为诱饵。
 */
export function validBareOutputEntries(entries: readonly unknown[]): boolean {
  for (const e of entries) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) return false
    const m = e as Record<string, unknown>
    const text = typeof m['text'] === 'string' ? m['text'] : ''
    const kind = typeof m['kind'] === 'string' ? m['kind'] : ''
    if (trimSpace(text) !== '' || isValidKindForBare(kind)) return true
  }
  return false
}

/** 本地引用 kind 白名单，避免 bare 判别器与 `item.ts` 的导入环。 */
function isValidKindForBare(kind: string): boolean {
  return kind === 'phonetic' || kind === 'semantic' || kind === 'creative'
}

/**
 * 解析 section 模式的 `[ruby]` 段落（Go `ParseSectionRubyOutput`）。
 *
 * 输入为 `[ruby]` 之后的所有行（不含标题行）。每行 `编号: base | text | kind[ | item_id]`。
 * 行首编号是段号（映射 key），不是条目 id；条目 id 仅来自可选的第 4 字段。
 */
export function parseSectionRubyOutput(lines: readonly string[]): Record<string, OutputEntry[]> {
  const result: Record<string, OutputEntry[]> = {}
  for (const rawLine of lines) {
    const line = trimSpace(rawLine)
    if (line === '') continue
    const m = findStringSubmatch(sectionRubyLineRe, line)
    if (m === null) continue
    const id = m[1] ?? '' // 段号（map key），非条目 id
    const content = m[2] ?? ''
    if (trimSpace(content).startsWith('"')) {
      const entry = parsePrimaryTextEntry(content)
      ;(result[id] ??= []).push(entry)
      continue
    }
    const parsed = parseSectionLine(content)
    if (!parsed.ok) continue
    const entry = newOutputEntry({
      base: parsed.base,
      text: parsed.text,
      kind: parsed.kind,
      id: parsed.itemId,
    })
    ;(result[id] ??= []).push(entry)
  }
  return result
}

/**
 * 通过正则替换把译文中的内联标记还原为 `<ruby>` 标签（Go `RestoreInlineMarkers`）。
 *
 * `rubyOutput` 为过滤后的条目；还原匹配的标记，移除不匹配的标记（保留基底）。
 * `total` 是过滤前译文中全部标记数（标记由 LLM 书写、自证）。
 */
export function restoreInlineMarkers(
  target: string,
  rubyOutput: readonly OutputEntry[],
): { target: string; result: RestoreResult } {
  const allMatches = findAllStringIndex(inlineMarkerRe, target)
  if (allMatches.length === 0) {
    return { target, result: emptyRestoreResult() }
  }
  if (rubyOutput.length === 0) {
    // 全部过滤掉，移除标记但保留基底
    const out = replaceAllStringFunc(inlineMarkerRe, target, (match) => {
      const m = findStringSubmatch(inlineMarkerRe, match)
      if (m !== null && m.length >= 3) return m[1] ?? ''
      return match
    })
    return { target: out, result: { matched: 0, total: allMatches.length } }
  }
  // 构建匹配集合：base+text → 存在
  const matchSet = new Set<string>()
  for (const e of rubyOutput) {
    if (e.base !== '') matchSet.add(`${e.base}\u0000${e.text}`)
  }
  let matched = 0
  const out = replaceAllStringFunc(inlineMarkerRe, target, (match) => {
    const m = findStringSubmatch(inlineMarkerRe, match)
    if (m === null || m.length < 3) return match
    const base = m[1] ?? ''
    const text = m[2] ?? ''
    if (matchSet.has(`${base}\u0000${text}`)) {
      matched++
      return `<ruby>${base}<rt>${text}</rt></ruby>`
    }
    return base // 不在保留集合中，移除标记但保留基底
  })
  return { target: out, result: { matched, total: allMatches.length } }
}

/**
 * 还原 well-formed legacy 内联标记的基底（Go `StripLegacyInlineMarkers`）。
 *
 * 标记数量与注音文本不作为源文条目身份的证据。
 */
export function stripLegacyInlineMarkers(text: string): string {
  return replaceAllStringFunc(inlineMarkerRe, text, (marker) => {
    const m = findStringSubmatch(inlineMarkerRe, marker)
    return m !== null && m.length >= 2 ? (m[1] ?? '') : marker
  })
}
