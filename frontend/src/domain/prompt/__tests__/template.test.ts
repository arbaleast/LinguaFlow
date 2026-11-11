/**
 * Go `text/template` 兼容渲染器的单元测试。
 *
 * 期望值全部由 **Go 1.27 实测**得到（`text/template` 标准库），
 * 覆盖空白裁剪、管道、变量、range、函数与值格式化等关键语义。
 */
import { describe, expect, it } from 'vitest'
import { Template } from '../template'

interface ProbeData {
  SourceLang: string
  TargetLang: string
  Protocol: string
  Notes: string
  Score: number
  Glossary: Array<{ Source: string; Target: string; Notes: string }>
  TMHints: Array<{ Source: string; Target: string; Score: number }>
  HasRuby: () => boolean
  Empty: string[]
  InlineBootstrap: boolean
  MaxBootstrapTerms: number
}

const data = (): ProbeData => ({
  SourceLang: 'auto',
  TargetLang: 'zh',
  Protocol: 'text',
  Notes: 'n',
  Score: 0.5,
  Glossary: [
    { Source: 'a', Target: 'b', Notes: '' },
    { Source: 'c', Target: 'd', Notes: 'x' },
  ],
  TMHints: [{ Source: 's', Target: 't', Score: 0.5 }],
  HasRuby: () => true,
  Empty: [],
  InlineBootstrap: false,
  MaxBootstrapTerms: 20,
})

const render = (source: string): string => new Template(source).execute(data())

describe('Go text/template 兼容渲染器', () => {
  it('空白裁剪标记与 Go 完全一致', () => {
    expect(render('A{{.TargetLang}}B')).toBe('AzhB')
    expect(render('A  {{- .TargetLang}}B')).toBe('AzhB')
    expect(render('A{{ .TargetLang -}}  B')).toBe('AzhB')
    expect(render('A  {{- .TargetLang -}}  B')).toBe('AzhB')
    expect(render('A\t\t{{- .TargetLang}}B')).toBe('AzhB')
    expect(render('A\v\v{{- .TargetLang}}B')).toBe('AzhB')
    expect(render('A\n{{-\n .TargetLang}}B')).toBe('AzhB')
  })

  it('裁剪标记的语法要求与 Go 一致（非法写法报解析错误）', () => {
    expect(() => new Template('A{{-.TargetLang}}B')).toThrow()
    expect(() => new Template('A{{.TargetLang-}}B')).toThrow()
    expect(() => new Template('A{{ .TargetLang -\n}}B')).toThrow()
  })

  it('条件分支与 else if', () => {
    expect(
      render('{{if eq .Protocol "json"}}J{{else if eq .Protocol "text"}}T{{else}}O{{end}}'),
    ).toBe('T')
    expect(render('{{if .HasRuby}}true{{end}}')).toBe('true')
    expect(render('{{if .Empty}}Y{{else}}N{{end}}')).toBe('N')
  })

  it('range 遍历与 range over int', () => {
    expect(
      render(
        '{{range .Glossary}}[{{.Source}}=>{{.Target}}{{if .Notes}}({{.Notes}}){{end}}]{{end}}',
      ),
    ).toBe('[a=>b][c=>d(x)]')
    expect(render('{{range $i, $v := .Glossary}}{{$i}}:{{$v.Source}} {{end}}')).toBe('0:a 1:c ')
    expect(render('{{range .Glossary}}{{.Source}}->{{.Target}}\n{{end}}')).toBe('a->b\nc->d\n')
    expect(render('{{range .Empty}}x{{else}}none{{end}}')).toBe('none')
  })

  it('变量声明不产生输出，变量可重复引用', () => {
    expect(render('{{$x := .TargetLang}}{{$x}}|{{$x}}')).toBe('zh|zh')
    expect(render('{{$z := 5}}out{{$z}}')).toBe('out5')
  })

  it('printf 与 Go 的浮点格式一致', () => {
    expect(render('{{printf "%.2f" .Score}}')).toBe('0.50')
    expect(render('{{.Score}}')).toBe('0.5')
    expect(render('{{mul 1.5 3}}')).toBe('4.5')
  })

  it('零参方法（Go method）自动调用', () => {
    expect(render('{{.HasRuby}}')).toBe('true')
  })

  it('缺失字段按 Go 的语义报错', () => {
    expect(() => new Template('{{.Missing}}').execute(data())).toThrow()
  })

  it('内置函数与 Go 一致', () => {
    const tpl = new Template('{{len .Glossary}}|{{index .Glossary 0 "Source"}}|{{not .Empty}}')
    expect(tpl.execute(data())).toBe('2|a|true')
  })

  it('嵌套条件 + 裁剪的组合（内置模板常用形态）', () => {
    // Go 实测输出：'x\nY\nz'（左裁剪只吃掉紧邻动作前的空白）。
    expect(
      render('x{{- if .HasRuby }}\n{{- if eq .Protocol "text"}}\nY\n{{- end}}\n{{- end}}\nz'),
    ).toBe('x\nY\nz')
  })
})
