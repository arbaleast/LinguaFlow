/**
 * CSV 术语表（对应 Go `backend/internal/glossary/file.go` + `loader.go`）。
 *
 * 与 Go 唯一的架构差异：**没有文件系统**。
 * - Go `LoadFile(path)` → TS `loadFile(content, path)`：CSV 内容由调用方以字符串
 *   传入（浏览器侧来自 `<input type=file>` / OPFS / IndexedDB），领域层不读盘。
 * - Go `Save(ctx)`（temp + rename 原子写）→ TS `prepareSave()` 生成内容 +
 *   `save(sink)` 交给**可注入的 sink**；领域层只负责内容与顺序，原子性由 sink 的
 *   实现者（Phase 2 的 OPFS/IndexedDB 适配器）保证。
 * - Go `New(enabled, path)` 是「开关 + 扩展名分发 + 打开文件」的 IO 策略，
 *   不属于领域层，故未移植；浏览器侧按需选择 `loadFile` / `nopGlossary`。
 *
 * 内存模型与 Go 一致：`entries` 按 `source` 的 **UTF-8 字节长度**降序排序
 * （`sort.SliceStable`），于是 `lookup` 顺序遍历即「长词优先」
 * （"Gemini API" 在 "Gemini" 之前命中）；`bySource` 用规范化 key
 * （`caseSensitive=false` 时小写）做 O(1) 去重。
 */
import { err, ok, domainError, type Result } from '../shared/result'
import { utf8Length } from '../shared/unicode'
import { CsvReader, serializeCSV } from './csv'
import { goEqualFold, goToLower, goTrimSpace } from './text'
import {
  glossaryEntry,
  type AddResult,
  type Glossary,
  type GlossaryEntry,
  type GlossarySaver,
  type GlossarySink,
  type SavePlan,
  type SkippedEntry,
} from './types'

/** 布尔列解析（Go `parseBool`）：1/true/yes/y/on 视为真，大小写与空白无关。 */
export function parseBool(value: string): boolean {
  switch (goToLower(goTrimSpace(value))) {
    case '1':
    case 'true':
    case 'yes':
    case 'y':
    case 'on':
      return true
    default:
      return false
  }
}

/** 布尔列序列化（Go `boolStr`）。 */
export function boolStr(value: boolean): string {
  return value ? 'true' : 'false'
}

/**
 * 查重 key 的规范化（Go `normKey`）。
 *
 * 推荐条目每个 source 只保留一条；禁译条目允许同一 source 下多个 target。
 * key 里的 `\u0000` 与 Go 的 `\x00` 一致，保证拼接不会产生歧义。
 */
export function normKey(entry: GlossaryEntry): string {
  const source = goToLower(goTrimSpace(entry.source))
  if (entry.forbidden) return `F:${source}\u0000${entry.target}`
  return `R:${source}`
}

/** 表头判定（Go `isHeader`）：前两列分别是 source / target（大小写无关）。 */
export function isHeader(fields: readonly string[]): boolean {
  if (fields.length < 2) return false
  return (
    goEqualFold(goTrimSpace(fields[0] as string), 'source') &&
    goEqualFold(goTrimSpace(fields[1] as string), 'target')
  )
}

/**
 * 从一行 CSV 字段构造条目（Go `LoadFile` 的行处理）。
 *
 * 返回 `null` 表示该行应被跳过（source/target 为空或缺列）。注意两处与
 * 直觉不同、但必须复刻的 Go 行为：
 * - 扩展格式只在「表头第 4 列是 forbidden」或「行宽 ≥ 6」时启用；
 * - 5 列且表头第 4 列是 forbidden 时仍走 legacy 分支，第 4 列被当作 notes。
 */
export function entryFromFields(
  fields: readonly string[],
  extendedFormat: boolean,
): GlossaryEntry | null {
  if (fields.length < 2) return null
  const source = goTrimSpace(fields[0] as string)
  const target = goTrimSpace(fields[1] as string)
  if (source === '' || target === '') return null

  const entry = glossaryEntry({ source, target, mandatory: true })
  if (fields.length >= 3) {
    entry.caseSensitive = parseBool(fields[2] as string)
  }
  if (extendedFormat || fields.length >= 6) {
    if (fields.length >= 4) {
      entry.forbidden = parseBool(fields[3] as string)
    }
    entry.mandatory = true
    if (fields.length >= 5) {
      entry.mandatory = parseBool(fields[4] as string)
    }
    if (fields.length >= 6) {
      entry.notes = goTrimSpace(fields[5] as string)
    }
  } else {
    entry.mandatory = true
    if (fields.length >= 4) {
      entry.notes = goTrimSpace(fields[3] as string)
    }
  }
  return entry
}

/**
 * 从 CSV 字符串载入术语表（Go `LoadFile`）。
 *
 * 文件不存在 → 空表（首次 bootstrap 场景）：浏览器侧直接传空串即可。
 * 解析失败返回 `Result` 的失败分支（对应 Go 的 `error`）。
 */
export function loadFile(content: string, path = ''): Result<FileGlossary> {
  return FileGlossary.loadCSV(content, path)
}

/**
 * CSV 文件后端的术语表（Go `FileGlossary`）。
 *
 * `path` 只是诊断信息与落盘目标，领域层从不访问文件系统；浏览器侧可以传
 * 虚拟路径或文件名。
 */
export class FileGlossary implements Glossary, GlossarySaver {
  private entries: GlossaryEntry[] = []
  private bySource = new Map<string, number>()
  private dirtyFlag = false

  constructor(readonly path = '') {}

  /**
   * 从 CSV 字符串构造（Go `LoadFile`）。
   *
   * 首次启动读不到文件时，调用方传空串即得空表。
   */
  static loadCSV(content: string, path = ''): Result<FileGlossary> {
    const glossary = new FileGlossary(path)
    // Go 用 bufio.Peek(3) 剥掉文件头的 UTF-8 BOM（U+FEFF）。
    if (content.startsWith('\ufeff')) content = content.slice(1)

    const reader = new CsvReader(content)
    let first = true
    let extendedFormat = false
    for (;;) {
      const result = reader.read()
      if (result.kind === 'eof') break
      if (result.kind === 'error') {
        return err(
          domainError(
            'glossary.parse',
            `glossary: parse ${path}: ${result.error.code} at line ${result.error.line}`,
          ),
        )
      }
      const fields = result.fields
      if (first) {
        first = false
        if (isHeader(fields)) {
          extendedFormat =
            fields.length >= 6 && goEqualFold(goTrimSpace(fields[3] as string), 'forbidden')
          continue
        }
      }
      const entry = entryFromFields(fields, extendedFormat)
      if (entry === null) continue
      glossary.addLocked(entry)
    }
    glossary.sortLocked()
    glossary.dirtyFlag = false
    return ok(glossary)
  }

  /**
   * 用一组「已是最终形态」的条目构造（不 trim、不去重、不丢弃空条目）。
   *
   * 对齐 Go 测试里直接给 `FileGlossary.entries` 赋值的行为，供 Phase 2 从
   * IndexedDB/OPFS 恢复原样数据使用；构造后按内部顺序（字节长度降序）排序。
   */
  static fromEntries(entries: Iterable<GlossaryEntry>, path = ''): FileGlossary {
    const glossary = new FileGlossary(path)
    for (const entry of entries) {
      glossary.addLocked({ ...entry })
    }
    glossary.sortLocked()
    return glossary
  }

  /** 命中数（Go `Len`）。 */
  get length(): number {
    return this.entries.length
  }

  /** 自上次 Save 后是否有过 Add（Go `Dirty`）。 */
  get dirty(): boolean {
    return this.dirtyFlag
  }

  /**
   * 在 `text` 中查找命中的术语（Go `Lookup`）。
   *
   * 返回内部顺序（`source` 字节长度降序）下的全部命中；空文本直接返回空数组。
   * `srcLang` / `tgtLang` 不参与匹配（MVP 单语言对一表），保留参数位。
   */
  lookup(text: string, _srcLang = '', _tgtLang = ''): GlossaryEntry[] {
    if (text === '') return []
    const lowerText = goToLower(text)
    const hits: GlossaryEntry[] = []
    for (const entry of this.entries) {
      const hit = entry.caseSensitive
        ? text.includes(entry.source)
        : lowerText.includes(goToLower(entry.source))
      if (hit) hits.push({ ...entry })
    }
    return hits
  }

  /**
   * 严格合并（Go `Add`）：source 已存在则跳过，不覆盖人工修订。
   *
   * - source/target/notes 先 trim；
   * - source 或 target 为空 → `skipped`，reason=empty；
   * - 同 key 且 target 相同 → noop（不进 added/skipped）；
   * - 同 key 且 target 不同 → `skipped`，reason=exists，`existing` 填表中版本。
   */
  add(...entries: GlossaryEntry[]): AddResult {
    const result: AddResult = { added: [], skipped: [] }
    if (entries.length === 0) return result
    let added = false
    for (const raw of entries) {
      const entry = glossaryEntry({
        source: goTrimSpace(raw.source),
        target: goTrimSpace(raw.target),
        notes: goTrimSpace(raw.notes),
        caseSensitive: raw.caseSensitive,
        forbidden: raw.forbidden,
        mandatory: raw.mandatory,
      })
      if (entry.source === '' || entry.target === '') {
        const skipped: SkippedEntry = {
          proposed: entry,
          existing: glossaryEntry(),
          reason: 'empty',
        }
        result.skipped.push(skipped)
        continue
      }
      const index = this.bySource.get(normKey(entry))
      if (index !== undefined) {
        const existing = this.entries[index] as GlossaryEntry
        if (existing.target === entry.target) continue
        result.skipped.push({
          proposed: entry,
          existing: { ...existing },
          reason: 'exists',
        })
        continue
      }
      this.addLocked(entry)
      result.added.push({ ...entry })
      added = true
    }
    if (added) {
      this.sortLocked()
      this.dirtyFlag = true
    }
    return result
  }

  /**
   * 生成待写入内容（纯函数，零 IO）。
   *
   * 空 path 视为失败（Go `Save` 的 `glossary: empty path`）。
   */
  prepareSave(): Result<SavePlan> {
    if (this.path === '') {
      return err(domainError('glossary.empty_path', 'glossary: empty path'))
    }
    return ok({ path: this.path, content: serializeCSV(this.entries) })
  }

  /**
   * 生成内容并交给注入的 sink（原子性由 sink 保证）。
   *
   * sink 抛错时异常向上传播且 **不清 dirty**（Go 侧写失败也不清）。
   */
  save(sink: GlossarySink): Result<SavePlan> {
    const plan = this.prepareSave()
    if (!plan.ok) return plan
    sink(plan.value)
    this.dirtyFlag = false
    return plan
  }

  /** `source` 列表副本，按内部顺序（长术语优先）。测试/诊断用（Go `SnapshotSources`）。 */
  snapshotSources(): string[] {
    return this.entries.map((entry) => entry.source)
  }

  /** 条目快照（深拷贝），按内部顺序。测试/诊断用。 */
  snapshotEntries(): GlossaryEntry[] {
    return this.entries.map((entry) => ({ ...entry }))
  }

  /** 追加一条（不排序、不去重、不上锁）。调用方须保证 key 唯一（Go `addLocked`）。 */
  private addLocked(entry: GlossaryEntry): void {
    this.entries.push(entry)
    this.bySource.set(normKey(entry), this.entries.length - 1)
  }

  /**
   * 按 `source` 的 **UTF-8 字节长度**降序稳定重排，并重建索引（Go `sortLocked`）。
   *
   * 必须用 `utf8Length` 而不是 `text.length` / `runeCount`：Go 的 `len(Source)`
   * 是字节数，三者对 CJK/emoji 结果不同（"人工智能" 12 字节 / 4 rune / 4 code unit）。
   * `Array.prototype.sort` 自 ES2019 起保证稳定，与 `sort.SliceStable` 一致。
   */
  private sortLocked(): void {
    this.entries.sort((a, b) => utf8Length(b.source) - utf8Length(a.source))
    this.bySource = new Map()
    this.entries.forEach((entry, index) => {
      this.bySource.set(normKey(entry), index)
    })
  }
}

/** 空内存表（Go `NewMemory`）：没有 path，`save` 会因空 path 失败。 */
export function newMemory(): FileGlossary {
  return new FileGlossary('')
}
