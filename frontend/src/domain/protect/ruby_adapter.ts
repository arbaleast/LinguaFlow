/**
 * 注音剥离保护器（对应 Go `backend/internal/protect/ruby_adapter.go`）。
 *
 * `protect`：提取注音条目到 `seg.meta.rubyItems` 并剥离源文标签；
 * `unprotect` 为空操作（注音还原由 pipeline 的 RubyRestore 阶段委托
 * `ruby.restoreItems` 完成）。
 *
 * 注意：注音保护器**不在** `fromRules` 中，由引擎根据 `ruby.enabled` 单独控制，
 * 在其他 Protector 之前运行（先剥离 ruby 标签，再处理剩余 XML）。
 */
import { extract } from '../ruby/extractor'
import { itemsToWire } from '../ruby/item'
import type { ProtectableSegment, Protector } from './types'

/** 注音保护器。 */
export class RubyProtector implements Protector {
  readonly name = 'ruby'

  protect(seg: ProtectableSegment): void {
    const { items, stripped } = extract(seg.source)
    seg.source = stripped
    // 无条目时不写 meta，保持「无注音 → Meta 不被写入任何 ruby key」的历史约定
    if (items.length > 0) {
      if (!seg.meta) {
        seg.meta = {}
      }
      // 落库形态与 Go `ruby.Item` 的 JSON 序列化逐字节一致（省略空串、剔除运行态字段）。
      seg.meta.ruby_items = itemsToWire(items)
    }
  }

  unprotect(_seg: ProtectableSegment): void {
    // 注音还原不在 unprotect 阶段执行：还原需要 LLM 的对齐回填结果，
    // 由 pipeline 的 RubyRestore 阶段委托 ruby.restoreItems 完成。
  }
}
