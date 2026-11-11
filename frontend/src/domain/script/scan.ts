/**
 * 兄弟文字系统证据扫描（对应 Go `backend/internal/script/scan.go`）。
 *
 * 语义要点（与 Go 逐处对齐）：
 * - 按 **rune（码点）** 迭代，不是 UTF-16 code unit；`for (const ch of text)` 与
 *   Go 的 `for _, r := range text` 等价，代理对自动合并。
 * - 只统计 `runeScript` 判为某个 sibling 的 rune；共用/中性字符不计，且会中断连续 run。
 * - `sample` 取该文字系统**首个**连续 run，最多 {@link MAX_SAMPLE_RUNES} 个 rune。
 * - 计数并列时取 `siblings` 顺序靠前者（严格大于才替换）。
 */
import { runeScript } from './han'
import { MAX_SAMPLE_RUNES, type Evidence, type Profile, type Script } from './types'

/** 判断 `s` 是否在 siblings 集合内（Go `isSibling`）。 */
function isSibling(siblings: readonly Script[], s: Script): boolean {
  for (const x of siblings) {
    if (x === s) return true
  }
  return false
}

/**
 * 统计 `text` 中落在 `profile.siblings` 各文字系统的专属字符（Go `Profile.Scan`）。
 *
 * 存在证据时返回计数最大的兄弟系统（并列取 siblings 顺序靠前者）；
 * 无证据返回 `null`（对应 Go 的 `(zero, false)`）。
 */
export function scanProfile(profile: Profile, text: string): Evidence | null {
  const counts = new Map<Script, number>()
  /** 各 sibling 首个连续 run（截断至 MAX_SAMPLE_RUNES）。 */
  const first = new Map<Script, string>()
  /** 当前 run 的文字系统；空串表示不在任何 run 中。 */
  let cur: Script = ''
  let run: number[] = []
  /** 当前 run 是否为该文字系统的首个 run。 */
  let runIsFirst = false

  for (const ch of text) {
    const r = ch.codePointAt(0) ?? 0
    const verdict = runeScript(r)
    if (!verdict.ok || !isSibling(profile.siblings, verdict.script)) {
      // 期望侧专属、共用或中性字符：中断当前连续 run
      cur = ''
      run = []
      runIsFirst = false
      continue
    }
    const sc = verdict.script
    counts.set(sc, (counts.get(sc) ?? 0) + 1)
    if (sc !== cur) {
      cur = sc
      run = []
      if (!first.has(sc)) {
        runIsFirst = true // 仅记录首个 run
      }
    }
    if (run.length < MAX_SAMPLE_RUNES) {
      run.push(r)
      if (runIsFirst) {
        first.set(sc, run.map((cp) => String.fromCodePoint(cp)).join(''))
      }
    }
  }

  // 并列取 siblings 顺序靠前者：严格大于才替换
  let best: Script = ''
  let bestCount = 0
  for (const s of profile.siblings) {
    const c = counts.get(s) ?? 0
    if (c > bestCount) {
      best = s
      bestCount = c
    }
  }
  if (best === '') {
    return null
  }
  return { script: best, count: bestCount, sample: first.get(best) ?? '' }
}
