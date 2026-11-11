/**
 * 内置种子数据初始化（幂等）。
 *
 * 首次初始化本地数据库时，把 Phase 1 从后端导出的**内置提示词模板**与
 * **默认执行策略**写入对应表，使用户在纯浏览器本地模式下开箱即用。
 *
 * 幂等策略：以 `builtin_id`（后端内置实体的虚拟 ID，恒为 `-1`）作为标记；
 * 已存在则**只更新内容**，不重复插入、不重置用户自建副本。
 */
import {
  BUILTIN_BOOTSTRAP_PROMPT_TEMPLATE,
  BUILTIN_CATALOG,
  BUILTIN_EXECUTION_PROFILE,
  BUILTIN_ID,
  BUILTIN_PRUNE_PROMPT_TEMPLATE,
  BUILTIN_TRANSLATION_PROMPT_TEMPLATE,
} from '@/domain/prompt/seeds'
import type { LinguaFlowDatabase } from './db'
import { getDeviceId, newId, newRow, nowIso } from './repo'
import type {
  BootstrapPromptTemplateRow,
  ExecutionProfileRow,
  PrunePromptTemplateRow,
  TranslationPromptTemplateRow,
} from './types'

/** 内置条目的 scope（对应后端 `Scope: "system"`）。 */
const SYSTEM_SCOPE = 'system' as const

/** 内置 catalog 的元数据。 */
interface BuiltinMeta {
  id: number
  name: string
  description: string
}

const catalogMeta = (key: string): BuiltinMeta => {
  const meta = (BUILTIN_CATALOG as Record<string, BuiltinMeta>)[key]
  if (!meta) {
    throw new Error(`goldenv: 内置 catalog 缺少条目 ${key}`)
  }
  return meta
}

/**
 * 幂等写入一条内置模板。
 *
 * @param table 目标表
 * @param builtinKey catalog 中的键
 * @param content 模板正文
 */
async function seedTemplate<T extends TranslationPromptTemplateRow>(
  db: LinguaFlowDatabase,
  table: {
    where(key: string): { equals(value: number): { first(): Promise<T | undefined> } }
    put(row: T): Promise<string>
  },
  builtinKey: string,
  content: string,
  deviceId: string,
): Promise<'inserted' | 'updated' | 'unchanged'> {
  const meta = catalogMeta(builtinKey)
  const existing = await table.where('builtin_id').equals(meta.id).first()
  if (existing) {
    if (existing.content === content && existing.name === meta.name) {
      return 'unchanged'
    }
    await table.put({
      ...existing,
      name: meta.name,
      description: meta.description,
      content,
      revision: existing.revision + 1,
      updatedAt: nowIso(),
      deviceId,
      dirty: true,
    })
    return 'updated'
  }
  const row = await newRow(db, {
    sequence: builtinKey,
    deviceId,
    fields: {
      name: meta.name,
      description: meta.description,
      scope: SYSTEM_SCOPE,
      owner_user_id: null,
      content,
      config: null,
      schema_version: 1,
      profile_id: null,
      rounds: null,
      ruby_retry: null,
      builtin_id: meta.id,
    },
  })
  await table.put(row as T)
  return 'inserted'
}

/** 种子初始化结果。 */
export interface SeedResult {
  /** 新插入的内置条目数量。 */
  inserted: number
  /** 内容更新（幂等重跑时命中）的条目数量。 */
  updated: number
  /** 内容未变（幂等重跑时命中）的条目数量。 */
  unchanged: number
}

/**
 * 初始化内置种子数据（幂等）。
 *
 * 写入：
 *
 * - `translation_prompt_templates`（通用翻译提示词）
 * - `bootstrap_prompt_templates`（通用术语抽取提示词）
 * - `prune_prompt_templates`（通用术语精简提示词）
 * - `execution_profiles`（通用策略 / 默认执行策略配置）
 */
export async function seedBuiltins(db: LinguaFlowDatabase): Promise<SeedResult> {
  const deviceId = await getDeviceId(db)
  const result: SeedResult = { inserted: 0, updated: 0, unchanged: 0 }

  const steps: Array<Promise<'inserted' | 'updated' | 'unchanged'>> = [
    seedTemplate<TranslationPromptTemplateRow>(
      db,
      db.translation_prompt_templates,
      'translation_prompt_template',
      BUILTIN_TRANSLATION_PROMPT_TEMPLATE,
      deviceId,
    ),
    seedTemplate<BootstrapPromptTemplateRow>(
      db,
      db.bootstrap_prompt_templates,
      'bootstrap_prompt_template',
      BUILTIN_BOOTSTRAP_PROMPT_TEMPLATE,
      deviceId,
    ),
    seedTemplate<PrunePromptTemplateRow>(
      db,
      db.prune_prompt_templates,
      'prune_prompt_template',
      BUILTIN_PRUNE_PROMPT_TEMPLATE,
      deviceId,
    ),
    seedExecutionProfile(db, deviceId),
  ]

  for (const step of steps) {
    const outcome = await step
    if (outcome === 'inserted') result.inserted++
    else if (outcome === 'updated') result.updated++
    else result.unchanged++
  }
  return result
}

/** 幂等写入内置执行策略。 */
async function seedExecutionProfile(
  db: LinguaFlowDatabase,
  deviceId: string,
): Promise<'inserted' | 'updated' | 'unchanged'> {
  const meta = catalogMeta('translation_profile')
  const config = JSON.parse(JSON.stringify(BUILTIN_EXECUTION_PROFILE)) as Record<string, unknown>
  const existing = await db.execution_profiles.where('builtin_id').equals(meta.id).first()
  if (existing) {
    const same = JSON.stringify(existing.config) === JSON.stringify(config)
    if (same && existing.name === meta.name) {
      return 'unchanged'
    }
    await db.execution_profiles.put({
      ...existing,
      name: meta.name,
      description: meta.description,
      config,
      revision: existing.revision + 1,
      updatedAt: nowIso(),
      deviceId,
      dirty: true,
    })
    return 'updated'
  }
  const row = await newRow(db, {
    sequence: 'translation_profile',
    deviceId,
    fields: {
      name: meta.name,
      description: meta.description,
      scope: SYSTEM_SCOPE,
      owner_user_id: null,
      content: '',
      config,
      schema_version: 1,
      profile_id: null,
      rounds: null,
      ruby_retry: null,
      builtin_id: meta.id,
    },
  })
  await db.execution_profiles.put(row as ExecutionProfileRow)
  return 'inserted'
}

/** 内置实体的虚拟 ID（复刻后端 `templates.IsBuiltinID` 约定）。 */
export const BUILTIN_ENTITY_ID = BUILTIN_ID

/** 生成本地行的 UUID（供外部 Repository 复用）。 */
export { newId }
