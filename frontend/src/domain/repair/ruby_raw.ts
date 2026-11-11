/**
 * 注音原始字段保留（对应 Go `backend/internal/repair/ruby_raw.go`）。
 *
 * 目标：在 Ruby 校验器运行前，保持注音 JSON 的**原始字节**不变。普通 map
 * round-trip 会静默抹掉重复的 `id`/`base`/`kind` 成员——那会让重复 ID 校验
 * 失效。外层 envelope 仍保持通用形状，供结构修复算子处理。
 */
import {
  isPlainObject,
  isRawJson,
  nodeToValue,
  parseJsonWhole,
  rawJson,
  type JsonNode,
} from './json_parse'
import { trimSpaceGo } from './strings'

/** 判断对象（递归）是否含 `ruby_output` 字段。 */
export function containsRubyFields(object: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(object)) {
    if (key === 'ruby_output') return true
    if (isPlainObject(value) && containsRubyFields(value)) return true
  }
  return false
}

/**
 * 把原始 JSON 值转换为 `any`（Go `rawRubyValue`）。
 *
 * 数组形态：每一行包装为 `RawJson`，保留重复成员；其他形态：整体包装为
 * `RawJson`（取原始文本，不 trim）。
 */
export function rawRubyValue(raw: string): unknown {
  const trimmed = trimSpaceGo(raw)
  if (trimmed.startsWith('[')) {
    try {
      const node = parseJsonWhole(trimmed)
      if (node.kind === 'array') {
        return (node.items ?? []).map((item) => rawJson(trimmed.slice(item.start, item.end)))
      }
    } catch {
      // 解析失败：退回原始文本（与 Go 的 json.Unmarshal 失败分支一致）。
    }
  }
  return rawJson(raw)
}

/**
 * 保留对象树中的 `ruby_output` 原始字段（Go `preserveRawRubyFields`）。
 *
 * @param rootText 与 `root` 节点同坐标系的源文本
 * @param root     已解析的根节点（必须是对象）
 * @param object   由该节点转换出的通用 map（原地改写）
 */
export function preserveRawRubyFields(
  rootText: string,
  root: JsonNode,
  object: Record<string, unknown>,
): void {
  if (!containsRubyFields(object)) return
  if (root.kind !== 'object') return
  const fields = new Map<string, string>()
  let duplicateRuby = false
  for (const member of root.members ?? []) {
    if (fields.has(member.key) && member.key === 'ruby_output') {
      duplicateRuby = true
    }
    fields.set(member.key, rootText.slice(member.value.start, member.value.end))
  }
  for (const [key, raw] of fields) {
    if (key === 'ruby_output') {
      if (duplicateRuby) {
        // 可选注音不能否定主响应，但歧义 envelope 不能建立任何事实。
        object[key] = null
      } else {
        object[key] = rawRubyValue(raw)
      }
      continue
    }
    const nested = object[key]
    if (!isPlainObject(nested)) continue
    try {
      const node = parseJsonWhole(raw)
      preserveRawRubyFields(raw, node, nested)
    } catch {
      // 原始子值必为合法 JSON；解析失败时保持 map 原样。
    }
  }
}

/** 从已解析的根节点转换并保留原始注音字段（Go `preserveRawRubyFields` 的调用形态）。 */
export function applyRawRubyFields(
  rootText: string,
  root: JsonNode,
  object: Record<string, unknown>,
): void {
  preserveRawRubyFields(rootText, root, object)
}

/** 判断某个值是否为原始 JSON（供其他模块判断 ruby_output 形态）。 */
export function isRawRubyValue(value: unknown): boolean {
  return isRawJson(value)
}

/** 把节点转换为通用值（供测试/调试复用）。 */
export function rawRubyNodeValue(node: JsonNode): unknown {
  return nodeToValue(node)
}
