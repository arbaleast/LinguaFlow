/**
 * CSV 读写（对齐 Go `encoding/csv` 的 Reader/Writer 语义）。
 *
 * 为什么不用现成 CSV 库：
 * 1. 领域层要求零依赖、零 IO；此处只处理字符串。
 * 2. Go 的 `encoding/csv` 有几处与 RFC/常见实现不同的细节，必须逐字节复刻：
 *    - `TrimLeadingSpace = true`：每个字段行首的 `unicode.IsSpace` 被裁掉
 *      （包括行尾换行前的空白）。
 *    - 只有 `\n` 是行结束符；`\r\n` 在读取时被归一为 `\n`（**引号字段内部也一样**），
 *      孤立 `\r` 保留为普通字符。
 *    - 空行（`\n`）被跳过；只含空白的行不是空行，会解析成一个空字段。
 *    - 末行没有换行符时仍会解析；末行尾随的单个 `\r` 被丢弃。
 *    - 引号字段内 `""` 表示一个 `"`；闭合引号后只允许 `,` 或行尾，否则报错。
 *
 * 下标单位是 UTF-16 code unit：我们只在 ASCII 定界符（`,` `"` `\n` `\r`）处
 * 切片，这些字符绝不会落在多字节序列中间，故截取结果与 Go 的 UTF-8 字节
 * 切片一致。字符分类（行首空白）走 `isSpace` 的码点语义。
 */
import { isSpace } from '../shared/unicode'

const COMMA = 0x2c
const QUOTE = 0x22
/** Go `utf8.RuneError`：`nextRune` 在空串上的返回值。 */
const RUNE_ERROR = 0xfffd

/** CSV 写出表头（Go `csvHeader`）。 */
export const CSV_HEADER: readonly string[] = [
  'source',
  'target',
  'case_sensitive',
  'forbidden',
  'mandatory',
  'notes',
]

/** 解析错误种类（对应 Go 的 ErrBareQuote / ErrQuote）。 */
export type CsvErrorCode = 'bare_quote' | 'quote' | 'unclosed'

/** 解析错误。 */
export interface CsvParseError {
  code: CsvErrorCode
  /** 记录起始行号（1-based，与 Go 的 ParseError.StartLine 对齐）。 */
  line: number
}

/** 一次 `read()` 的结果。 */
export type CsvRecordResult =
  | { kind: 'record'; fields: string[] }
  | { kind: 'eof' }
  | { kind: 'error'; error: CsvParseError }

/** 读取一行，返回行内容（保留行尾 `\n`）与是否已到输入末尾。 */
interface CsvLine {
  line: string
  eof: boolean
}

/**
 * 流式 CSV 读取器，逐条复刻 Go `encoding/csv.Reader`（`TrimLeadingSpace=true`、
 * `FieldsPerRecord=-1`、`LazyQuotes=false`）。
 */
export class CsvReader {
  private pos = 0
  private lineNo = 0

  constructor(private readonly src: string) {}

  /** Go `readLine`：只在 `\n` 处断行，并归一 `\r\n`。 */
  private readLine(): CsvLine {
    if (this.pos >= this.src.length) {
      this.lineNo++
      return { line: '', eof: true }
    }
    const nl = this.src.indexOf('\n', this.pos)
    if (nl < 0) {
      // Go 在「有数据 + io.EOF」时把 err 归一为 nil，并丢弃末尾单个 \r。
      let line = this.src.slice(this.pos)
      this.pos = this.src.length
      if (line.endsWith('\r')) line = line.slice(0, -1)
      this.lineNo++
      return { line, eof: false }
    }
    let line = this.src.slice(this.pos, nl + 1)
    this.pos = nl + 1
    this.lineNo++
    if (line.length >= 2 && line[line.length - 2] === '\r') {
      line = `${line.slice(0, -2)}\n`
    }
    return { line, eof: false }
  }

  /** Go `Reader.Read`：返回下一条记录、EOF 或解析错误。 */
  read(): CsvRecordResult {
    let line = ''
    let eof = false
    for (;;) {
      const next = this.readLine()
      line = next.line
      eof = next.eof
      if (eof) break
      // Go：errRead == nil && len(line) == lengthNL(line) → 跳过空行。
      if (line === '\n') continue
      break
    }
    if (eof) return { kind: 'eof' }

    const recordLine = this.lineNo
    let record = ''
    const fieldEnds: number[] = []

    parseField: for (;;) {
      // TrimLeadingSpace：裁掉行首（含行尾 \n）的 Go 空白。
      let trimTo = 0
      while (trimTo < line.length) {
        const cp = line.codePointAt(trimTo) ?? 0
        if (!isSpace(cp)) break
        trimTo += cp > 0xffff ? 2 : 1
      }
      line = line.slice(trimTo)

      if (line.length === 0 || line[0] !== '"') {
        // 非引号字段：到逗号或行尾。
        const comma = line.indexOf(',')
        let field: string
        if (comma >= 0) {
          field = line.slice(0, comma)
        } else {
          field = line.endsWith('\n') ? line.slice(0, -1) : line
        }
        if (field.includes('"')) {
          return { kind: 'error', error: { code: 'bare_quote', line: recordLine } }
        }
        record += field
        fieldEnds.push(record.length)
        if (comma >= 0) {
          line = line.slice(comma + 1)
          continue parseField
        }
        break parseField
      }

      // 引号字段。
      line = line.slice(1)
      for (;;) {
        const quote = line.indexOf('"')
        if (quote >= 0) {
          record += line.slice(0, quote)
          line = line.slice(quote + 1)
          const rn = line.length > 0 ? (line.codePointAt(0) ?? RUNE_ERROR) : RUNE_ERROR
          if (rn === QUOTE) {
            // `""` → 一个字面量引号。
            record += '"'
            line = line.slice(1)
          } else if (rn === COMMA) {
            // `",` → 字段结束。
            line = line.slice(1)
            fieldEnds.push(record.length)
            continue parseField
          } else if (line === '\n' || line.length === 0) {
            // `"` 后紧跟行尾或输入末尾 → 记录结束。
            fieldEnds.push(record.length)
            break parseField
          } else {
            return { kind: 'error', error: { code: 'quote', line: recordLine } }
          }
        } else if (line.length > 0) {
          // 行内没有闭合引号：把当前行（含 \n）并入字段，继续读下一行。
          record += line
          const next = this.readLine()
          line = next.line
          // Go：引号字段内读到的 io.EOF 会被归一为 nil，留给下一轮判「突然结束」。
          if (next.eof) line = ''
        } else {
          // 输入在引号字段内突然结束。
          return { kind: 'error', error: { code: 'unclosed', line: recordLine } }
        }
      }
    }

    const fields: string[] = []
    let prev = 0
    for (const end of fieldEnds) {
      fields.push(record.slice(prev, end))
      prev = end
    }
    return { kind: 'record', fields }
  }
}

/**
 * 判断字段是否需要加引号（Go `Writer.fieldNeedsQuotes`）。
 *
 * 规则：空串不加引号；字面量 `\.` 加引号（Postgres COPY 兼容）；含逗号、
 * 双引号、CR、LF 加引号；行首码点是 `unicode.IsSpace` 时加引号。
 * 刻意不写 JS 正则字面量（领域层正则统一走 RE2 封装，此处也用不上）。
 */
export function fieldNeedsQuotes(field: string): boolean {
  if (field === '') return false
  if (field === '\\.') return true
  if (field.includes(',') || field.includes('\n') || field.includes('\r') || field.includes('"')) {
    return true
  }
  const first = field.codePointAt(0) ?? 0
  return isSpace(first)
}

/** 按 Go `Writer.Write` 的规则转义单个字段。 */
export function quoteCsvField(field: string): string {
  if (!fieldNeedsQuotes(field)) return field
  let escaped = ''
  for (const ch of field) {
    escaped += ch === '"' ? '""' : ch
  }
  return `"${escaped}"`
}

/** 把一组字段序列化为一行（含行尾 `\n`）。 */
export function csvLine(fields: readonly string[]): string {
  return `${fields.map(quoteCsvField).join(',')}\n`
}

/**
 * 把条目序列化为完整 CSV（表头 + 每行，行尾 `\n`）。
 *
 * 顺序即传入顺序（调用方保证是内部顺序：`source` 字节长度降序），
 * 与 Go `Save` 写出的字节完全一致。
 */
export function serializeCSV(
  entries: ReadonlyArray<{
    source: string
    target: string
    caseSensitive: boolean
    forbidden: boolean
    mandatory: boolean
    notes: string
  }>,
): string {
  let out = csvLine(CSV_HEADER)
  for (const e of entries) {
    out += csvLine([
      e.source,
      e.target,
      e.caseSensitive ? 'true' : 'false',
      e.forbidden ? 'true' : 'false',
      e.mandatory ? 'true' : 'false',
      e.notes,
    ])
  }
  return out
}
