/**
 * 占位符守恒校验（对应 Go `backend/internal/protect/integrity.go`）。
 */
import { compile, findAllStringIndex } from '../shared/re2'
import type { ProtectableSegment } from './types'

/** 探测「像占位符」的 token（大小写不敏感，非贪婪）。 */
const placeholderLikeRE = compile('(?i)__LF_[A-Z0-9_]+?__')

/** 占位符违规的三分类结果。 */
export interface PlaceholderViolation {
  /** `Protected` 中计数为 0 的 key。 */
  missing: string[]
  /** `Protected` 中计数 > 1 的 key。 */
  duplicated: string[]
  /** `Target` 中出现的规范形态 `__LF_######__` 且不在 `Protected` 中的 token。 */
  invented: string[]
}

/**
 * 对段做占位符全守恒校验（还原前）。
 *
 * - `missing`：Protected 中计数为 0 的 key
 * - `duplicated`：Protected 中计数 > 1 的 key
 * - `invented`：Target 中出现的规范形态 `__LF_######__` 且不在 Protected 中的 token
 *
 * 已知 key 即使重复也只记 duplicated，不记 invented。
 * 三类结果均按 key 升序排序，便于日志稳定输出。
 * 调用方应在可选的 NormalizePlaceholders 之后调用本函数。
 */
export function placeholderViolations(seg: ProtectableSegment | null): PlaceholderViolation {
  if (seg === null) {
    return { missing: [], duplicated: [], invented: [] }
  }
  const target = seg.target
  const missing: string[] = []
  const duplicated: string[] = []

  const keys = Object.keys(seg.protected)
  if (keys.length > 0) {
    for (const k of keys) {
      const n = countOccurrences(target, k)
      if (n === 0) {
        missing.push(k)
      } else if (n > 1) {
        duplicated.push(k)
      }
    }
    missing.sort()
    duplicated.sort()
  }

  const invented: string[] = []
  const seenInvented = new Set<string>()
  for (const [start, end] of findAllStringIndex(placeholderLikeRE, target)) {
    const tok = target.slice(start, end)
    if (tok in seg.protected) continue
    if (seenInvented.has(tok)) continue
    seenInvented.add(tok)
    invented.push(tok)
  }
  invented.sort()

  return { missing, duplicated, invented }
}

/**
 * 返回 `seg.protected` 中未出现在 `seg.target` 里的占位符 key。
 *
 * 用于 translate 阶段在 LLM 返回后做完整性校验。结果按 key 升序排序。
 * 内部委托 `placeholderViolations`，仅取 missing 子集以保持调用方兼容。
 */
export function missingPlaceholders(seg: ProtectableSegment): string[] {
  return placeholderViolations(seg).missing
}

/** 统计 needle 在 haystack 中出现的次数（等价 Go `strings.Count`，非重叠计数）。 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let pos = haystack.indexOf(needle)
  while (pos !== -1) {
    count++
    pos = haystack.indexOf(needle, pos + needle.length)
  }
  return count
}
