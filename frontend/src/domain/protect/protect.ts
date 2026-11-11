/**
 * 「保护-还原」机制的组合链（对应 Go `backend/internal/protect/protect.go`）。
 *
 * 把不应被翻译的片段（代码、链接、占位符、XML 标签）替换为形如 `__LF_000001__`
 * 的占位符；翻译后按映射还原。
 *
 * 内核原语（`nextKey` / `restoreAll` / `mergeAdjacentPlaceholders`）位于 `core.ts`，
 * 由组合链与各子保护器共享，避免循环依赖。
 */
import { CodeProtector } from './code'
import { mergeAdjacentPlaceholders, restoreAll } from './core'
import { LinkProtector } from './link'
import { PlaceholderProtector } from './placeholder'
import type { ProtectableSegment, Protector } from './types'
import { XMLProtector } from './xml'

export { formatPlaceholder, mergeAdjacentPlaceholders, nextKey, restoreAll } from './core'

/**
 * 组合链：串行调用多个 Protector。
 *
 * protect 按声明顺序执行；unprotect 在顶层**一次性**还原（基于全部占位符），
 * 避免子 protector 各自 restoreAll 时对「已回填内容中再次出现的占位符字面」
 * 二次替换。
 */
export function compose(...ps: Protector[]): Protector {
  return {
    name: 'composed',
    protect(seg: ProtectableSegment): void {
      for (const p of ps) {
        p.protect(seg)
      }
      // 合并相邻占位符为单个占位符，减少 LLM 需要保留的占位符数量。
      mergeAdjacentPlaceholders(seg)
    },
    unprotect(seg: ProtectableSegment): void {
      seg.target = restoreAll(seg.target, seg.protected)
    },
  }
}

/**
 * 对任意文本执行保护，返回占位符形态文本与「占位符 → 原片段」映射。
 *
 * 与 Segment 级 protect 走同一实现（含相邻占位符合并），供不便持有 Segment 状态的
 * 调用方（如 revise 轮对 target 的保护）使用；调用方负责持有映射以便还原。
 * `protector` 为 `null` 时原样返回（无保护配置的降级路径）。
 */
export function protectText(
  protector: Protector | null,
  text: string,
): { text: string; mapping: Record<string, string> | null } {
  if (protector === null) {
    return { text, mapping: null }
  }
  const seg: ProtectableSegment = { source: text, target: '', protected: {} }
  protector.protect(seg)
  // Go 侧未分配过任何占位符时 `seg.Protected` 为 nil（序列化后是 null 而非 {}）。
  const mapping = Object.keys(seg.protected).length > 0 ? seg.protected : null
  return { text: seg.source, mapping }
}

/**
 * 把 text 中出现的映射占位符还原为原片段（restoreAll 的文本级导出），
 * 与 Segment 级 unprotect 的还原语义一致。
 */
export function restoreText(text: string, mapping: Record<string, string>): string {
  return restoreAll(text, mapping)
}

/**
 * 按规则名（`"code"` / `"link"` / `"placeholder"` / `"xml"`）构造 Protector。
 *
 * 未知规则名会被忽略。
 *
 * 注意：不处理 `"ruby"`，注音剥离器由引擎根据 `ruby.enabled` 单独控制，
 * 在其他 Protector 之前运行（先剥离 ruby 标签，再处理剩余 XML）。
 */
export function fromRules(rules: readonly string[]): Protector {
  const ps: Protector[] = []
  for (const rule of rules) {
    switch (rule) {
      case 'code':
        ps.push(new CodeProtector())
        break
      case 'link':
        ps.push(new LinkProtector())
        break
      case 'placeholder':
        ps.push(new PlaceholderProtector())
        break
      case 'xml':
        ps.push(new XMLProtector())
        break
      default:
        break
    }
  }
  return compose(...ps)
}
