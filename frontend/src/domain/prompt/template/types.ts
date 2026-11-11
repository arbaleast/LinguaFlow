/**
 * Go `text/template` 的 AST 类型（TypeScript 移植）。
 *
 * 只覆盖 LinguaFlow 提示词模板实际使用的语法子集，并按 Go 的语义实现：
 * `if` / `else if` / `else` / `end`、`range`（含 `$i, $v :=`）、`with`、
 * 变量声明与赋值、管道（`|`）、函数调用、字段链、字面量、括号表达式与注释。
 */

/** 模板节点。 */
export type TemplateNode = TextNode | ActionNode | IfNode | RangeNode | WithNode | ListNode

/** 纯文本节点。 */
export interface TextNode {
  kind: 'text'
  text: string
}

/** 动作节点：`{{ ... }}`。 */
export interface ActionNode {
  kind: 'action'
  pipe: Pipeline
}

/** 节点列表。 */
export interface ListNode {
  kind: 'list'
  nodes: TemplateNode[]
}

/** 条件分支节点。 */
export interface IfNode {
  kind: 'if'
  pipe: Pipeline
  list: ListNode
  elseList: ListNode | null
}

/** 区间节点。 */
export interface RangeNode {
  kind: 'range'
  pipe: Pipeline
  list: ListNode
  elseList: ListNode | null
}

/** `with` 节点。 */
export interface WithNode {
  kind: 'with'
  pipe: Pipeline
  list: ListNode
  elseList: ListNode | null
}

/** 管道：可选变量声明 + 一到多个命令。 */
export interface Pipeline {
  /** 变量声明（`$x := ...`）。 */
  decls: VariableDecl[]
  /** 命令序列（`a | b | c`）。 */
  cmds: Command[]
}

/** 变量声明。 */
export interface VariableDecl {
  /** 变量名（不含 `$`）。 */
  name: string
  /** `true` 表示 `:=`（声明），`false` 表示 `=`（赋值）。 */
  isDeclare: boolean
}

/** 命令：`func arg1 arg2` 或单个参数。 */
export interface Command {
  args: Arg[]
}

/** 参数。 */
export type Arg =
  | FieldArg
  | VariableArg
  | IdentifierArg
  | StringArg
  | NumberArg
  | BoolArg
  | NilArg
  | DotArg
  | PipeArg
  | ChainArg

/** 字段链：`.Foo.Bar`、`$x.Foo`、`$x.Map.Key`。 */
export interface FieldArg {
  kind: 'field'
  /** 基准：`.`（当前上下文）或某个变量。 */
  base: DotArg | VariableArg
  /** 字段路径（对象键或数组下标）。 */
  path: Array<string | number>
}

/** 变量：`$`（根）或 `$name`。 */
export interface VariableArg {
  kind: 'variable'
  name: string
}

/** 函数标识符（命令的第一个参数）。 */
export interface IdentifierArg {
  kind: 'identifier'
  name: string
}

/** 字符串字面量。 */
export interface StringArg {
  kind: 'string'
  value: string
}

/** 数字字面量。 */
export interface NumberArg {
  kind: 'number'
  value: number
}

/** 布尔字面量。 */
export interface BoolArg {
  kind: 'bool'
  value: boolean
}

/** `nil` 字面量。 */
export interface NilArg {
  kind: 'nil'
}

/** 当前上下文 `.`。 */
export interface DotArg {
  kind: 'dot'
}

/** 括号包裹的管道：`(pipeline)`。 */
export interface PipeArg {
  kind: 'pipe'
  pipe: Pipeline
}

/** 括号管道后接字段链：`(pipeline).Foo`。 */
export interface ChainArg {
  kind: 'chain'
  pipe: Pipeline
  path: Array<string | number>
}

/** 模板渲染错误。 */
export class TemplateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemplateError'
  }
}
