/**
 * Go `text/template` 的执行器（TypeScript 移植）。
 *
 * 语义要点（与 Go 对齐）：
 *
 * - `{{.Field}}`：字段访问；字段是**方法**（零参函数）时自动调用（Go 的 method 语义）。
 * - `{{if .X}}`：`false`、`0`、空字符串、空切片、空 map、`nil` 均为假（Go 的 `isTrue`）。
 * - `{{range .X}}`：遍历切片 / 数组 / map（按 key 升序）/ 整数（Go 1.22+ 支持 range over int）。
 *   `{{range $i, $v := .X}}` 同时绑定下标与元素。
 * - `{{with .X}}`：非假时把 `.` 切换为该值。
 * - `{{$x := ...}}` 声明变量，`{{$x = ...}}` 赋值；变量作用域为声明所在的作用域。
 * - 管道 `|`：前一个命令的输出作为后一个命令的**最后一个**参数。
 * - 函数：内置 `printf` / `print` / `println` / `eq` / `ne` / `lt` / `le` / `gt` / `ge` /
 *   `and` / `or` / `not` / `len` / `index` / `slice` / `call`，
 *   以及调用方注入的自定义函数（LinguaFlow 使用 `mul`）。
 */
import { formatValue, sprintf } from './format'
import {
  TemplateError,
  type Arg,
  type BoolArg,
  type ChainArg,
  type Command,
  type DotArg,
  type FieldArg,
  type IdentifierArg,
  type ListNode,
  type NilArg,
  type NumberArg,
  type PipeArg,
  type Pipeline,
  type RangeNode,
  type StringArg,
  type TemplateNode,
  type VariableArg,
  type WithNode,
} from './types'

/** 模板函数签名。 */
export type TemplateFunc = (...args: unknown[]) => unknown

/** 模板函数表。 */
export type FuncMap = Record<string, TemplateFunc>

/** 模板执行上下文。 */
export interface ExecContext {
  /** 根数据（`$`）。 */
  root: unknown
  /** 变量表（按作用域链）。 */
  vars: Map<string, unknown>
  /** 函数表。 */
  funcs: FuncMap
}

/** 渲染模板。 */
export function executeTemplate(list: ListNode, data: unknown, funcs: FuncMap = {}): string {
  const ctx: ExecContext = {
    root: data,
    vars: new Map(),
    funcs: { ...builtinFuncs(), ...funcs },
  }
  const out: string[] = []
  renderList(list, data, ctx, out)
  return out.join('')
}

/** 渲染节点列表（追加到 `sink`）。 */
function renderList(list: ListNode, dot: unknown, ctx: ExecContext, sink: string[]): void {
  for (const node of list.nodes) {
    renderNode(node, dot, ctx, sink)
  }
}

/** 渲染单个节点。 */
function renderNode(node: TemplateNode, dot: unknown, ctx: ExecContext, sink: string[]): void {
  switch (node.kind) {
    case 'text':
      sink.push(node.text)
      return
    case 'action': {
      const value = evalPipeline(node.pipe, dot, ctx)
      // Go 的变量声明动作不产生输出（`{{$x := .Y}}` 只赋值）。
      if (node.pipe.decls.length > 0) return
      if (value !== null && value !== undefined) {
        sink.push(formatValue(value))
      }
      return
    }
    case 'if': {
      const value = evalPipeline(node.pipe, dot, ctx)
      if (isTrue(value)) {
        renderList(node.list, dot, ctx, sink)
      } else if (node.elseList) {
        renderList(node.elseList, dot, ctx, sink)
      }
      return
    }
    case 'with': {
      const value = evalPipeline(node.pipe, dot, ctx)
      if (isTrue(value)) {
        const saved = ctx.vars
        ctx.vars = new Map(saved)
        renderList(node.list, value, ctx, sink)
        ctx.vars = saved
      } else if (node.elseList) {
        renderList(node.elseList, dot, ctx, sink)
      }
      return
    }
    case 'range': {
      renderRange(node, dot, ctx, sink)
      return
    }
    default:
      throw new TemplateError(`unknown node kind: ${(node as { kind: string }).kind}`)
  }
}

/** 渲染 `range` 节点。 */
function renderRange(node: RangeNode, dot: unknown, ctx: ExecContext, sink: string[]): void {
  const value = evalPipeline(node.pipe, dot, ctx)
  const saved = ctx.vars
  ctx.vars = new Map(saved)

  const entries = rangeEntries(value)
  if (entries.length === 0) {
    if (node.elseList) {
      renderList(node.elseList, dot, ctx, sink)
    }
    ctx.vars = saved
    return
  }

  const decls = node.pipe.decls
  for (const [index, element] of entries) {
    // Go 语义：单变量 `{{range $v := .X}}` 绑定**元素**；双变量 `{{$i, $v := .X}}` 才是下标+元素。
    if (decls.length === 1) {
      const only = decls[0] as { name: string }
      ctx.vars.set(only.name, element)
    } else if (decls.length >= 2) {
      const first = decls[0] as { name: string }
      ctx.vars.set(first.name, index)
      const second = decls[1] as { name: string }
      ctx.vars.set(second.name, element)
    }
    renderList(node.list, element, ctx, sink)
  }
  ctx.vars = saved
}

/** 构造 `range` 的迭代项。 */
function rangeEntries(value: unknown): Array<[unknown, unknown]> {
  if (value === null || value === undefined) return []
  if (typeof value === 'number' && Number.isInteger(value)) {
    // Go 1.22+ 支持 range over int。
    const out: Array<[unknown, unknown]> = []
    for (let i = 0; i < value; i++) out.push([i, i])
    return out
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => [index, item])
  }
  if (value instanceof Map) {
    return [...value.entries()].sort((a, b) => compareValues(a[0], b[0])).map(([k, v]) => [k, v])
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, v])
  }
  throw new TemplateError(`range can't iterate over value`)
}

/** 比较两个值（用于 map key 排序）。 */
function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const sa = String(a)
  const sb = String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

/** Go 的「真值」判定。 */
export function isTrue(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return value !== ''
  if (Array.isArray(value)) return value.length > 0
  if (value instanceof Map) return value.size > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

/** 求值管道。 */
function evalPipeline(pipe: Pipeline, dot: unknown, ctx: ExecContext): unknown {
  let value: unknown = undefined
  for (let i = 0; i < pipe.cmds.length; i++) {
    const cmd = pipe.cmds[i] as Command
    const isLast = i === pipe.cmds.length - 1
    value = evalCommand(cmd, dot, ctx, value, isLast)
  }
  // 变量声明在管道求值后统一处理（Go 的语义：声明的变量在管道内可见）。
  for (const decl of pipe.decls) {
    if (decl.isDeclare) {
      ctx.vars.set(decl.name, value)
    } else {
      ctx.vars.set(decl.name, value)
    }
  }
  return value
}

/**
 * 求值单个命令。
 *
 * @param piped 上一个命令的输出（作为本次命令的最后一个参数）。
 */
function evalCommand(
  cmd: Command,
  dot: unknown,
  ctx: ExecContext,
  piped: unknown,
  isLast: boolean,
): unknown {
  const args = cmd.args
  const first = args[0]

  // 变量声明本身是管道级语法，这里不应作为命令出现。
  if (first && first.kind === 'identifier') {
    const name = first.name
    const fn = ctx.funcs[name]
    if (!fn) {
      throw new TemplateError(`function "${name}" not defined`)
    }
    const rest = args.slice(1).map((arg) => evalArg(arg, dot, ctx))
    const callArgs = isLast && piped !== undefined ? [...rest, piped] : rest
    return fn(...callArgs)
  }

  const values = args.map((arg) => evalArg(arg, dot, ctx))
  if (isLast && piped !== undefined) {
    values.push(piped)
  }
  return values[0]
}

/** 求值单个参数。 */
function evalArg(arg: Arg, dot: unknown, ctx: ExecContext): unknown {
  switch (arg.kind) {
    case 'dot':
      return dot
    case 'variable': {
      if (arg.name === '') return ctx.root
      if (!ctx.vars.has(arg.name)) {
        throw new TemplateError(`undefined variable "${arg.name}"`)
      }
      return ctx.vars.get(arg.name)
    }
    case 'identifier': {
      const fn = ctx.funcs[arg.name]
      if (!fn) {
        throw new TemplateError(`function "${arg.name}" not defined`)
      }
      return fn()
    }
    case 'string':
      return arg.value
    case 'number':
      return arg.value
    case 'bool':
      return arg.value
    case 'nil':
      return null
    case 'field':
      return evalField(arg, dot, ctx)
    case 'pipe':
      return evalPipeline(arg.pipe, dot, ctx)
    case 'chain': {
      const base = evalPipeline(arg.pipe, dot, ctx)
      return resolvePath(base, arg.path, dot)
    }
    default:
      throw new TemplateError(`unknown argument kind`)
  }
}

/** 求值字段链。 */
function evalField(arg: FieldArg, dot: unknown, ctx: ExecContext): unknown {
  let base: unknown
  if (arg.base.kind === 'dot') {
    base = dot
  } else {
    const variable = arg.base as VariableArg
    base = variable.name === '' ? ctx.root : ctx.vars.get(variable.name)
    if (base === undefined && !ctx.vars.has(variable.name)) {
      throw new TemplateError(`undefined variable "${variable.name}"`)
    }
  }
  return resolvePath(base, arg.path, dot)
}

/** 沿字段路径解析值。 */
function resolvePath(base: unknown, path: Array<string | number>, _dot: unknown): unknown {
  let current = base
  for (const key of path) {
    current = resolveField(current, key)
  }
  return current
}

/** 解析单个字段。 */
function resolveField(value: unknown, key: string | number): unknown {
  if (value === null || value === undefined) {
    throw new TemplateError(`nil pointer evaluating interface {}.${String(key)}`)
  }
  let current: unknown = value
  if (typeof current === 'function') {
    // Go 的零参方法：自动调用。
    current = (current as () => unknown)()
  }
  if (Array.isArray(current)) {
    if (typeof key === 'number') {
      return current[key]
    }
    throw new TemplateError(`can't evaluate field ${String(key)} in type []interface {}`)
  }
  if (current instanceof Map) {
    return current.get(key)
  }
  if (typeof current === 'object') {
    const record = current as Record<string, unknown>
    if (!(String(key) in record)) {
      throw new TemplateError(`can't evaluate field ${String(key)} in type struct`)
    }
    const field = record[String(key)]
    if (typeof field === 'function') {
      // Go 的零参方法：自动调用。
      return (field as () => unknown)()
    }
    return field
  }
  throw new TemplateError(`can't evaluate field ${String(key)} in type ${typeof current}`)
}

/** 内置函数表。 */
export function builtinFuncs(): FuncMap {
  return {
    print: (...args: unknown[]) => args.map((a) => formatValue(a)).join(''),
    println: (...args: unknown[]) => `${args.map((a) => formatValue(a)).join(' ')}\n`,
    printf: (format: unknown, ...args: unknown[]) =>
      sprintf(typeof format === 'string' ? format : formatValue(format), args),

    eq: (...args: unknown[]) => {
      if (args.length < 2) throw new TemplateError('missing argument for comparison')
      const first = args[0]
      for (let i = 1; i < args.length; i++) {
        if (!valuesEqual(first, args[i])) return false
      }
      return true
    },
    ne: (a: unknown, b: unknown) => !valuesEqual(a, b),
    lt: (a: unknown, b: unknown) => compareOrdered(a, b) < 0,
    le: (a: unknown, b: unknown) => compareOrdered(a, b) <= 0,
    gt: (a: unknown, b: unknown) => compareOrdered(a, b) > 0,
    ge: (a: unknown, b: unknown) => compareOrdered(a, b) >= 0,

    and: (...args: unknown[]) => {
      if (args.length === 0) return true
      let last: unknown = args[0]
      for (const arg of args) {
        last = arg
        if (!isTrue(arg)) return arg
      }
      return last
    },
    or: (...args: unknown[]) => {
      if (args.length === 0) return false
      let last: unknown = args[0]
      for (const arg of args) {
        last = arg
        if (isTrue(arg)) return arg
      }
      return last
    },
    not: (arg: unknown) => !isTrue(arg),

    len: (arg: unknown) => {
      if (typeof arg === 'string') return [...arg].length
      if (Array.isArray(arg)) return arg.length
      if (arg instanceof Map) return arg.size
      if (typeof arg === 'object' && arg !== null) return Object.keys(arg).length
      throw new TemplateError('len of untyped nil')
    },

    index: (item: unknown, ...keys: unknown[]) => {
      let current = item
      for (const key of keys) {
        if (current === null || current === undefined) {
          throw new TemplateError('index of nil value')
        }
        if (Array.isArray(current)) {
          current = current[Number(key)]
          continue
        }
        if (current instanceof Map) {
          current = current.get(key)
          continue
        }
        if (typeof current === 'object') {
          current = (current as Record<string, unknown>)[String(key)]
          continue
        }
        throw new TemplateError('index of untyped nil')
      }
      return current
    },

    slice: (item: unknown, ...bounds: unknown[]) => {
      if (typeof item === 'string') {
        const chars = [...item]
        const [start, end] = bounds.map((b) => Number(b))
        return chars.slice(start, end).join('')
      }
      if (Array.isArray(item)) {
        const [start, end] = bounds.map((b) => Number(b))
        return item.slice(start, end)
      }
      throw new TemplateError('slice of untyped nil')
    },

    call: (fn: unknown, ...args: unknown[]) => {
      if (typeof fn !== 'function') {
        throw new TemplateError('call of non-function')
      }
      return (fn as TemplateFunc)(...args)
    },

    // LinguaFlow 的自定义函数（Go prompt 包 `templateFuncs` 的等价物）：
    // `mul` = float32(a) × int(b)，结果按 float64。float32 舍入用 Math.fround 对齐。
    mul: (a: unknown, b: unknown) => {
      const fa = Math.fround(typeof a === 'number' ? a : Number(a))
      const ib = Math.trunc(typeof b === 'number' ? b : Number(b))
      return fa * ib
    },
  }
}

/** Go 的 `eq` 语义：同类型比较，数字按数值比较。 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a === b
  if (typeof a === 'string' && typeof b === 'string') return a === b
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  if (a === undefined || b === undefined) return false
  return a === b
}

/** Go 的有序比较。 */
function compareOrdered(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0
  throw new TemplateError('incompatible types for comparison')
}

// 重新导出类型，便于调用方按需引用。
export type {
  BoolArg,
  ChainArg,
  DotArg,
  FieldArg,
  IdentifierArg,
  NilArg,
  NumberArg,
  PipeArg,
  StringArg,
  VariableArg,
  WithNode,
}
