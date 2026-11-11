/**
 * legacy 注音 envelope 修复（对应 Go `backend/internal/repair/ruby_state.go`）。
 *
 * 保留每一行可识别条目，供候选的重复 ID 校验使用——单行畸形绝不丢弃其他
 * 独立有效的注音条目。
 */
import { marshalGo } from './json_parse'
import { tryRepairEnvelope } from './envelope'
import { parseOutputEntries, validBareOutputEntries } from './deps/ruby_protocol'
import { trimSpaceGo } from './strings'
import type { RepairOptions, RubyOutputEntry } from './types'

/** 把错误归一为消息字符串。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 应用 legacy envelope 修复契约（Go `TryRepairRubyAlignmentForState`）。
 *
 * 返回的条目仅 trim `base`/`text`/`kind`，**不过滤**空 base——状态机需要看到
 * 全部可识别行。
 */
export function tryRepairRubyAlignmentForState(
  text: string,
  opt: RepairOptions,
): { entries: RubyOutputEntry[]; repaired: string[]; error: string | null } {
  const options: RepairOptions = { ...opt, bareArrayAccept: validBareOutputEntries }
  const envelope = tryRepairEnvelope(text, 'ruby_output', options)
  if (envelope.error !== null) {
    return { entries: [], repaired: envelope.repaired, error: envelope.error }
  }
  const data = marshalGo((envelope.raw ?? {})['ruby_output'])
  let entries: RubyOutputEntry[]
  try {
    entries = parseOutputEntries(data)
  } catch (error) {
    return { entries: [], repaired: envelope.repaired, error: errorMessage(error) }
  }
  return {
    entries: entries.map((entry) => ({
      ...entry,
      base: trimSpaceGo(entry.base),
      text: trimSpaceGo(entry.text),
      kind: trimSpaceGo(entry.kind),
    })),
    repaired: envelope.repaired,
    error: null,
  }
}
