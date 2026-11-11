/**
 * 内存术语表与 CJK 目标语判定（对应 Go `backend/internal/glossary` 的
 * `NewMemory` / `Add` / `Lookup`，以及 `qa.glossaryIsCJK`）。
 *
 * 术语表本身是平台能力（文件 / DB 后端），但 checker 只依赖 `Lookup` 的语义。
 * 这里提供一个与 Go `FileGlossary` 内存实现**逐条对齐**的纯内存版本：
 * - `Add` 规范化（trim、空值丢弃、按 source 去重，禁译条目按 source+target 去重），
 *   并按 `len(Source)`（UTF-8 字节数）**稳定降序**重排——长术语优先命中；
 * - `Lookup` 对非大小写敏感条目在 `strings.ToLower` 后的文本上做子串匹配。
 *
 * 前端运行时若接入真实术语表，只需实现 {@link Glossary} 接口，checker 无需改动。
 */
import { isSpace } from '../shared/unicode'
import { utf8Length } from '../shared/unicode'
import type { Glossary, GlossaryEntry } from './types'

/** `Add` 中被丢弃的条目及原因。 */
export interface SkippedEntry {
  proposed: GlossaryEntry
  existing: GlossaryEntry | null
  reason: 'exists' | 'empty'
}

/** `Add` 的处理详情（Go `glossary.AddResult`）。 */
export interface AddResult {
  added: GlossaryEntry[]
  skipped: SkippedEntry[]
}

/** 构造一条术语条目的缺省值。 */
export function newGlossaryEntry(init: Partial<GlossaryEntry> = {}): GlossaryEntry {
  return {
    source: init.source ?? '',
    target: init.target ?? '',
    caseSensitive: init.caseSensitive ?? false,
    forbidden: init.forbidden ?? false,
    mandatory: init.mandatory ?? false,
    notes: init.notes ?? '',
  }
}

/** Go `strings.ToLower`（逐码点全小写；与 `String.prototype.toLowerCase` 同义）。 */
function lower(s: string): string {
  return s.toLowerCase()
}

/** Go `strings.TrimSpace`。 */
function trimSpaceGo(s: string): string {
  const runes = Array.from(s)
  let start = 0
  let end = runes.length
  while (start < end && isSpace(runes[start]!.codePointAt(0) ?? 0)) start++
  while (end > start && isSpace(runes[end - 1]!.codePointAt(0) ?? 0)) end--
  return runes.slice(start, end).join('')
}

/** 查重 key（Go `normKey`）：推荐条目每个 source 只留一条；禁译条目按 source+target。 */
function normKey(e: GlossaryEntry): string {
  const source = lower(trimSpaceGo(e.source))
  if (e.forbidden) {
    return `F:${source}\u0000${e.target}`
  }
  return `R:${source}`
}

/**
 * 纯内存术语表（Go `glossary.NewMemory` 的 FileGlossary 内存形态）。
 *
 * 并发语义在领域层无意义（单线程纯内存），故不持锁；除此之外的合并/排序/查找
 * 语义与 Go 完全一致。
 */
export class MemoryGlossary implements Glossary {
  private entries: GlossaryEntry[] = []
  private bySource = new Map<string, number>()

  /** 当前条目数（Go `FileGlossary.Len`）。 */
  get size(): number {
    return this.entries.length
  }

  /** 按当前内部顺序返回 source 列表（长术语优先；Go `SnapshotSources`）。 */
  sources(): string[] {
    return this.entries.map((e) => e.source)
  }

  /**
   * 追加术语（Go `FileGlossary.Add`）：严格合并，source 已存在则跳过、不覆盖人工修订。
   * `Proposed.Target` 与 `Existing.Target` 完全相等时视作 noop，既不进 Added 也不进 Skipped。
   */
  add(...entries: GlossaryEntry[]): AddResult {
    const result: AddResult = { added: [], skipped: [] }
    if (entries.length === 0) {
      return result
    }
    let added = false
    for (const raw of entries) {
      const e = { ...raw }
      e.source = trimSpaceGo(e.source)
      e.target = trimSpaceGo(e.target)
      e.notes = trimSpaceGo(e.notes)
      if (e.source === '' || e.target === '') {
        result.skipped.push({ proposed: e, existing: null, reason: 'empty' })
        continue
      }
      const idx = this.bySource.get(normKey(e))
      if (idx !== undefined) {
        const existing = this.entries[idx]!
        if (existing.target === e.target) {
          continue
        }
        result.skipped.push({ proposed: e, existing, reason: 'exists' })
        continue
      }
      this.entries.push(e)
      this.bySource.set(normKey(e), this.entries.length - 1)
      result.added.push(e)
      added = true
    }
    if (added) {
      this.sort()
    }
    return result
  }

  /** 按 `len(Source)`（UTF-8 字节）降序稳定重排并重建索引（Go `sortLocked`）。 */
  private sort(): void {
    const indexed = this.entries.map((e, i) => ({ e, i }))
    indexed.sort((a, b) => {
      const d = utf8Length(b.e.source) - utf8Length(a.e.source)
      return d !== 0 ? d : a.i - b.i
    })
    this.entries = indexed.map((x) => x.e)
    this.bySource = new Map()
    this.entries.forEach((e, i) => {
      this.bySource.set(normKey(e), i)
    })
  }

  /** 在 `text` 中查找命中的术语（Go `FileGlossary.Lookup`；忽略语言对）。 */
  lookup(text: string): GlossaryEntry[] {
    if (text === '') {
      return []
    }
    const lowerText = lower(text)
    const hits: GlossaryEntry[] = []
    for (const e of this.entries) {
      if (e.caseSensitive) {
        if (text.includes(e.source)) {
          hits.push(e)
        }
      } else if (lowerText.includes(lower(e.source))) {
        hits.push(e)
      }
    }
    return hits
  }
}

/**
 * 目标语是否 CJK 语种（Go `qa.glossaryIsCJK`，镜像 `glossary.IsCJKTarget`）。
 *
 * 用于标点配对表、全半角混用方向与 CJK 间空格判定。
 */
export function glossaryIsCJK(lang: string): boolean {
  let l = lower(trimSpaceGo(lang))
  const i = firstIndexAny(l, '-_')
  if (i > 0) {
    l = l.slice(0, i)
  }
  switch (l) {
    case 'zh':
    case 'ja':
    case 'ko':
    case 'th':
    case 'lo':
    case 'my':
    case 'km':
      return true
    default:
      return false
  }
}

/** 取首个 `-` 或 `_` 的下标（Go `strings.IndexAny`）。 */
function firstIndexAny(s: string, chars: string): number {
  let best = -1
  for (const ch of chars) {
    const i = s.indexOf(ch)
    if (i >= 0 && (best < 0 || i < best)) best = i
  }
  return best
}
