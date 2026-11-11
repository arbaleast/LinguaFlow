/**
 * 占位符保护器（对应 Go `backend/internal/protect/placeholder.go`）。
 *
 * 保护程序员常用的占位语法：
 *
 * - `{{var}}` / `{{ .Field }}`
 * - `{var}` / `{0}`
 * - `%s` / `%d` / `%v` / `%.2f`
 * - `$VAR` / `${VAR}`
 */
import { compile, replaceAllStringFunc } from '../shared/re2'
import { nextKey, restoreAll } from './core'
import type { ProtectableSegment, Protector } from './types'

/** `{{var}}` / `{{ .Field }}`。 */
const doubleBraceRe = compile('\\{\\{[^{}]+\\}\\}')

/** `{var}` / `{0}`。 */
const singleBraceRe = compile('\\{[A-Za-z0-9_.]+\\}')

/** printf 动词：`%s` / `%d` / `%.2f` / `%+v` / `%#x`。 */
const printfVerbRe = compile('%[+\\-#0 ]?[0-9]*(?:\\.[0-9]+)?[a-zA-Z]')

/**
 * shell 变量：`$VAR` / `${VAR}`。
 *
 * 排除 `$_` 开头，以避免误吞已被替换的 `__LF_xxxx__` 占位符。
 */
const shellVarRe = compile('\\$(?:\\{[A-Za-z_][A-Za-z0-9_]*\\}|[A-Za-z][A-Za-z0-9_]*)')

/** 占位符保护器。 */
export class PlaceholderProtector implements Protector {
  readonly name = 'placeholder'

  protect(seg: ProtectableSegment): void {
    let s = seg.source
    for (const re of [doubleBraceRe, singleBraceRe, printfVerbRe, shellVarRe]) {
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
