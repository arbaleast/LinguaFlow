/**
 * envelope 顶层字段同义化（对应 Go `backend/internal/repair/schema.go`）。
 *
 * L2 schema 兼容修复的核心：LLM 偶尔写成 `translation` 缺 s、用
 * `result`/`output` 包裹、或多包一层 `data`。本模块只在顶层做平移，
 * 不递归修改字符串值。
 */
import { isPlainObject } from './json_parse'

/** 顶层别名候选（顺序与 Go 一致）。 */
const ENVELOPE_ALIASES = ['translation', 'result', 'output', 'results'] as const

/**
 * 把 raw 顶层候选字段归一为 `translations`；已含 `translations` 时不动。
 *
 * 返回 `{raw, did}`：`did` 表示是否做了归一化。就地修改传入对象（Go 同）。
 */
export function normalizeEnvelopeKeys(raw: Record<string, unknown>): {
  raw: Record<string, unknown>
  did: boolean
} {
  if (Object.prototype.hasOwnProperty.call(raw, 'translations')) {
    return { raw, did: false }
  }
  for (const alias of ENVELOPE_ALIASES) {
    if (!Object.prototype.hasOwnProperty.call(raw, alias)) continue
    const value = raw[alias]
    if (isPlainObject(value)) {
      raw['translations'] = value
      delete raw[alias]
      return { raw, did: true }
    }
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'data')) {
    const data = raw['data']
    if (isPlainObject(data) && Object.prototype.hasOwnProperty.call(data, 'translations')) {
      raw['translations'] = data['translations']
      delete raw['data']
      return { raw, did: true }
    }
  }
  return { raw, did: false }
}
