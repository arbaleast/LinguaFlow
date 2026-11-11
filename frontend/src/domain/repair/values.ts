/**
 * envelope 值转换（对应 Go `backend/internal/repair/repair.go` 中的
 * `unmarshalGeneric` / `firstStringKey` / `toStringMap`）。
 *
 * 单独成模块，避免 `json.ts`（算子）与 `repair.ts`（入口链）之间形成循环依赖。
 */
import { isPlainObject, nodeToValue, parseJsonWhole, type JsonNode } from './json_parse'
import { applyRawRubyFields } from './ruby_raw'

/** JSON 解析失败（对应 Go `json.Unmarshal` 的 error）。 */
export class UnmarshalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnmarshalError'
  }
}

/**
 * 解析 JSON 对象为 `map[string]any`（Go `unmarshalGeneric`）。
 *
 * 顶层 `null` 返回空对象（Go 对 map 的 unmarshal 语义），顶层非对象报错。
 * 解析成功后保留注音字段的原始 JSON。
 */
export function unmarshalGeneric(body: string): Record<string, unknown> {
  let node: JsonNode
  try {
    node = parseJsonWhole(body)
  } catch (error) {
    throw new UnmarshalError(error instanceof Error ? error.message : String(error))
  }
  if (node.kind === 'null') return {}
  if (node.kind !== 'object') {
    throw new UnmarshalError(
      'cannot unmarshal non-object into Go value of type map[string]interface {}',
    )
  }
  const raw = nodeToValue(node)
  const object = isPlainObject(raw) ? raw : {}
  applyRawRubyFields(body, node, object)
  return object
}

/** 按优先级从 m 中取第一个非空 string 值（Go `firstStringKey`）。 */
export function firstStringKey(m: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = m[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

/** 可翻译字段的候选键（Go `toStringMap` 中的固定顺序）。 */
const TRANSLATABLE_KEYS = ['target', 'translation', 'text', 'source'] as const

/** 译文形状错误（Go `fmt.Errorf` 的 error）。 */
export class TranslationShapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TranslationShapeError'
  }
}

/**
 * 把 `translations` 字段归一为 ID → string（Go `toStringMap`）。
 *
 * 支持两种形态：ID-keyed map，或 `[{id,target,...}]` 数组。值可以是字符串，
 * 也可以是含 `target`/`translation`/`text`/`source` 之一的对象。
 */
export function toStringMap(value: unknown): Record<string, string> {
  if (isPlainObject(value)) {
    const out: Record<string, string> = {}
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string') {
        out[key] = item
        continue
      }
      if (isPlainObject(item)) {
        const text = firstStringKey(item, TRANSLATABLE_KEYS)
        if (text !== '') {
          out[key] = text
          continue
        }
        throw new TranslationShapeError(
          `value for key ${JSON.stringify(key)} is object but no translatable string field found`,
        )
      }
      throw new TranslationShapeError(
        `value for key ${JSON.stringify(key)} is not string (got ${goTypeName(item)})`,
      )
    }
    return out
  }
  if (Array.isArray(value)) {
    const out: Record<string, string> = {}
    for (let i = 0; i < value.length; i++) {
      const item = value[i]
      if (!isPlainObject(item)) {
        throw new TranslationShapeError(
          `translations array item ${i} is not object (got ${goTypeName(item)})`,
        )
      }
      const id = typeof item['id'] === 'string' ? item['id'] : ''
      if (id === '') {
        throw new TranslationShapeError(`translations array item ${i} missing string "id"`)
      }
      const text = firstStringKey(item, TRANSLATABLE_KEYS)
      if (text !== '') {
        out[id] = text
        continue
      }
      throw new TranslationShapeError(
        `translations array item ${i} (id=${JSON.stringify(id)}) has no translatable string field`,
      )
    }
    return out
  }
  throw new TranslationShapeError(`expected object or array, got ${goTypeName(value)}`)
}

/** Go `%T` 的近似名称（仅用于错误信息，不参与黄金对拍）。 */
function goTypeName(value: unknown): string {
  if (value === null || value === undefined) return '<nil>'
  if (Array.isArray(value)) return '[]interface {}'
  if (isPlainObject(value)) return 'map[string]interface {}'
  if (typeof value === 'number') return 'float64'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'boolean') return 'bool'
  return typeof value
}
