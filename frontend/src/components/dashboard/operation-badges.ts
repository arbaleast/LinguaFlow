/** 任务恢复卡片标题栏的轻量状态胶囊。 */
export type OperationBadgeTone = 'info' | 'warning' | 'danger' | 'neutral'

export interface OperationBadge {
  /** 同一列表内稳定的标识 */
  key: string
  /** 可选前缀文案（例如「运行中」）；省略时只展示数量 */
  label?: string
  /** 状态数量 */
  count: number
  tone: OperationBadgeTone
}
