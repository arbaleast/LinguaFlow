/**
 * 链接保护器（对应 Go `backend/internal/protect/link.go`）。
 *
 * 保护 Markdown 链接的 URL / 图片部分，但保留可见文本以便翻译：
 *
 * - `[text](url)` → `[text](__LF_xxxxxx__)`
 * - `![alt](url)` → `![alt](__LF_xxxxxx__)`
 * - `<https://...>` → `__LF_xxxxxx__`
 * - `[text][ref]` → `[text][__LF_xxxxxx__]`
 */
import { compile, findStringSubmatch, replaceAllStringFunc } from '../shared/re2'
import { nextKey, restoreAll } from './core'
import type { ProtectableSegment, Protector } from './types'

/** inline link / image：仅保护 URL 部分。 */
const mdLinkRe = compile('(!?\\[[^\\]]*\\])\\(([^)\\s]+)(\\s+"[^"]*")?\\)')

/** auto link：整体保护。 */
const autoLinkRe = compile('<(?:https?|ftp|mailto):[^>\\s]+>')

/** reference link：保护 ref id。 */
const refLinkRe = compile('(\\[[^\\]]+\\])\\[([^\\]]+)\\]')

/** 链接保护器。 */
export class LinkProtector implements Protector {
  readonly name = 'link'

  protect(seg: ProtectableSegment): void {
    let s = seg.source

    // inline link / image：仅保护 URL 部分
    s = replaceAllStringFunc(mdLinkRe, s, (match) => {
      const m = findStringSubmatch(mdLinkRe, match)
      if (!m) return match
      const k = nextKey(seg)
      let url = m[2] ?? ''
      if ((m[3] ?? '') !== '') {
        url += m[3] as string
      }
      seg.protected[k] = url
      return `${m[1] ?? ''}(${k})`
    })

    // auto link：整体保护
    s = replaceAllStringFunc(autoLinkRe, s, (match) => {
      const k = nextKey(seg)
      seg.protected[k] = match
      return k
    })

    // reference link：保护 ref id
    s = replaceAllStringFunc(refLinkRe, s, (match) => {
      const m = findStringSubmatch(refLinkRe, match)
      if (!m) return match
      const k = nextKey(seg)
      seg.protected[k] = m[2] ?? ''
      return `${m[1] ?? ''}[${k}]`
    })

    seg.source = s
  }

  unprotect(seg: ProtectableSegment): void {
    seg.target = restoreAll(seg.target, seg.protected)
  }
}
