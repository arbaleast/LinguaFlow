/**
 * Go `text/template` 的解析器（TypeScript 移植）。
 *
 * 解析分两步：
 *
 * 1. **切分**：把模板切成「文本段」与「动作段」，并处理 Go 的空白裁剪标记
 *    （`{{-` / `-}}`，语义与 Go 完全一致，见 `trimText`）。
 * 2. **解析动作**：对每个动作的表达式做递归下降解析，产出 AST。
 *
 * Go 的空白裁剪规则（已用 Go 1.27 实测确认）：
 *
 * - **左裁剪** `{{-`：紧跟 `{{` 之后必须是 `-`，且 `-` 之后必须是空白字符；
 *   效果是把**前一段文本的尾部空白**全部去掉。
 * - **右裁剪** `-}}`：`-` 必须紧邻 `}}`，且 `-` 之前必须是空白字符；
 *   效果是把**后一段文本的头部空白**全部去掉。
 * - `-` 紧跟 `{{` 但其后不是空白（如 `{{-.X}}`）在 Go 里是**解析错误**；
 *   同理 `-}}` 前的 `-` 不紧邻 `}}` 也是解析错误。本移植同样报解析错误。
 *
 * 空白集合使用 Go 的 `unicode.IsSpace`（见 `domain/shared/unicode.ts`），
 * 与 Go 模板引擎一致（实测：制表符、换行、垂直制表符均会被裁剪）。
 */
import { isSpace } from '../../shared/unicode'
import {
  TemplateError,
  type ActionNode,
  type Arg,
  type BoolArg,
  type ChainArg,
  type Command,
  type DotArg,
  type FieldArg,
  type IdentifierArg,
  type IfNode,
  type ListNode,
  type NilArg,
  type NumberArg,
  type PipeArg,
  type Pipeline,
  type RangeNode,
  type StringArg,
  type TemplateNode,
  type VariableArg,
  type VariableDecl,
  type WithNode,
} from './types'

/** 分支体（`if` / `with` / `range` 的列表）的停止关键字集合。 */
const BRANCH_STOP: ReadonlySet<string> = new Set(['end', 'else', 'else if'])

/** 提取动作的首个关键字（`if` / `end` / `else if` / ...）。 */
function actionKeyword(action: string): string {
  return action.split(/\s+/)[0] ?? ''
}

/** 解析入口：把模板文本解析为节点树。 */
export function parseTemplate(source: string): ListNode {
  const segments = splitTemplate(source)
  const parser = new TemplateParser(segments)
  return parser.parseList(null)
}

/** 模板段：文本或动作。 */
interface Segment {
  text?: string
  action?: string
  /** 该段是否裁剪前一段的尾部空白（左裁剪）。 */
  trimLeft?: boolean
  /** 该段是否裁剪后一段的头部空白（右裁剪）。 */
  trimRight?: boolean
}

/**
 * 把模板切成文本段与动作段，并标记裁剪标记。
 *
 * 动作段的原始文本保留 `{{` / `}}` 之间的内容（含裁剪标记的 `-`）。
 */
function splitTemplate(source: string): Segment[] {
  const segments: Segment[] = []
  let pos = 0

  while (pos < source.length) {
    const open = source.indexOf('{{', pos)
    if (open === -1) {
      segments.push({ text: source.slice(pos) })
      break
    }
    if (open > pos) {
      segments.push({ text: source.slice(pos, open) })
    }
    // 找到动作结束位置（支持字符串字面量内的 `}}`）。
    const close = findActionEnd(source, open + 2)
    if (close === -1) {
      throw new TemplateError('unclosed action')
    }
    let body = source.slice(open + 2, close)
    let trimLeft = false
    let trimRight = false

    // 左裁剪：`{{-` 且 `-` 之后是空白。
    if (body.startsWith('-')) {
      const after = body[1]
      if (after === undefined || !isSpace(after.codePointAt(0) ?? 0)) {
        throw new TemplateError('bad number syntax: "-"')
      }
      trimLeft = true
      body = body.slice(1)
    }
    // 右裁剪：`-}}` 且 `-` 之前是空白（Go 要求减号紧邻 `}}`）。
    if (body.endsWith('-')) {
      const before = body[body.length - 2]
      if (before === undefined || !isSpace(before.codePointAt(0) ?? 0)) {
        throw new TemplateError("bad character U+002D '-'")
      }
      trimRight = true
      body = body.slice(0, -1)
    }

    segments.push({ action: body, trimLeft, trimRight })
    pos = close + 2
  }

  return applyTrim(segments)
}

/**
 * 定位动作的结束 `}}`。
 *
 * 需要跳过字符串字面量里的 `}}`（例如 `{{"}}"}}`）。
 */
function findActionEnd(source: string, from: number): number {
  let i = from
  while (i < source.length) {
    const ch = source[i]
    if (ch === '"' || ch === '`') {
      const quote = ch
      i++
      while (i < source.length) {
        if (quote === '"' && source[i] === '\\') {
          i += 2
          continue
        }
        if (source[i] === quote) {
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === '}' && source[i + 1] === '}') {
      return i
    }
    i++
  }
  return -1
}

/** 按 Go 的规则应用空白裁剪。 */
function applyTrim(segments: Segment[]): Segment[] {
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] as Segment
    if (seg.trimLeft) {
      const prev = segments[i - 1]
      if (prev && prev.text !== undefined) {
        prev.text = trimRightWhitespace(prev.text)
      }
    }
    if (seg.trimRight) {
      const next = segments[i + 1]
      if (next && next.text !== undefined) {
        next.text = trimLeftWhitespace(next.text)
      }
    }
  }
  return segments
}

/** 去掉尾部空白（Go `unicode.IsSpace` 集合）。 */
function trimRightWhitespace(text: string): string {
  let end = text.length
  while (end > 0) {
    const cp = text.codePointAt(end - 1) ?? 0
    if (!isSpace(cp)) break
    end -= cp > 0xffff ? 2 : 1
  }
  return text.slice(0, end)
}

/** 去掉头部空白（Go `unicode.IsSpace` 集合）。 */
function trimLeftWhitespace(text: string): string {
  let start = 0
  while (start < text.length) {
    const cp = text.codePointAt(start) ?? 0
    if (!isSpace(cp)) break
    start += cp > 0xffff ? 2 : 1
  }
  return text.slice(start)
}

/** 模板解析器（递归下降）。 */
class TemplateParser {
  private index = 0

  constructor(private readonly segments: Segment[]) {}

  /**
   * 解析节点列表。
   *
   * @param stop 遇到这些关键字时停止（`end` / `else` / `else if`）；`null` 表示解析到末尾，
   *   此时遇到 `end` / `else` 属于语法错误（Go 同样报 `unexpected {{...}}`）。
   */
  parseList(stop: ReadonlySet<string> | null): ListNode {
    const nodes: TemplateNode[] = []
    while (this.index < this.segments.length) {
      const seg = this.segments[this.index] as Segment
      if (seg.text !== undefined) {
        this.index++
        if (seg.text !== '') {
          nodes.push({ kind: 'text', text: seg.text })
        }
        continue
      }
      const action = (seg.action ?? '').trim()
      if (action === '') {
        this.index++
        continue
      }
      const keyword = actionKeyword(action)
      if (stop !== null && stop.has(keyword)) break
      if (keyword === 'if' || keyword === 'with' || keyword === 'range') {
        nodes.push(this.parseBranch(keyword, action))
        continue
      }
      if (keyword === 'end' || keyword === 'else' || keyword === 'else if') {
        throw new TemplateError(`unexpected {{${keyword}}}`)
      }
      this.index++
      nodes.push(this.parseAction(action))
    }
    return { kind: 'list', nodes }
  }

  /** 解析 `if` / `with` / `range` 分支（含 `else` / `else if`，消费至对应的 `end`）。 */
  private parseBranch(keyword: string, action: string): TemplateNode {
    this.index++ // 消费分支起始动作
    const pipe = parsePipeline(action.slice(keyword.length))
    // 分支体在 `end` / `else` / `else if` 处结束。
    const list = this.parseList(BRANCH_STOP)
    const stopSeg = this.segments[this.index]
    const stopAction = (stopSeg?.action ?? '').trim()
    let elseList: ListNode | null = null

    if (stopAction.startsWith('else if')) {
      // `else if` 在 Go 里是嵌套的 if 分支（自带 end）。
      // parseBranch 自行消费该段，此处不得重复递增。
      const nested = this.parseBranch('if', stopAction.slice('else'.length).trim())
      elseList = { kind: 'list', nodes: [nested] }
      return this.buildBranch(keyword, pipe, list, elseList)
    }
    if (stopAction === 'else') {
      this.index++
      elseList = this.parseList(BRANCH_STOP)
      const endSeg = this.segments[this.index]
      const endAction = (endSeg?.action ?? '').trim()
      if (endAction !== 'end') {
        throw new TemplateError(`unexpected {{${endAction || 'EOF'}}}: missing {{end}}`)
      }
      this.index++ // 消费 end
    } else if (stopAction === 'end') {
      this.index++ // 消费 end
    } else {
      throw new TemplateError(`unexpected EOF: missing {{end}} for {{${keyword}}}`)
    }
    return this.buildBranch(keyword, pipe, list, elseList)
  }

  /** 构造分支节点。 */
  private buildBranch(
    keyword: string,
    pipe: Pipeline,
    list: ListNode,
    elseList: ListNode | null,
  ): TemplateNode {
    if (keyword === 'if') {
      const node: IfNode = { kind: 'if', pipe, list, elseList }
      return node
    }
    if (keyword === 'range') {
      const node: RangeNode = { kind: 'range', pipe, list, elseList }
      return node
    }
    const node: WithNode = { kind: 'with', pipe, list, elseList }
    return node
  }

  /** 解析动作节点。 */
  private parseAction(action: string): ActionNode {
    return { kind: 'action', pipe: parsePipeline(action) }
  }
}

/** 解析管道（`$x := a | b`）。 */
export function parsePipeline(text: string): Pipeline {
  const tokens = tokenize(text)
  const parser = new ExprParser(tokens)
  return parser.parsePipeline()
}

/** 词法记号。 */
type Token =
  | { kind: 'ident'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'variable'; value: string }

/** 把表达式文本切成记号。 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i] as string
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\v' || ch === '\f') {
      i++
      continue
    }
    if (ch === '"' || ch === '`') {
      const quote = ch
      i++
      let value = ''
      while (i < text.length) {
        const c = text[i] as string
        if (quote === '"' && c === '\\') {
          const next = text[i + 1] ?? ''
          value += unescapeChar(next)
          i += 2
          continue
        }
        if (c === quote) {
          i++
          break
        }
        value += c
        i++
      }
      tokens.push({ kind: 'string', value })
      continue
    }
    if (ch === '$') {
      i++
      let name = ''
      while (i < text.length && isIdentChar(text[i] as string)) {
        name += text[i]
        i++
      }
      tokens.push({ kind: 'variable', value: name })
      continue
    }
    if (isDigit(ch) || (ch === '-' && isDigit(text[i + 1] ?? ''))) {
      const start = i
      if (ch === '-') i++
      while (i < text.length && (isDigit(text[i] as string) || text[i] === '.')) i++
      const raw = text.slice(start, i)
      tokens.push({ kind: 'number', value: Number(raw) })
      continue
    }
    if (isIdentStart(ch)) {
      let name = ''
      while (i < text.length && isIdentChar(text[i] as string)) {
        name += text[i]
        i++
      }
      tokens.push({ kind: 'ident', value: name })
      continue
    }
    if (ch === ':' && text[i + 1] === '=') {
      // Go 的 `:=` 声明符号（词法上合并为单记号）。
      tokens.push({ kind: 'punct', value: ':=' })
      i += 2
      continue
    }
    if (ch === '(' || ch === ')' || ch === '|' || ch === ':' || ch === '=' || ch === ',') {
      tokens.push({ kind: 'punct', value: ch })
      i++
      continue
    }
    if (ch === '.') {
      tokens.push({ kind: 'punct', value: '.' })
      i++
      continue
    }
    throw new TemplateError(
      `bad character U+${ch.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0')} '${ch}'`,
    )
  }
  return tokens
}

/** 处理转义字符。 */
function unescapeChar(ch: string): string {
  switch (ch) {
    case 'n':
      return '\n'
    case 't':
      return '\t'
    case 'r':
      return '\r'
    case '\\':
      return '\\'
    case '"':
      return '"'
    case "'":
      return "'"
    default:
      return ch
  }
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_'
}

function isIdentChar(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch)
}

/** 表达式解析器。 */
class ExprParser {
  private pos = 0

  constructor(private readonly tokens: Token[]) {}

  /** 解析管道。 */
  parsePipeline(): Pipeline {
    const decls: VariableDecl[] = []
    // 变量声明：`$x := ...`、`$x = ...` 或 `$i, $v := ...`。
    for (;;) {
      const save = this.pos
      const decl = this.tryParseDecl()
      if (!decl) {
        this.pos = save
        break
      }
      decls.push(...decl)
    }

    const cmds: Command[] = []
    for (;;) {
      const cmd = this.parseCommand()
      cmds.push(cmd)
      if (this.peekPunct('|')) {
        this.pos++
        continue
      }
      break
    }
    return { decls, cmds }
  }

  /** 尝试解析变量声明（`$x := ...` / `$x = ...` / `$i, $v := ...`）。 */
  private tryParseDecl(): VariableDecl[] | null {
    const vars: string[] = []
    let pos = this.pos
    for (;;) {
      const tok = this.tokens[pos]
      if (!tok || tok.kind !== 'variable') return null
      vars.push(tok.value)
      pos++
      // `$a, $b := ...`：逗号分隔的多个变量。
      const comma = this.tokens[pos]
      if (comma && comma.kind === 'punct' && comma.value === ',') {
        pos++
        continue
      }
      break
    }
    const assign = this.tokens[pos]
    if (!assign || assign.kind !== 'punct') return null
    if (assign.value === ':=') {
      this.pos = pos + 1
      return vars.map((name) => ({ name, isDeclare: true }))
    }
    if (assign.value === '=') {
      this.pos = pos + 1
      return vars.map((name) => ({ name, isDeclare: false }))
    }
    return null
  }

  /** 解析命令。 */
  private parseCommand(): Command {
    const args: Arg[] = []
    for (;;) {
      const arg = this.parseArg()
      if (!arg) break
      args.push(arg)
      if (this.peekPunct('|') || this.peekPunct(')')) break
    }
    if (args.length === 0) {
      throw new TemplateError('missing value for command')
    }
    return { args }
  }

  /** 解析单个参数。 */
  private parseArg(): Arg | null {
    const tok = this.peek()
    if (!tok) return null
    if (tok.kind === 'punct' && tok.value === '(') {
      this.pos++
      const pipe = this.parsePipeline()
      if (!this.peekPunct(')')) {
        throw new TemplateError('unclosed left paren')
      }
      this.pos++
      // `(pipeline).Field` 形式
      const path = this.parseFieldPath()
      if (path.length > 0) {
        const chain: ChainArg = { kind: 'chain', pipe, path }
        return chain
      }
      const pipeArg: PipeArg = { kind: 'pipe', pipe }
      return pipeArg
    }
    if (tok.kind === 'punct' && tok.value === '.') {
      this.pos++
      const path = this.parseFieldPath()
      const base: DotArg = { kind: 'dot' }
      const field: FieldArg = { kind: 'field', base, path }
      return field
    }
    if (tok.kind === 'variable') {
      this.pos++
      const path = this.parseFieldPath()
      const base: VariableArg = { kind: 'variable', name: tok.value }
      if (path.length === 0) {
        return base
      }
      const field: FieldArg = { kind: 'field', base, path }
      return field
    }
    if (tok.kind === 'string') {
      this.pos++
      const stringArg: StringArg = { kind: 'string', value: tok.value }
      return stringArg
    }
    if (tok.kind === 'number') {
      this.pos++
      const numberArg: NumberArg = { kind: 'number', value: tok.value }
      return numberArg
    }
    if (tok.kind === 'ident') {
      this.pos++
      if (tok.value === 'true' || tok.value === 'false') {
        const boolArg: BoolArg = { kind: 'bool', value: tok.value === 'true' }
        return boolArg
      }
      if (tok.value === 'nil') {
        const nilArg: NilArg = { kind: 'nil' }
        return nilArg
      }
      const identArg: IdentifierArg = { kind: 'identifier', name: tok.value }
      return identArg
    }
    return null
  }

  /** 解析字段路径（`.Foo.Bar` 的 `Foo.Bar` 部分）。 */
  private parseFieldPath(): Array<string | number> {
    const path: Array<string | number> = []
    for (;;) {
      const tok = this.peek()
      if (!tok) break
      if (tok.kind === 'ident') {
        path.push(tok.value)
        this.pos++
        continue
      }
      if (tok.kind === 'number') {
        path.push(tok.value)
        this.pos++
        continue
      }
      if (tok.kind === 'punct' && tok.value === '.') {
        this.pos++
        continue
      }
      break
    }
    return path
  }

  /** 查看当前记号。 */
  private peek(): Token | undefined {
    return this.tokens[this.pos]
  }

  /** 当前记号是否为指定标点。 */
  private peekPunct(value: string): boolean {
    const tok = this.peek()
    return !!tok && tok.kind === 'punct' && tok.value === value
  }
}
