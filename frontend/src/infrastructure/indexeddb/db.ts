/**
 * 本地数据库（Dexie / IndexedDB）定义。
 *
 * ## 分层约定（防坑红线）
 *
 * - **IndexedDB（本文件）只存结构化元数据、配置与分段文本**。
 *   EPUB / DOCX 源文件、导出压缩包等大二进制**一律不进业务表行**，
 *   它们的本体在 OPFS（见 `../opfs/`），本库只保留 `opfs_*_key` 外键。
 *   不支持 OPFS 时降级到 `raw_blobs` 独立表（与元数据表物理隔离，按 key 懒加载）。
 * - **所有业务表统一携带同步元字段**：`createdAt` / `updatedAt` / `revision` /
 *   `deletedAt` / `deviceId` / `dirty`（见 `types.ts` 的 `SyncMeta`）。
 *
 * ## Schema 版本
 *
 * - v1：Phase 2 初始版本，28 张业务表 + 4 张基础设施表。
 * - 后续版本在 `db.version(n)` 中追加迁移；**不得**修改已发布版本的 schema 字符串。
 */
import Dexie, { type Table } from 'dexie'
import type {
  ActivityLogRow,
  BackendRow,
  BlobRow,
  BootstrapPromptTemplateRow,
  CredentialVaultRow,
  ExecutionPlanTemplateRow,
  ExecutionProfileRow,
  ExportArtifactRow,
  GlossaryEntryRow,
  JobEventRow,
  JobResourceRow,
  JobRoundRow,
  JobRoundSegmentRow,
  JobRow,
  KvMetaRow,
  PreferenceRow,
  PrunePromptTemplateRow,
  ProjectRow,
  RawBlobRow,
  ResourceRow,
  SegmentRevisionRow,
  SegmentRow,
  SequenceRow,
  SourceRevisionRow,
  StorageTaskRow,
  TmEntryRow,
  TranslationPromptTemplateRow,
  UsageRecordRow,
  WorkCandidateRow,
  WorkItemRow,
  WorkRequestRow,
} from './types'

/** 当前 Schema 版本号。 */
export const SCHEMA_VERSION = 1

/**
 * 全部表名（导出 / 恢复 / 备份的权威清单）。
 *
 * 顺序即建库顺序；备份与恢复都以此为准，避免漏表。
 */
export const TABLE_NAMES = [
  // 核心业务域
  'projects',
  'resources',
  'source_revisions',
  'segments',
  'segment_revisions',
  'glossary_entries',
  'tm_entries',
  // 配置与凭据域
  'translation_prompt_templates',
  'bootstrap_prompt_templates',
  'prune_prompt_templates',
  'execution_plan_templates',
  'execution_profiles',
  'backends',
  'credential_vault',
  // 任务与状态域
  'jobs',
  'job_resources',
  'job_rounds',
  'job_round_segments',
  'work_items',
  'work_candidates',
  'work_requests',
  'job_events',
  // 存储与统计域
  'storage_tasks',
  'export_artifacts',
  'blobs',
  'usage_records',
  'activity_logs',
  // 基础设施表
  'kv_meta',
  'preferences',
  'raw_blobs',
  'sequences',
] as const

/** 表名联合类型。 */
export type TableName = (typeof TABLE_NAMES)[number]

/**
 * 本地数据库。
 *
 * 打开方式统一走 `openDatabase()`（带并发去重的惰性打开），不要直接 `new`。
 */
export class LinguaFlowDatabase extends Dexie {
  // ── 核心业务域 ──
  projects!: Table<ProjectRow, string>
  resources!: Table<ResourceRow, string>
  source_revisions!: Table<SourceRevisionRow, string>
  segments!: Table<SegmentRow, string>
  segment_revisions!: Table<SegmentRevisionRow, string>
  glossary_entries!: Table<GlossaryEntryRow, string>
  tm_entries!: Table<TmEntryRow, string>

  // ── 配置与凭据域 ──
  translation_prompt_templates!: Table<TranslationPromptTemplateRow, string>
  bootstrap_prompt_templates!: Table<BootstrapPromptTemplateRow, string>
  prune_prompt_templates!: Table<PrunePromptTemplateRow, string>
  execution_plan_templates!: Table<ExecutionPlanTemplateRow, string>
  execution_profiles!: Table<ExecutionProfileRow, string>
  backends!: Table<BackendRow, string>
  credential_vault!: Table<CredentialVaultRow, string>

  // ── 任务与状态域 ──
  jobs!: Table<JobRow, string>
  job_resources!: Table<JobResourceRow, string>
  job_rounds!: Table<JobRoundRow, string>
  job_round_segments!: Table<JobRoundSegmentRow, string>
  work_items!: Table<WorkItemRow, string>
  work_candidates!: Table<WorkCandidateRow, string>
  work_requests!: Table<WorkRequestRow, string>
  job_events!: Table<JobEventRow, string>

  // ── 存储与统计域 ──
  storage_tasks!: Table<StorageTaskRow, string>
  export_artifacts!: Table<ExportArtifactRow, string>
  blobs!: Table<BlobRow, string>
  usage_records!: Table<UsageRecordRow, string>
  activity_logs!: Table<ActivityLogRow, string>

  // ── 基础设施表 ──
  kv_meta!: Table<KvMetaRow, string>
  preferences!: Table<PreferenceRow, [string, string]>
  /** 二进制降级表（仅在无 OPFS 时使用）。 */
  raw_blobs!: Table<RawBlobRow, string>
  /** `localId` 自增序列发号器。 */
  sequences!: Table<SequenceRow, string>

  constructor(name = 'linguaflow') {
    super(name)
    this.version(1).stores({
      // 核心业务域
      projects: 'id, localId, name, updatedAt, deletedAt, storage_space_id',
      resources: 'id, localId, project_id, [project_id+path], format, updatedAt, deletedAt',
      source_revisions: 'id, localId, resource_id, [resource_id+current], updatedAt, deletedAt',
      segments:
        'id, localId, resource_id, project_id, [resource_id+segment_index], status, content_version, group_key, updatedAt, deletedAt',
      segment_revisions: 'id, segment_id, resource_id, project_id, operation_id, kind, updatedAt',
      glossary_entries:
        'id, localId, project_id, [project_id+source_key], source, target, forbidden, updatedAt, deletedAt',
      tm_entries:
        'id, localId, project_id, [project_id+source_hash], source_hash, usage_count, updatedAt, deletedAt',

      // 配置与凭据域
      translation_prompt_templates:
        'id, localId, name, scope, owner_user_id, builtin_id, updatedAt, deletedAt',
      bootstrap_prompt_templates:
        'id, localId, name, scope, owner_user_id, builtin_id, updatedAt, deletedAt',
      prune_prompt_templates:
        'id, localId, name, scope, owner_user_id, builtin_id, updatedAt, deletedAt',
      execution_plan_templates:
        'id, localId, name, scope, owner_user_id, builtin_id, profile_id, updatedAt, deletedAt',
      execution_profiles:
        'id, localId, name, scope, owner_user_id, builtin_id, updatedAt, deletedAt',
      backends: 'id, localId, name, backend_type, credential_id, enabled, updatedAt, deletedAt',
      credential_vault: 'id, localId, name, provider, revoked, updatedAt, deletedAt',

      // 任务与状态域
      jobs: 'id, localId, project_id, status, updatedAt, deletedAt',
      job_resources: 'id, job_id, resource_id, status, updatedAt',
      job_rounds: 'id, [job_id+resource_id+round_index], job_id, resource_id, status',
      job_round_segments: 'id, [job_round_id+segment_id], job_round_id, segment_id, commit_id',
      work_items: 'id, job_id, state, next_attempt_at, updatedAt',
      work_candidates: 'id, identity, work_item_id, state, updatedAt',
      work_requests: 'id, identity, state, updatedAt',
      job_events: 'id, [job_id+seq], job_id, seq, created_at',

      // 存储与统计域
      storage_tasks: 'id, project_id, kind, status, idempotency_key, updatedAt',
      export_artifacts: 'id, resource_id, project_id, status, updatedAt',
      blobs: 'id, localId, project_id, purpose, status, sha256, updatedAt, deletedAt',
      usage_records: 'id, project_id, createdAt, updatedAt',
      activity_logs: 'id, createdAt, action, resource_type, updatedAt',

      // 基础设施表
      kv_meta: 'key',
      preferences: '[scope+key]',
      raw_blobs: 'key',
      sequences: 'name',
    })
  }
}

/** 数据库实例（惰性打开）。 */
let dbInstance: LinguaFlowDatabase | null = null
let openPromise: Promise<LinguaFlowDatabase> | null = null

/** 获取数据库实例（未打开则同步创建；不触发网络与文件 IO）。 */
export function getDatabase(): LinguaFlowDatabase {
  if (!dbInstance) {
    dbInstance = new LinguaFlowDatabase()
  }
  return dbInstance
}

/**
 * 打开数据库（幂等并发去重）。
 *
 * 首次打开会触发 Dexie 的建库与升级回调；重复调用返回同一 Promise。
 */
export function openDatabase(name?: string): Promise<LinguaFlowDatabase> {
  if (openPromise) return openPromise
  const db = name ? new LinguaFlowDatabase(name) : getDatabase()
  openPromise = db.open().then(() => db)
  return openPromise
}

/** 关闭并重置数据库句柄（测试与「清空本地数据」用）。 */
export async function closeDatabase(): Promise<void> {
  if (dbInstance) {
    dbInstance.close()
  }
  dbInstance = null
  openPromise = null
}
