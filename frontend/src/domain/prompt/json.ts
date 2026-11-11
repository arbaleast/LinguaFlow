/**
 * Go `encoding/json` 的序列化语义（TypeScript 移植，仅覆盖提示词信封所需子集）。
 *
 * 与 `domain/repair/json_parse.ts` 的 `marshalGo` 的**关键差异**：
 *
 * - `marshalGo` 把普通对象当作 **map** 处理（key 按字典序输出）；
 * - 本模块把显式声明的对象当作 **struct** 处理（key 按**字段声明顺序**输出）。
 *
 * Go 的 `json.Marshal` 对 struct 保留字段声明顺序，只对 map 的 key 排序——
 * 提示词信封（envelope）全是 struct，因此必须区分两者，否则输出的
 * JSON 字节序列与 Go 不一致，LLM 看到的报文就会不同。
 */
import { goJSONString } from '../repair/json_parse'

/** Go struct 的字段声明。 */
export interface GoField {
  /** JSON 字段名。 */
  name: string
  /** 字段值。 */
  value: GoValue
  /** 对应 Go 的 `omitempty`：空值时省略该字段。 */
  omitEmpty?: boolean
}

/** 可被本模块序列化的值。 */
export type GoValue = GoStruct | GoMap | GoValue[] | string | number | boolean | null

/** Go struct（字段按声明顺序输出）。 */
export interface GoStruct {
  readonly __goStruct: true
  readonly fields: readonly GoField[]
}

/** Go map（key 按字典序输出）。 */
export interface GoMap {
  readonly __goMap: true
  readonly entries: ReadonlyMap<string, GoValue>
}

/** 构造 Go struct。 */
export function goStruct(fields: readonly GoField[]): GoStruct {
  return { __goStruct: true, fields }
}

/** 构造 Go map。 */
export function goMap(entries: ReadonlyMap<string, GoValue>): GoMap {
  return { __goMap: true, entries }
}

/** Go 的 `omitempty` 判定：false / 0 / "" / nil / 空数组 / 空 map 均视为空。 */
function isEmptyValue(value: GoValue): boolean {
  if (value === undefined) return true
  if (value === null) return true
  if (value === '') return true
  if (value === false) return true
  if (value === 0) return true
  if (Array.isArray(value)) return value.length === 0
  if (isGoMap(value)) return value.entries.size === 0
  return false
}

/** 判断是否为 Go map。 */
export function isGoMap(value: GoValue): value is GoMap {
  return typeof value === 'object' && value !== null && '__goMap' in value
}

/** 判断是否为 Go struct。 */
export function isGoStruct(value: GoValue): value is GoStruct {
  return typeof value === 'object' && value !== null && '__goStruct' in value
}

/**
 * 序列化为紧凑 JSON（等价 Go `json.Marshal`）。
 *
 * - struct：字段按声明顺序，`omitempty` 的空值字段被省略；
 * - map：key 按字典序（Go 的 `encoding/json` 行为）；
 * - 字符串：Go 的 HTML 安全转义（`<` `>` `&` → `\u003c` `\u003e` `\u0026`）。
 */
export function marshalGoJSON(value: GoValue): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return goJSONString(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null'
    return Number.isInteger(value) ? String(value) : String(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => marshalGoJSON(item)).join(',')}]`
  }
  if (isGoMap(value)) {
    const keys = [...value.entries.keys()].sort()
    const parts = keys.map(
      (key) => `${goJSONString(key)}:${marshalGoJSON(value.entries.get(key) as GoValue)}`,
    )
    return `{${parts.join(',')}}`
  }
  if (isGoStruct(value)) {
    const parts: string[] = []
    for (const field of value.fields) {
      if (field.omitEmpty && isEmptyValue(field.value)) continue
      parts.push(`${goJSONString(field.name)}:${marshalGoJSON(field.value)}`)
    }
    return `{${parts.join(',')}}`
  }
  return 'null'
}
