/**
 * 注音条目结构（对应 Go `backend/internal/ruby/item.go`）。
 *
 * 提取阶段填 `id` / `source_base` / `source_text`；LLM 回填 `target_base` /
 * `target_text` / `kind`；还原阶段按 `id` 显式关联（无 id 回退位置，
 * 向后兼容旧后端 / 漏返）。
 *
 * **字段名约定**：本类型会随 `seg.Meta["ruby_items"]` 持久化并与 Go 后端互通，
 * 故字段名沿用 Go 结构体的 JSON tag（snake_case）而非 TS 惯用的 camelCase，
 * 以保证前后端序列化结果逐字节一致。
 */

/** 注音条目。 */
export interface RubyItem {
  /** 段内稳定序号，如 `"1"`、`"2"`（提取时分配）。 */
  id: string
  /** 原文基底（ruby 标签剥离后的原文）。 */
  source_base: string
  /** 原文注音。 */
  source_text: string
  /** LLM 回填：译文中的对应文本。 */
  target_base: string
  /** LLM 回填：译文注音。 */
  target_text: string
  /** `"phonetic" | "semantic" | "creative"`。 */
  kind: string
  /** 运行态：是否已对齐（不外发 / 不持久化）。 */
  aligned: boolean
}

/** 构造一个空条目（对应 Go 的零值 Item）。 */
export function newRubyItem(init: Partial<RubyItem> = {}): RubyItem {
  return {
    id: init.id ?? '',
    source_base: init.source_base ?? '',
    source_text: init.source_text ?? '',
    target_base: init.target_base ?? '',
    target_text: init.target_text ?? '',
    kind: init.kind ?? '',
    aligned: init.aligned ?? false,
  }
}

/**
 * 注音条目的**持久化形态**（对应 Go `ruby.Item` 的 JSON 序列化结果）。
 *
 * Go 侧结构体标签为：
 *
 * ```go
 * ID         string `json:"id"`
 * SourceBase string `json:"source_base,omitempty"`
 * SourceText string `json:"source_text,omitempty"`
 * TargetBase string `json:"target_base,omitempty"`
 * TargetText string `json:"target_text,omitempty"`
 * Kind       string `json:"kind,omitempty"`
 * Aligned    bool   `json:"-"`
 * ```
 *
 * 即：空字符串字段被省略，`aligned` 是运行态字段、**不参与持久化**。
 * `seg.Meta["ruby_items"]` 存的就是这个形态，故领域层必须与之逐字节一致。
 */
export interface RubyItemWire {
  id: string
  source_base?: string
  source_text?: string
  target_base?: string
  target_text?: string
  kind?: string
}

/** 把运行态条目转换为持久化形态。 */
export function toWire(item: RubyItem): RubyItemWire {
  const wire: RubyItemWire = { id: item.id }
  if (item.source_base !== '') wire.source_base = item.source_base
  if (item.source_text !== '') wire.source_text = item.source_text
  if (item.target_base !== '') wire.target_base = item.target_base
  if (item.target_text !== '') wire.target_text = item.target_text
  if (item.kind !== '') wire.kind = item.kind
  return wire
}

/** 批量转换为持久化形态。 */
export function itemsToWire(items: readonly RubyItem[]): RubyItemWire[] {
  return items.map(toWire)
}

/** 从持久化形态还原为运行态条目（`aligned` 一律为 false，与 Go 重载后一致）。 */
export function fromWire(wire: RubyItemWire): RubyItem {
  return newRubyItem({
    id: wire.id ?? '',
    source_base: wire.source_base ?? '',
    source_text: wire.source_text ?? '',
    target_base: wire.target_base ?? '',
    target_text: wire.target_text ?? '',
    kind: wire.kind ?? '',
  })
}

/** 批量从持久化形态还原。 */
export function itemsFromWire(wires: readonly RubyItemWire[]): RubyItem[] {
  return wires.map(fromWire)
}

/**
 * 报告条目是否具备还原前提：`target_base` 或 `source_base` 非空。
 *
 * Go `Item.Restorable`。`RestoreItems` 的 total 计数与 revise 轮守卫的 want 口径
 * 共用本谓词，保证「永不可还原条目」的判定单源。
 */
export function isRestorable(item: RubyItem): boolean {
  return item.target_base !== '' || item.source_base !== ''
}

/**
 * 返回 item ID → item 的映射。ID 为空的条目以 `""` 为键（罕见；键冲突时后写覆盖先写）。
 *
 * Go `ItemsByID`。
 */
export function itemsById(items: readonly RubyItem[]): Map<string, RubyItem> {
  const map = new Map<string, RubyItem>()
  for (const item of items) {
    map.set(item.id, item)
  }
  return map
}

/**
 * 为所有 ID 为空的条目按顺序分配段内序号 `"1".."N"`；已有 ID 的条目保持不变。
 *
 * Go `AssignIDs`（就地修改切片元素）。
 */
export function assignIds(items: RubyItem[]): RubyItem[] {
  let next = 1
  for (const item of items) {
    if (item.id === '') {
      item.id = String(next)
      next++
    }
  }
  return items
}

/**
 * LLM 返回的单条注音标注输出（对应 Go `ruby.OutputEntry`）。
 *
 * `id` 可选：旧后端 / LLM 漏返时为空 → 还原/回填走位置回退。
 */
export interface OutputEntry {
  base: string
  text: string
  /** `"phonetic" | "semantic" | "creative"`。 */
  kind: string
  /** 段内条目 id（可选）。 */
  id: string
  /** v2 协议的 occurrence（1 基；0 表示未提供）。 */
  occurrence: number
  /**
   * 响应行字段解码失败时保留其可识别 ID：这样重复 ID 不会因为另一行解析失败
   * 而变成「唯一」的合法行（Go `OutputEntry.Invalid`，不参与序列化）。
   */
  invalid: boolean
}

/** 构造一个空输出条目（对应 Go 的零值 OutputEntry）。 */
export function newOutputEntry(init: Partial<OutputEntry> = {}): OutputEntry {
  return {
    base: init.base ?? '',
    text: init.text ?? '',
    kind: init.kind ?? '',
    id: init.id ?? '',
    occurrence: init.occurrence ?? 0,
    invalid: init.invalid ?? false,
  }
}

/** 所有合法的注音 kind 值（Go `ValidKinds`）。 */
export const VALID_KINDS: readonly string[] = ['phonetic', 'semantic', 'creative']

/** 判断 kind 是否为合法值（Go `isValidKind`）。 */
export function isValidKind(kind: string): boolean {
  return VALID_KINDS.includes(kind)
}

/**
 * 用 LLM 返回的 {@link OutputEntry} 回填 `target_base` / `target_text` / `kind`，
 * 并置 `aligned = true`（对应 Go `Item.MergeByOutput`）。
 *
 * 匹配优先级：
 * 1. **ID 匹配**：非空 ID（trim 后）的条目匹配同 ID 的 item（首次出现优先）。
 * 2. **位置回退**：仅当 ID 为空（含纯空白，旧后端 / LLM 漏返）时，按原顺序消费
 *    下一个未对齐 item。
 *
 * 重复 / 未知 ID 绝不崩溃，也绝不消费其它 item：重复 ID 首条生效、余者丢弃；
 * 未知 ID 直接丢弃。被丢弃条目对应的 item 保持未对齐 → 进入定向重试候选。
 * `base` 为空的条目忽略。就地修改 items（按索引操作）。
 */
export function mergeByOutput(items: RubyItem[], output: readonly OutputEntry[]): void {
  // item ID → 索引（重复 ID 取首个 item，保证确定性）
  const idxById = new Map<string, number>()
  for (let i = 0; i < items.length; i++) {
    const id = (items[i] as RubyItem).id
    if (id === '') continue
    if (idxById.has(id)) continue
    idxById.set(id, i)
  }

  let next = 0 // 位置回退游标：下一个未对齐 item 的索引
  for (const e of output) {
    if (e.base === '') continue // 空 base 的条目忽略，不参与任何匹配
    const id = e.id.trim()
    if (id !== '') {
      // ID 匹配：仅当该 item 尚未对齐时生效（重复 ID 首条胜出）。
      // 命中已对齐 item（重复 ID）或未命中（未知 ID）时丢弃该条目，
      // 不走位置回退——否则会把它错配到不相关 item 并掩盖为已对齐。
      const i = idxById.get(id)
      if (i !== undefined && !(items[i] as RubyItem).aligned) {
        const item = items[i] as RubyItem
        item.target_base = e.base
        item.target_text = e.text
        item.kind = e.kind
        item.aligned = true
      }
      continue
    }
    // 无 ID（含纯空白）→ 位置回退（向后兼容旧后端 / 漏返）
    while (next < items.length && (items[next] as RubyItem).aligned) {
      next++
    }
    if (next >= items.length) {
      break // 无空闲 item，丢弃该条目
    }
    const item = items[next] as RubyItem
    item.target_base = e.base
    item.target_text = e.text
    item.kind = e.kind
    item.aligned = true
    next++
  }
}

/** 返回所有 `aligned === false` 的条目（定向重试的候选集合，Go `Unaligned`）。 */
export function unaligned(items: readonly RubyItem[]): RubyItem[] {
  return items.filter((it) => !it.aligned)
}
