/**
 * 译文片段 XML 结构合法性判定（对应 Go `backend/internal/markup/fragment.go`）。
 *
 * 存在理由：EPUB 渲染把译文原样粘进 XHTML 文档，随后对整章做严格 XML 校验。
 * 单个段落的译文只要结构损坏（标签未闭合、嵌套交错、裸 `&` 等），整章校验就会
 * 失败并被降级为原文复制——一个坏段毒死整章。本模块把「能否安全嵌入」抽成可复用
 * 判定，供导出预检、渲染端单段容错与 QA 共用同一口径。
 *
 * **为什么手写扫描器**：Go 用的是 `encoding/xml` 的 Strict 解析器；领域层禁止 DOM
 * API（`DOMParser` 不可用），因此这里实现一个纯 TypeScript 的严格 XML 片段扫描器，
 * 逐条对齐 Go 的接受集合与错误文案（黄金向量 `__fixtures__/markup.json` 对拍）。
 */
import { compile, matchString } from '../shared/re2'

/** 校验时包裹片段的合成根元素名（与 Go `fragmentRoot` 一致）。 */
const FRAGMENT_ROOT = 'lf-fragment'

/**
 * 探测文本中是否存在 XML / HTML 标签（与 Go `tagRe` 同源）。
 *
 * 与 `protect.xmlTagRe` 刻意保持一致：本包服务于结构判定，protect 服务于保护区切分，
 * 职责不同但标签形态口径必须一致。
 */
const tagRe = compile('</?[A-Za-z][A-Za-z0-9:-]*(?:\\s+[^<>]*)?/?>')

/**
 * 「renderer 把译文原样嵌入 XML 文档」的格式集合。
 *
 * 只有 epub 的 `renderXHTML` 直接把译文字节写进 XHTML 元素内容、随后严格校验整章。
 * docx 用宽松 decoder 转义后写入 `<w:t>`，坏译文最多丢格式；html / markdown /
 * text / subtitle / jsonp 的译文按字节区间或行号直通、或经序列化器转义。
 */
const XML_FRAGMENT_FORMATS = new Set(['epub'])

/**
 * 报告该格式的 renderer 是否把译文原样嵌入 XML 文档，即译文是否必须是
 * well-formed 片段（对应 Go `RequiresWellFormedTargets`）。
 *
 * 归一化与 Go 一致：`strings.ToLower(strings.TrimSpace(format))`。
 */
export function requiresWellFormedTargets(format: string): boolean {
  // Go 的 strings.TrimSpace 使用 unicode.IsSpace；JS 的 trim() 额外包含 U+FEFF，
  // 但格式名只可能是 ASCII，两种语义在此无差异。
  return XML_FRAGMENT_FORMATS.has(format.trim().toLowerCase())
}

/** XML 语法错误（对应 Go `*xml.SyntaxError` 的格式化结果）。 */
class XmlSyntaxError extends Error {
  constructor(
    readonly msg: string,
    readonly line: number,
  ) {
    super(`XML syntax error on line ${line}: ${msg}`)
  }
}

/** XML 名称起始字符：字母 / `_` / `:`（Unicode 字母与 Go 的 isName 主集合一致）。 */
const NAME_START_RE = /[\p{L}_:]/u

/** XML 名称后续字符：字母 / 数字 / `.` / `-` / `_` / `:` / 组合记号。 */
const NAME_CHAR_RE = /[\p{L}\p{Nd}\p{Mn}\p{Mc}._:\-\u00B7]/u

/** 预定义 XML 实体（`encoding/xml` 只认这 5 个具名实体）。 */
const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

/** 判定码点是否落在 XML Char 允许范围（Go `isInCharacterRange`）。 */
function isXmlChar(cp: number): boolean {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return true
  if (cp >= 0x20 && cp <= 0xd7ff) return true
  if (cp >= 0xe000 && cp <= 0xfffd) return true
  if (cp >= 0x10000 && cp <= 0x10ffff) return true
  return false
}

/** 格式化非法码点，等价 Go 的 `fmt.Sprintf("U+%04X")`。 */
function formatCodePoint(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
}

/**
 * 严格 XML 片段扫描器。
 *
 * 只负责判定良构性（与 Go `xml.Decoder.Token()` 循环同口径），不构建树、不产出内容。
 * 错误文案逐条对齐 Go 的 `*xml.SyntaxError`。
 */
class FragmentScanner {
  private pos = 0
  private readonly stack: string[] = []

  constructor(
    private readonly text: string,
    private readonly root: string,
  ) {}

  /** 执行完整扫描；遇到语法错误时抛出 {@link XmlSyntaxError}。 */
  scan(): void {
    // 合成根的起始标签由构造侧固定生成，直接跳过并视为已打开；片段内容从其
    // 之后开始扫描，末尾的 `</lf-fragment>` 由结束标签逻辑正常闭合。
    this.pos = `<${this.root}>`.length
    this.stack.push(this.root)
    while (this.pos < this.text.length) {
      if (this.text[this.pos] === '<') {
        this.scanMarkup()
      } else {
        this.scanCharData()
      }
    }
    if (this.stack.length > 0) {
      // 合成根未闭合：正常路径不会发生（根闭标签一定会被扫描到）。
      throw this.error('unexpected EOF')
    }
  }

  /** 当前偏移所在行号（1 基）。Go 只按 `\n` 计行。 */
  private get line(): number {
    let line = 1
    for (let i = 0; i < this.pos && i < this.text.length; i++) {
      if (this.text.charCodeAt(i) === 0x0a) line++
    }
    return line
  }

  private error(msg: string): XmlSyntaxError {
    return new XmlSyntaxError(msg, this.line)
  }

  private startsWith(s: string): boolean {
    return this.text.startsWith(s, this.pos)
  }

  /** 消费 `<…>` 形态的标记。 */
  private scanMarkup(): void {
    if (this.startsWith('<!--')) {
      this.scanComment()
      return
    }
    if (this.startsWith('<![CDATA[')) {
      this.scanCDATA()
      return
    }
    if (this.startsWith('<!')) {
      this.scanDirective()
      return
    }
    if (this.startsWith('<?')) {
      this.scanProcInst()
      return
    }
    if (this.startsWith('</')) {
      this.scanEndTag()
      return
    }
    this.scanStartTag()
  }

  /** `<!-- … -->`；`--` 不得出现在注释内容中（与 Go 一致）。 */
  private scanComment(): void {
    this.pos += '<!--'.length
    for (;;) {
      if (this.pos >= this.text.length) {
        throw this.error('unexpected EOF')
      }
      if (this.startsWith('-->')) {
        this.pos += '-->'.length
        return
      }
      if (this.startsWith('--')) {
        // Go 的注释扫描器逐字符推进：任何不构成结束符的 "--" 都判非法。
        throw this.error('invalid sequence "--" not allowed in comments')
      }
      this.pos++
    }
  }

  /** `<![CDATA[ … ]]>`；内容原样作为字符数据。 */
  private scanCDATA(): void {
    this.pos += '<![CDATA['.length
    const close = this.text.indexOf(']]>', this.pos)
    if (close < 0) {
      this.pos = this.text.length
      throw this.error('unexpected EOF in CDATA section')
    }
    this.pos = close + ']]>'.length
  }

  /** `<!DOCTYPE …>` 等指令：读取到第一个 `>`。 */
  private scanDirective(): void {
    const close = this.text.indexOf('>', this.pos + '<!'.length)
    if (close < 0) {
      this.pos = this.text.length
      throw this.error('unexpected EOF')
    }
    this.pos = close + 1
  }

  /** `<?target …?>` 处理指令：读取到 `?>`。 */
  private scanProcInst(): void {
    this.pos += '<?'.length
    const close = this.text.indexOf('?>', this.pos)
    if (close < 0) {
      this.pos = this.text.length
      throw this.error('unexpected EOF')
    }
    this.pos = close + '?>'.length
  }

  /** 读取一个 XML 名称；调用方保证当前字符是合法起始字符。 */
  private readName(): string {
    const start = this.pos
    while (this.pos < this.text.length) {
      const ch = String.fromCodePoint(this.text.codePointAt(this.pos) ?? 0)
      const cp = ch.codePointAt(0) ?? 0
      if (ch.length > 1) {
        // 代理对：仅当属于字母类才继续。
        if (!NAME_CHAR_RE.test(ch) || cp === 0) break
        this.pos += ch.length
        continue
      }
      if (!NAME_CHAR_RE.test(ch)) break
      this.pos += 1
    }
    if (this.pos === start) {
      throw this.error('expected element name after <')
    }
    return this.text.slice(start, this.pos)
  }

  /** 跳过空白（Go 扫描器只认 `\t`、`\n`、`\r`、` `）。 */
  private skipSpaces(): void {
    while (this.pos < this.text.length) {
      const c = this.text[this.pos]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') this.pos++
      else break
    }
  }

  /** 起始标签 `<name attr="v" …>` / `<name/>`。 */
  private scanStartTag(): void {
    this.pos++ // '<'
    if (this.pos >= this.text.length) {
      throw this.error('unexpected EOF')
    }
    const first = String.fromCodePoint(this.text.codePointAt(this.pos) ?? 0)
    if (!NAME_START_RE.test(first)) {
      throw this.error('expected element name after <')
    }
    const name = this.readName()
    for (;;) {
      this.skipSpaces()
      if (this.pos >= this.text.length) {
        throw this.error('unexpected EOF')
      }
      const c = this.text[this.pos]
      if (c === '>') {
        this.pos++
        this.stack.push(name)
        return
      }
      if (c === '/') {
        if (this.text[this.pos + 1] !== '>') {
          throw this.error('expected /> in element')
        }
        this.pos += 2
        return // 空元素：不压栈
      }
      if (c === '<') {
        throw this.error('expected attribute name in element')
      }
      // 属性名
      const attrFirst = String.fromCodePoint(this.text.codePointAt(this.pos) ?? 0)
      if (!NAME_START_RE.test(attrFirst)) {
        throw this.error('expected attribute name in element')
      }
      this.readName()
      this.skipSpaces()
      if (this.text[this.pos] !== '=') {
        throw this.error('attribute name without = in element')
      }
      this.pos++
      this.skipSpaces()
      const quote = this.text[this.pos]
      if (quote !== '"' && quote !== "'") {
        throw this.error('unquoted or missing attribute value in element')
      }
      this.pos++
      this.scanAttrValue(quote)
    }
  }

  /** 扫描引号内的属性值，校验实体与裸 `<`。 */
  private scanAttrValue(quote: string): void {
    for (;;) {
      if (this.pos >= this.text.length) {
        throw this.error('unexpected EOF')
      }
      const c = this.text[this.pos]
      if (c === quote) {
        this.pos++
        return
      }
      if (c === '<') {
        throw this.error('unescaped < inside quoted string')
      }
      if (c === '&') {
        this.scanEntity()
        continue
      }
      this.pos++
    }
  }

  /** 结束标签 `</name>`。 */
  private scanEndTag(): void {
    this.pos += '</'.length
    const first = String.fromCodePoint(this.text.codePointAt(this.pos) ?? 0)
    if (!NAME_START_RE.test(first)) {
      throw this.error('expected element name after <')
    }
    const name = this.readName()
    this.skipSpaces()
    if (this.pos >= this.text.length) {
      throw this.error('unexpected EOF')
    }
    if (this.text[this.pos] !== '>') {
      throw this.error(`invalid characters between </${name} and >`)
    }
    this.pos++
    if (this.stack.length === 0) {
      throw this.error(`unexpected end element </${name}>`)
    }
    const open = this.stack[this.stack.length - 1] as string
    if (open !== name) {
      throw this.error(`element <${open}> closed by </${name}>`)
    }
    this.stack.pop()
  }

  /** 字符数据：校验裸 `&`、非法字符与 `]]>`。 */
  private scanCharData(): void {
    const start = this.pos
    while (this.pos < this.text.length && this.text[this.pos] !== '<') {
      const c = this.text[this.pos]
      if (c === '&') {
        this.scanEntity()
        continue
      }
      if (c === ']' && this.startsWith(']]>')) {
        throw this.error('unescaped ]]> not in CDATA section')
      }
      const cp = this.text.codePointAt(this.pos) ?? 0
      if (!isXmlChar(cp)) {
        throw this.error(`illegal character code ${formatCodePoint(cp)}`)
      }
      this.pos += cp > 0xffff ? 2 : 1
    }
    if (this.pos === start) {
      // 防御：不应发生（调用方仅在非 '<' 时进入）。
      throw this.error('unexpected EOF')
    }
  }

  /** 扫描并校验一个实体引用（`&name;` / `&#123;` / `&#x1F;`）。 */
  private scanEntity(): void {
    const start = this.pos
    this.pos++ // '&'
    if (this.text[this.pos] === '#') {
      this.pos++
      const hex = this.text[this.pos] === 'x' || this.text[this.pos] === 'X'
      if (hex) this.pos++
      const digitsStart = this.pos
      const digitRe = hex ? /[0-9A-Fa-f]/ : /[0-9]/
      while (this.pos < this.text.length && digitRe.test(this.text[this.pos] as string)) {
        this.pos++
      }
      if (this.pos === digitsStart) {
        // Go 报错时带上完整的实体字面量（含结尾分号，若存在）。
        const semi = this.text.indexOf(';', start)
        const literal = semi >= 0 ? this.text.slice(start, semi + 1) : this.text.slice(start)
        throw this.error(`invalid character entity ${literal}`)
      }
      if (this.text[this.pos] !== ';') {
        const literal = this.text.slice(start, this.pos)
        throw this.error(`invalid character entity ${literal} (no semicolon)`)
      }
      const literal = this.text.slice(digitsStart, this.pos)
      this.pos++ // ';'
      const cp = Number.parseInt(literal, hex ? 16 : 10)
      if (!Number.isFinite(cp) || cp > 0x10ffff) {
        // 超出 Unicode 码点范围：Go 判为实体本身非法（而非字符码点非法）。
        const raw = this.text.slice(start, this.pos)
        throw this.error(`invalid character entity ${raw}`)
      }
      if (!isXmlChar(cp)) {
        throw this.error(`illegal character code ${formatCodePoint(cp)}`)
      }
      return
    }
    const nameStart = this.pos
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos] as string
      if (!/[A-Za-z0-9_.:-]/.test(ch)) break
      this.pos++
    }
    const name = this.text.slice(nameStart, this.pos)
    if (this.text[this.pos] !== ';') {
      throw this.error(`invalid character entity &${name} (no semicolon)`)
    }
    this.pos++ // ';'
    if (!Object.prototype.hasOwnProperty.call(XML_ENTITIES, name)) {
      throw this.error(`invalid character entity &${name};`)
    }
  }
}

/**
 * 把扫描器错误转成可直接展示给用户的说明（对应 Go `fragmentError`）。
 *
 * 解码器站在合成根的视角描述未闭合/游离闭标签，直接透出会让用户以为译文里真有
 * `lf-fragment` 标签；这两类归一为中文文案，其余形态原样透出（与 Go 一致）。
 */
function normalizeError(msg: string): string {
  const unclosedMarker = ` closed by </${FRAGMENT_ROOT}>`
  const elementMarker = 'element <'
  const elementAt = msg.indexOf(elementMarker)
  if (elementAt >= 0 && msg.endsWith(unclosedMarker)) {
    let name = msg.slice(elementAt + elementMarker.length, msg.length - unclosedMarker.length)
    if (name.endsWith('>')) name = name.slice(0, -1)
    return `标签 <${name}> 未闭合`
  }
  const strayMarker = `element <${FRAGMENT_ROOT}> closed by </`
  const strayAt = msg.indexOf(strayMarker)
  if (strayAt >= 0 && msg.endsWith('>')) {
    const name = msg.slice(strayAt + strayMarker.length, msg.length - 1)
    return `多余的闭标签 </${name}>`
  }
  return msg
}

/**
 * 报告 `s` 能否作为 well-formed XML 片段嵌入 XHTML 元素内容
 * （对应 Go `ValidateFragment`）。返回 `null` 表示合法，否则返回错误文案。
 *
 * 判定口径与 EPUB 渲染后的整章严格校验逐字一致：Strict 模式、不开 AutoClose、
 * 不注入 HTML 实体表。因此以下写法一律判为非法：
 * - 未闭合标签：`<ruby>基底<rt>注音</rt>`
 * - 交错嵌套：`<ruby>a<rt>b</ruby></rt>`
 * - HTML 空元素简写：`<br>`（XHTML 须写 `<br />`）
 * - 裸 `&` 与未定义实体：`A & B`、`&nbsp;`
 */
export function validateFragment(s: string): string | null {
  if (s === '') return null
  const raw = rawWellFormedError(s, FRAGMENT_ROOT)
  return raw === null ? null : normalizeError(raw)
}

/**
 * 以指定合成根包裹并扫描，返回 **Go 原生** 错误文案（XML syntax error on line N: …），
 * 合法时返回 `null`。
 *
 * 供需要与 Go 逐字对拍或需要保留合成根名的调用方使用（如 ruby 的
 * buildTranslationRegions 用 lf-ruby-view 根）；`ValidateFragment` 则在其上
 * 再做中文文案归一。
 */
export function rawWellFormedError(s: string, root: string): string | null {
  const doc = `<${root}>${s}</${root}>`
  try {
    new FragmentScanner(doc, root).scan()
    return null
  } catch (err) {
    if (err instanceof XmlSyntaxError) return err.message
    return String(err)
  }
}

/**
 * 报告译文相对原文是否发生标签结构退化（对应 Go `TargetRegression`）。
 *
 * 三重门禁同时成立才判违规：
 * 1. `source` 含至少一个标签——纯文本格式的 target 里出现的 `<color=red>` 之类
 *    非标签尖括号不受约束；
 * 2. `source` 自身是合法片段——遗留数据的 source 可能在提取期就已非法，此时无法
 *    要求译文比原文更严格；
 * 3. `target` 不是合法片段。
 *
 * 返回 `null` 表示未退化。
 */
export function targetRegression(source: string, target: string): string | null {
  if (!matchString(tagRe, source)) return null
  if (validateFragment(source) !== null) return null
  return validateFragment(target)
}
