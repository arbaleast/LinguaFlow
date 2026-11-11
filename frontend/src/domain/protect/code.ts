/**
 * 代码保护器（对应 Go `backend/internal/protect/code.go`）。
 *
 * 保护 Markdown 代码：围栏块（``` 或 ~~~）和行内代码（`...`）。
 *
 * 正则说明：Go RE2 不支持反向引用，故围栏代码块分「反引号」与「波浪号」两式分写。
 * `(?ms)` = 多行（`^`/`$` 认行边界）+ `.` 匹配换行；非贪婪。
 *
 * RE2 的 `(?m)` 只把 `\n` 当行分隔符（JS 的 `m` 标志额外认 `\r` / `\u2028` / `\u2029`），
 * 故此处使用 `re2js` 编译以保持与 Go 完全一致的边界语义。
 */
import { compile, replaceAllStringFunc } from '../shared/re2'
import { nextKey, restoreAll } from './core'
import type { ProtectableSegment, Protector } from './types'

/** 围栏代码块（反引号）：` ``` ` … ` ``` `。 */
const fencedBacktickRe = compile('(?ms)^[ \\t]*`{3,}[^\\n]*\\n.*?\\n[ \\t]*`{3,}[ \\t]*$')

/** 围栏代码块（波浪号）：`~~~` … `~~~`。 */
const fencedTildeRe = compile('(?ms)^[ \\t]*~{3,}[^\\n]*\\n.*?\\n[ \\t]*~{3,}[ \\t]*$')

/** 行内代码：单个或多个反引号包裹。 */
const inlineCodeRe = compile('`+[^`\\n]+`+')

/** 代码保护器。 */
export class CodeProtector implements Protector {
  readonly name = 'code'

  protect(seg: ProtectableSegment): void {
    let s = seg.source
    for (const re of [fencedBacktickRe, fencedTildeRe, inlineCodeRe]) {
      s = replaceAllStringFunc(re, s, (match) => {
        const k = nextKey(seg)
        seg.protected[k] = match
        return k
      })
    }
    seg.source = s
  }

  unprotect(seg: ProtectableSegment): void {
    seg.target = restoreAll(seg.target, seg.protected)
  }
}
