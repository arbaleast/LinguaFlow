/**
 * XML / HTML 标签保护器（对应 Go `backend/internal/protect/xml.go`）。
 *
 * 保护标签整体（包括属性），但保留标签之间的文本以便翻译。
 */
import { compile, replaceAllStringFunc } from '../shared/re2'
import { nextKey, restoreAll } from './core'
import type { ProtectableSegment, Protector } from './types'

/**
 * 匹配 `<tag>`、`</tag>`、`<tag attr="...">`、`<tag/>`，
 * 但不匹配 `<` 后跟空格的情况。
 */
const xmlTagRe = compile('</?[A-Za-z][A-Za-z0-9:-]*(?:\\s+[^<>]*)?/?>')

/** XML 标签保护器。 */
export class XMLProtector implements Protector {
  readonly name = 'xml'

  protect(seg: ProtectableSegment): void {
    seg.source = replaceAllStringFunc(xmlTagRe, seg.source, (match) => {
      const k = nextKey(seg)
      seg.protected[k] = match
      return k
    })
  }

  unprotect(seg: ProtectableSegment): void {
    seg.target = restoreAll(seg.target, seg.protected)
  }
}
