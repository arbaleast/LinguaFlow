/**
 * Go `fmt` 的值格式化语义（TypeScript 移植）。
 *
 * 模板里出现数值时，Go 用 `fmt.Fprint` 的 `%v` 语义输出；模板里用 `printf`
 * 时按动词格式化。本模块提供两者。
 *
 * 与 JS 的关键差异：
 *
 * - `String(1000000)` → `"1000000"`，而 Go 的 `%v` → `"1e+06"`（`%g` 最短表示规则）；
 * - `String(true)` → `"true"`，与 Go 一致；
 * - `null` / `undefined` → Go 打印 `"<no value>"`；
 * - 数组 → Go 打印 `"[a b]"`（空格分隔），不是 JS 的 `"a,b"`；
 * - 对象 → Go 打印 `"{f1 f2}"`。
 */

/** Go 的 `%v` 语义格式化。 */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '<no value>'
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return String(value)
    return formatGoFloat(value, 64)
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function') return formatValue((value as () => unknown)())
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatValue(item)).join(' ')}]`
  }
  if (value instanceof Map) {
    const entries = [...value.entries()]
      .map(([k, v]) => `${formatValue(k)}:${formatValue(v)}`)
      .sort()
    return `map[${entries.join(' ')}]`
  }
  if (typeof value === 'object') {
    const values = Object.values(value as Record<string, unknown>)
    return `{${values.map((item) => formatValue(item)).join(' ')}}`
  }
  return String(value)
}

/**
 * Go 的 `strconv.FormatFloat(v, 'g', -1, bitSize)` 语义。
 *
 * 规则（Go `strconv.ftoa`）：
 *
 * - 取「最短往返」十进制表示（JS 的 `Number.prototype.toString` 恰好也是最短往返）；
 * - 记 `exp = dp - 1`（`dp` = 小数点位置，即 `0.digits × 10^dp`）；
 * - `exp < -4` 或 `exp >= 6` 时用 `%e` 形式，否则用 `%f` 形式。
 */
export function formatGoFloat(value: number, _bitSize: 32 | 64 = 64): string {
  if (Number.isNaN(value)) return 'NaN'
  if (!Number.isFinite(value)) return value > 0 ? '+Inf' : '-Inf'
  if (value === 0) return Object.is(value, -0) ? '-0' : '0'

  const digits = shortestDigits(value)
  const exp = digits.dp - 1
  if (exp < -4 || exp >= 6) {
    return formatExponential(digits)
  }
  return formatDecimal(digits)
}

/** 最短往返十进制表示的「数字 + 小数点位置」。 */
interface DecimalDigits {
  /** 有效数字（不含前导 0 与小数点）。 */
  digits: string
  /** 小数点位置：`value = 0.digits × 10^dp`。 */
  dp: number
}

/** 提取最短往返表示的数字与小数点位置。 */
function shortestDigits(value: number): DecimalDigits {
  const raw = Math.abs(value).toString()
  let digits: string
  let dp: number
  if (raw.includes('e') || raw.includes('E')) {
    const [mantissa, expPart] = raw.split(/[eE]/) as [string, string]
    const exponent = Number(expPart)
    const dot = mantissa.indexOf('.')
    if (dot === -1) {
      digits = mantissa
      dp = exponent + 1
    } else {
      digits = mantissa.slice(0, dot) + mantissa.slice(dot + 1)
      dp = exponent + dot + 1
    }
  } else {
    const dot = raw.indexOf('.')
    if (dot === -1) {
      digits = raw
      dp = raw.length
    } else {
      digits = raw.slice(0, dot) + raw.slice(dot + 1)
      dp = dot
    }
  }
  // 约定 value = 0.digits × 10^dp：剥掉整数部分的前导 0（`0.5` → digits='5', dp=0）。
  while (digits.length > 1 && digits.startsWith('0')) {
    digits = digits.slice(1)
    dp--
  }
  // 剥掉无效的尾随 0（`1000000` 的最短数字是 '1'，即 0.1×10^7）。
  while (digits.length > 1 && digits.endsWith('0')) {
    digits = digits.slice(0, -1)
  }
  return { digits, dp }
}

/** `%f` 形式。 */
function formatDecimal(d: DecimalDigits): string {
  const { digits, dp } = d
  if (dp <= 0) {
    return `0.${'0'.repeat(-dp)}${digits}`
  }
  if (dp >= digits.length) {
    return digits + '0'.repeat(dp - digits.length)
  }
  return `${digits.slice(0, dp)}.${digits.slice(dp)}`
}

/** `%e` 形式（指数至少两位）。 */
function formatExponential(d: DecimalDigits): string {
  const { digits, dp } = d
  const exp = dp - 1
  const sign = exp < 0 ? '-' : '+'
  const expText = String(Math.abs(exp)).padStart(2, '0')
  if (digits.length === 1) {
    return `${digits}e${sign}${expText}`
  }
  return `${digits[0]}.${digits.slice(1)}e${sign}${expText}`
}

/**
 * Go 的 `fmt.Sprintf` 语义（常用动词子集）。
 *
 * 支持：`%v` `%s` `%d` `%f` `%.Nf` `%e` `%g` `%t` `%q` `%x` `%c` `%%`，
 * 以及 `%(name)s` 之外的常规宽度/精度忽略（按 Go 的默认宽度处理）。
 */
export function sprintf(format: string, args: unknown[]): string {
  let out = ''
  let argIndex = 0
  let i = 0
  while (i < format.length) {
    const ch = format[i] as string
    if (ch !== '%') {
      out += ch
      i++
      continue
    }
    if (i + 1 >= format.length) {
      out += '%!(NOVERB)'
      break
    }
    // 解析可选标志、宽度、精度。
    let j = i + 1
    let flags = ''
    while (j < format.length && '+-# 0'.includes(format[j] as string)) {
      flags += format[j]
      j++
    }
    let width = ''
    while (j < format.length && /[0-9]/.test(format[j] as string)) {
      width += format[j]
      j++
    }
    let precision = ''
    if (j < format.length && format[j] === '.') {
      j++
      while (j < format.length && /[0-9]/.test(format[j] as string)) {
        precision += format[j]
        j++
      }
    }
    if (j >= format.length) {
      out += '%!(NOVERB)'
      break
    }
    const verb = format[j] as string
    j++
    if (verb === '%') {
      out += '%'
      i = j
      continue
    }
    const arg = args[argIndex]
    argIndex++
    out += formatVerb(verb, arg, precision === '' ? undefined : Number(precision))
    i = j
  }
  return out
}

/** 按动词格式化单个参数。 */
function formatVerb(verb: string, arg: unknown, precision: number | undefined): string {
  switch (verb) {
    case 'v':
      return formatValue(arg)
    case 's':
      if (typeof arg === 'string') return arg
      if (arg === null || arg === undefined) return '%!s(<nil>)'
      if (typeof arg === 'number' || typeof arg === 'boolean') {
        return `%!s(${goTypeName(arg)}=${formatValue(arg)})`
      }
      return formatValue(arg)
    case 'd': {
      if (typeof arg === 'number' && Number.isFinite(arg)) {
        return Math.trunc(arg).toString()
      }
      if (typeof arg === 'bigint') return arg.toString()
      return `%!d(${goTypeName(arg)}=${formatValue(arg)})`
    }
    case 'f': {
      if (typeof arg === 'number' && Number.isFinite(arg)) {
        return arg.toFixed(precision ?? 6)
      }
      return `%!f(${goTypeName(arg)}=${formatValue(arg)})`
    }
    case 'e': {
      if (typeof arg === 'number' && Number.isFinite(arg)) {
        return arg.toExponential(precision ?? 6)
      }
      return `%!e(${goTypeName(arg)}=${formatValue(arg)})`
    }
    case 'g': {
      if (typeof arg === 'number' && Number.isFinite(arg)) {
        return formatGoFloat(arg, 64)
      }
      return `%!g(${goTypeName(arg)}=${formatValue(arg)})`
    }
    case 't':
      if (typeof arg === 'boolean') return arg ? 'true' : 'false'
      return `%!t(${goTypeName(arg)}=${formatValue(arg)})`
    case 'q':
      if (typeof arg === 'string') return JSON.stringify(arg)
      return `%!q(${goTypeName(arg)}=${formatValue(arg)})`
    case 'x':
      if (typeof arg === 'number' && Number.isFinite(arg)) {
        return Math.trunc(arg).toString(16)
      }
      if (typeof arg === 'string') {
        return [...arg].map((c) => c.codePointAt(0)?.toString(16).padStart(2, '0')).join('')
      }
      return `%!x(${goTypeName(arg)}=${formatValue(arg)})`
    case 'c':
      if (typeof arg === 'number') return String.fromCodePoint(arg)
      if (typeof arg === 'string') return arg
      return `%!c(${goTypeName(arg)}=${formatValue(arg)})`
    default:
      return `%!${verb}(${goTypeName(arg)}=${formatValue(arg)})`
  }
}

/** Go 的类型名（用于 `%!verb(type=value)` 形式）。 */
function goTypeName(value: unknown): string {
  if (value === null || value === undefined) return '<nil>'
  if (typeof value === 'boolean') return 'bool'
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float64'
  if (typeof value === 'string') return 'string'
  if (Array.isArray(value)) return '[]interface {}'
  return 'interface {}'
}
