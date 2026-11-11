/**
 * Go `text/template` 兼容渲染器（TypeScript 移植）。
 *
 * 对外 API：
 *
 * ```ts
 * const tpl = parseTemplate('Hello {{.Name}}')
 * const out = executeTemplate(tpl, { Name: 'World' })
 * ```
 *
 * 或使用带缓存的便捷封装 `new Template(text, funcs)`。
 */
import { executeTemplate, type FuncMap, type TemplateFunc } from './exec'
import { parseTemplate } from './parser'
import type { ListNode } from './types'

export * from './types'
export * from './parser'
export * from './exec'
export { formatGoFloat, formatValue, sprintf } from './format'

/** 带缓存的模板对象（对应 Go 的 `*template.Template`）。 */
export class Template {
  private readonly tree: ListNode

  constructor(
    /** 模板源码。 */
    readonly source: string,
    /** 自定义函数表（覆盖内置函数）。 */
    readonly funcs: FuncMap = {},
  ) {
    this.tree = parseTemplate(source)
  }

  /** 执行模板。 */
  execute(data: unknown): string {
    return executeTemplate(this.tree, data, this.funcs)
  }
}

/** 编译并缓存模板（对应 Go 的 `template.Must(template.New(...).Parse(...))`）。 */
export function mustTemplate(source: string, funcs: FuncMap = {}): Template {
  return new Template(source, funcs)
}

export type { FuncMap, TemplateFunc }
