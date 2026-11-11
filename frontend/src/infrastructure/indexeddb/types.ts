/**
 * 本地存储层的行类型（IndexedDB / Dexie）。
 *
 * ## 命名与 ID 约定
 *
 * - **内部主键** `id` 是 UUID 字符串（云同步友好，且不泄漏本地自增节奏）。
 * - **对外 ID** `localId` 是**数字**，用于在 `LocalGateway` 的响应里复刻后端
 *   `ent` 的自增 ID 语义——前端 30 个 Store 与组件全部按 `id: number` 消费
 *   （如 `segment.ts` 的 `anchor_segment_id`、`api/projects.ts` 的
 *   `path: { projectId, resourceId, segmentId }`）。
 * - **同步元字段**（云同步 Phase 6 预留）：`createdAt` / `updatedAt` / `revision`
 *   / `deletedAt` / `deviceId` / `dirty`。
 *
 * ## 业务字段命名
 *
 * 业务字段沿用 **snake_case**（与后端 ent 的 JSON tag、`api/types.d.ts` 的 DTO 一致），
 * 同步元字段用 camelCase（前端惯例）。这一区分是刻意的：业务字段要能被后端
 * 直接消费，同步元字段是浏览器本地概念。
 */

/** 云同步元字段（所有业务表统一携带）。 */
export interface SyncMeta {
  /** 单调递增版本号：每次写入 +1，替代后端 `ent.ContentVersion` 的 CAS 语义。 */
  revision: number
  /** 软删墓碑；非空表示该行已删除，等待云同步确认。 */
  deletedAt: string | null
  /** 最后写入设备标识（Phase 6 冲突裁决用）。 */
  deviceId: string
  /** 是否存在待推送的本地变更（outbox 标记）。 */
  dirty: boolean
}

/** 所有业务表的公共字段。 */
export interface BaseRow extends SyncMeta {
  /** UUID 主键。 */
  id: string
  /** 对外暴露的数字 ID（复刻后端自增 ID 语义）。 */
  localId: number
  /** ISO8601 创建时间。 */
  createdAt: string
  /** ISO8601 更新时间。 */
  updatedAt: string
}

/** 段落状态（对应后端 `model.Segment.Status`）。 */
export type SegmentStatus = 'pending' | 'translated' | 'edited' | 'approved' | 'rejected'

/** 项目行。 */
export interface ProjectRow extends BaseRow {
  name: string
  source_lang: string
  target_lang: string
  glossary_enabled: boolean
  config: Record<string, unknown>
  storage_space_id: number | null
  storage_generation: number
  output_generation: number
  storage_state: 'active' | 'draining' | 'migrating' | 'legacy_migration' | 'legacy_rollback'
  owner_user_id: number | null
}

/** 资源行。 */
export interface ResourceRow extends BaseRow {
  project_id: number
  /** 项目内规范化相对路径（`/` 分隔）。 */
  path: string
  /** 资源显示名（等同 basename）。 */
  name: string
  /** 所在目录（根目录为空串）。 */
  directory: string
  format: string
  total_segments: number
  translated_segments: number
  approved_segments: number
  current_source_revision_id: number | null
  source_generation: number
  translation_generation: number
  /** OPFS 中的对象键；源文件本体不进 IndexedDB。 */
  opfs_path: string | null
}

/** 源修订行（对应后端 `SourceRevision`）。 */
export interface SourceRevisionRow extends BaseRow {
  resource_id: number
  /** sha256 十六进制。 */
  sha256: string
  size: number
  parser_version: string
  verification_state: string
  retain_until: string | null
  /** OPFS 对象键（源文件二进制）。 */
  opfs_blob_key: string | null
  /** 是否为当前生效的修订。 */
  current: boolean
}

/** 段落行。 */
export interface SegmentRow extends BaseRow {
  resource_id: number
  project_id: number
  /** 资源内段落序号（窗口分页的排序键）。 */
  segment_index: number
  source_text: string
  target_text: string
  status: SegmentStatus
  review_comment: string | null
  /** QA 质量问题列表（对应 `qa.QualityIssue` 的 JSON 形态）。 */
  quality_issues: QualityIssueRow[] | null
  /** 段落分组键（EPUB 章节）；非 EPUB 时为 null。 */
  group_key: string | null
  /** 段落级 CAS 版本（单调递增）。 */
  content_version: number
  /** 段落元信息（parser 注入的格式信息）。 */
  meta: Record<string, unknown> | null
  /** 审核人（本地模式恒为 null）。 */
  reviewed_by: number | null
  /** 搜索用的小写原文（`case_sensitive=false` 时命中）。 */
  source_lower: string
  /** 搜索用的小写译文。 */
  target_lower: string
}

/** QA 质量问题（对应 `qa.QualityIssue` 的 JSON 形态，字段名与后端一致）。 */
export interface QualityIssueRow {
  segment_index: number
  severity: 'warning' | 'error'
  code: string
  message: string
  start: number
  end: number
  source_text?: string
  target_text?: string
  disposition?: string
  disposition_comment?: string
  decided_at?: string
  decided_by?: number
}

/** 段落修订行（撤销历史）。 */
export interface SegmentRevisionRow extends BaseRow {
  segment_id: number
  project_id: number
  resource_id: number
  /** 修订前快照。 */
  before: SegmentSnapshot
  /** 修订后快照。 */
  after: SegmentSnapshot
  operation_id: string
  /** `replace` / `reverse` / `review` / `search_replace`。 */
  kind: string
}

/** 段落快照（撤销用）。 */
export interface SegmentSnapshot {
  source_text: string
  target_text: string
  status: SegmentStatus
  review_comment: string | null
  quality_issues: QualityIssueRow[] | null
  content_version: number
}

/** 术语条目行。 */
export interface GlossaryEntryRow extends BaseRow {
  project_id: number
  source: string
  target: string
  case_sensitive: boolean
  forbidden: boolean
  mandatory: boolean
  notes: string
  /** 归一化源词（用于唯一约束与大小写不敏感查找）。 */
  source_key: string
}

/** 翻译记忆行。 */
export interface TmEntryRow extends BaseRow {
  project_id: number
  source_text: string
  target_text: string
  source_lang: string
  target_lang: string
  /** `hash.Full(source)` 的小写十六进制。 */
  source_hash: string
  usage_count: number
}

/** 提示词模板 / 执行配置的公共形态（5 类模板同构）。 */
export interface TemplateRow extends BaseRow {
  name: string
  description: string
  /** `system`（内置、不可改）/ `user`。 */
  scope: 'system' | 'user'
  owner_user_id: number | null
  /** 模板正文（翻译/抽取/精简模板）。 */
  content: string
  /** 执行计划 / 执行策略的配置 JSON。 */
  config: Record<string, unknown> | null
  schema_version: number
  profile_id: number | null
  rounds: Record<string, unknown> | null
  ruby_retry: Record<string, unknown> | null
  /** 内置模板标识（内置实体的虚拟 ID）。 */
  builtin_id: number | null
}

/** 翻译提示词模板行。 */
export type TranslationPromptTemplateRow = TemplateRow
/** 术语抽取提示词模板行。 */
export type BootstrapPromptTemplateRow = TemplateRow
/** 术语精简提示词模板行。 */
export type PrunePromptTemplateRow = TemplateRow
/** 执行计划模板行。 */
export type ExecutionPlanTemplateRow = TemplateRow
/** 执行策略行。 */
export type ExecutionProfileRow = TemplateRow

/** AI 后端行。 */
export interface BackendRow extends BaseRow {
  name: string
  backend_type: 'openai' | 'anthropic' | 'google' | 'custom'
  /** 后端 options JSON。 */
  options: Record<string, unknown>
  credential_id: number | null
  rate_limit_per_minute: number
  enabled: boolean
}

/** 凭据保险库行（**只存密文**）。 */
export interface CredentialVaultRow extends BaseRow {
  name: string
  provider: string
  /** 当前生效版本号。 */
  current_version: number
  /** 是否已吊销。 */
  revoked: boolean
  /** 版本列表（密文）。 */
  versions: CredentialVersionRow[]
}

/** 凭据密文版本。 */
export interface CredentialVersionRow {
  version: number
  /** AES-GCM 密文（base64）。 */
  ciphertext: string
  /** 随机 nonce（base64）。 */
  nonce: string
  /** 派生密钥标识。 */
  key_id: string
  created_at: string
  revoked: boolean
}

/** 任务行。 */
export interface JobRow extends BaseRow {
  project_id: number
  status: 'pending' | 'running' | 'pausing' | 'paused' | 'completed' | 'failed' | 'cancelled'
  trigger_type: string
  retry_epoch: number
  pause_requested: boolean
  execution_plan_id: number | null
  execution_config: Record<string, unknown> | null
  progress_total: number
  progress_completed: number
  resource_count: number
  resource_completed: number
  resource_failed: number
  error_message: string | null
  retention_anchor_at: string | null
}

/** 任务资源行。 */
export interface JobResourceRow extends BaseRow {
  job_id: number
  resource_id: number
  segment_ids: number[]
  work_weight: number
  output_path: string | null
  source_revision_id: number | null
  source_generation: number
  status: string
}

/** 任务轮次行。 */
export interface JobRoundRow extends BaseRow {
  job_id: number
  resource_id: number
  round_index: number
  manifest_sealed: boolean
  pool_index: number
  mode: string
  segment_total: number
  segment_completed: number
  status: string
}

/** 任务轮次段落行。 */
export interface JobRoundSegmentRow extends BaseRow {
  job_round_id: number
  segment_id: number
  /** 幂等提交键。 */
  commit_id: string
  candidate_id: string | null
  outcome: string
}

/** 工作项行。 */
export interface WorkItemRow extends BaseRow {
  job_id: number
  state: string
  next_attempt_at: string | null
  retry_epoch: number
  pool_index: number
  attempts: number
  candidate_id: string | null
  cursor: Record<string, unknown> | null
}

/** 候选行（CAS 基线）。 */
export interface WorkCandidateRow extends BaseRow {
  /** 候选身份键（四元组）。 */
  identity: string
  work_item_id: number
  state: string
  dto_version: number
  snapshot_digest: string
  baseline_version: number
  baseline_target: string
  baseline_status: string
  payload: Record<string, unknown>
  payload_bytes: number
}

/** 工作请求行。 */
export interface WorkRequestRow extends BaseRow {
  identity: string
  stage: string
  backend_id: number
  members: number[]
  debits: Record<string, unknown> | null
  glossary_receipt: Record<string, unknown> | null
  usage_known: boolean
  tokens: number
  duration_ms: number
  state: string
}

/** 任务事件行（对应 SSE 事件）。 */
export interface JobEventRow {
  /** 复合主键：`jobId:seq`。 */
  id: string
  job_id: number
  seq: number
  type: string
  level: 'info' | 'warn' | 'warning' | 'error'
  stage: string | null
  message: string
  metadata: Record<string, unknown> | null
  created_at: string
}

/** 存储任务行。 */
export interface StorageTaskRow extends BaseRow {
  project_id: number
  kind: string
  status: string
  contract_version: number
  idempotency_key: string
  lease_token: string | null
  expected_source_generation: number
  expected_translation_generation: number
  expected_storage_generation: number
  expected_output_generation: number
  result: Record<string, unknown> | null
  phase: string
  cleanup_status: string
}

/** 导出产物行。 */
export interface ExportArtifactRow extends BaseRow {
  resource_id: number
  project_id: number
  filename: string
  status: string
  renderer_version: string
  rebuildable: boolean
  options: Record<string, unknown> | null
  /** OPFS 对象键（导出包本体）。 */
  opfs_key: string | null
}

/** 二进制对象元数据行（**本体在 OPFS**，本表只存元信息）。 */
export interface BlobRow extends BaseRow {
  project_id: number
  purpose: 'source' | 'export' | 'snapshot'
  size: number
  sha256: string
  /** 活动位置：OPFS 对象键。 */
  active_location: string
  status: string
}

/** 用量记录行。 */
export interface UsageRecordRow extends BaseRow {
  project_id: number
  api_calls: number
  input_tokens: number
  output_tokens: number
  segment_count: number
  source: string
  note: string
}

/** 活动日志行。 */
export interface ActivityLogRow extends BaseRow {
  action: string
  resource_type: string
  resource_id: string | null
  message: string
  metadata: Record<string, unknown> | null
  visibility_scope: string
}

/** 键值元数据行（自增序列、schema 版本、同步游标）。 */
export interface KvMetaRow {
  key: string
  value: unknown
  updated_at: string
}

/** 本地偏好行。 */
export interface PreferenceRow {
  scope: string
  key: string
  value: unknown
  updated_at: string
}

/**
 * 二进制 Blob 降级表（**仅在不支持 OPFS 时使用**）。
 *
 * 与元数据表**物理隔离**：按 key 懒加载，避免列表查询触发内存暴涨。
 */
export interface RawBlobRow {
  /** 对象键（与 OPFS 路径同构）。 */
  key: string
  /** 二进制内容。 */
  data: Blob
  size: number
  sha256: string
  created_at: string
}

/** 自增序列表（`localId` 的发号器）。 */
export interface SequenceRow {
  name: string
  value: number
}
