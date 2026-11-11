/**
 * 凭据 / AI 后端 / 任务 / 统计 / 活动 Repository 单元测试（fake-indexeddb）。
 *
 * 覆盖：
 *
 * - 凭据 secret **只以密文落盘**（IndexedDB 里查不到明文）；
 * - 凭据列表 / 版本响应**不含** secret；
 * - 版本轮换递增、吊销标记、collect 回收非当前版本；
 * - 后端 CRUD + 绑定凭据 + `has_secret`；
 * - 任务状态流转与事件序号；
 * - 统计聚合与活动日志。
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CredentialVault } from '@/infrastructure/crypto/vault'
import { closeDatabase, openDatabase, type LinguaFlowDatabase } from '@/infrastructure/indexeddb/db'

import {
  createBackend,
  deleteBackend,
  getBackend,
  listBackends,
  toBackendDto,
  updateBackend,
} from '../repositories/backends'
import {
  collectCredentialVersions,
  createCredential,
  listCredentialVersions,
  listCredentials,
  revokeCredentialVersion,
  rotateCredential,
  toCredentialDto,
} from '../repositories/credentials'
import {
  appendActivity,
  appendJobEvent,
  listActivity,
  listJobEvents,
  listJobs,
  setJobStatus,
  systemStats,
  toActivityDto,
  toJobDto,
  usageStats,
} from '../repositories/jobs'
import { createProject } from '../repositories/projects'
import { RepositoryNotFoundError, RepositoryValidationError } from '../repositories/errors'

let db: LinguaFlowDatabase
let vault: CredentialVault
let projectId: number

beforeEach(async () => {
  await closeDatabase()
  db = await openDatabase(`lf-cred-${Math.random().toString(36).slice(2)}`)
  vault = new CredentialVault(db)
  projectId = (await createProject(db, { name: 'p' })).localId
})

afterEach(async () => {
  await closeDatabase()
})

describe('credentials Repository — 密文落盘与写只读纪律', () => {
  it('secret 只以密文落盘，IndexedDB 中查不到明文', async () => {
    const dto = await createCredential(db, vault, {
      provider: 'openai',
      secret: 'sk-SUPER-SECRET-VALUE',
    })

    expect(dto.provider).toBe('openai')
    expect(dto.endpoint).toBe('https://api.openai.com/v1')
    expect(dto.current_version).toBe(1)
    expect(JSON.stringify(dto)).not.toContain('SUPER-SECRET')

    // 直接扫表：不存在明文。
    const rows = await db.credential_vault.toArray()
    expect(rows.length).toBe(1)
    expect(JSON.stringify(rows)).not.toContain('SUPER-SECRET')
    expect(rows[0]?.versions[0]?.ciphertext).toBeTruthy()
  })

  it('列表与版本响应都不含 secret', async () => {
    await createCredential(db, vault, { provider: 'anthropic', secret: 'sk-ant-123' })
    const rows = await listCredentials(db)
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows.map(toCredentialDto))).not.toContain('sk-ant-123')

    const versions = await listCredentialVersions(db, rows[0]!.localId)
    expect(versions).toEqual([
      expect.objectContaining({ version: 1, revoked: false }),
    ])
    expect(JSON.stringify(versions)).not.toContain('sk-ant-123')
  })

  it('轮换递增版本号并把旧版本标记为已吊销', async () => {
    const created = await createCredential(db, vault, {
      provider: 'google',
      secret: 'v1-secret',
    })
    const rotated = await rotateCredential(db, vault, created.id, { secret: 'v2-secret' })
    expect(rotated.version).toBe(2)

    const versions = await listCredentialVersions(db, created.id)
    expect(versions.map((v) => v.version)).toEqual([1, 2])
    expect(versions.find((v) => v.version === 1)?.revoked).toBe(true)
    expect(versions.find((v) => v.version === 2)?.revoked).toBe(false)
  })

  it('吊销指定版本后标记为 revoked', async () => {
    const created = await createCredential(db, vault, { provider: 'openai', secret: 's' })
    await revokeCredentialVersion(db, created.id, 1)
    const versions = await listCredentialVersions(db, created.id)
    expect(versions[0]?.revoked).toBe(true)
  })

  it('collect 回收全部非当前版本', async () => {
    const created = await createCredential(db, vault, { provider: 'openai', secret: 'v1' })
    await rotateCredential(db, vault, created.id, { secret: 'v2' })
    await rotateCredential(db, vault, created.id, { secret: 'v3' })

    const result = await collectCredentialVersions(db, created.id)
    expect(result.deleted_versions).toBe(2)
    const versions = await listCredentialVersions(db, created.id)
    expect(versions).toHaveLength(1)
    expect(versions[0]?.version).toBe(3)
  })

  it('非法 provider / 空 secret 报校验错误', async () => {
    await expect(
      createCredential(db, vault, { provider: 'nope', secret: 'x' }),
    ).rejects.toBeInstanceOf(RepositoryValidationError)
    await expect(
      createCredential(db, vault, { provider: 'openai', secret: '  ' }),
    ).rejects.toBeInstanceOf(RepositoryValidationError)
  })

  it('凭据不存在时报 404 语义错误', async () => {
    await expect(listCredentialVersions(db, 999)).rejects.toBeInstanceOf(
      RepositoryNotFoundError,
    )
  })
})

describe('backends Repository', () => {
  it('创建后 DTO 字段齐全，has_secret 随凭据绑定变化', async () => {
    const created = await createBackend(db, {
      name: 'gpt',
      type: 'openai',
      credential_id: 7,
      rate_limit_per_minute: 60,
    })
    const dto = toBackendDto(created)
    expect(dto).toEqual({
      id: created.localId,
      name: 'gpt',
      type: 'openai',
      scope: 'user',
      options: {},
      rate_limit_per_minute: 60,
      has_secret: true,
      credential: { id: 7, version: 1 },
    })
  })

  it('更新与软删', async () => {
    const created = await createBackend(db, { name: 'a', type: 'openai' })
    const updated = await updateBackend(db, created.localId, { name: 'b' })
    expect(updated.name).toBe('b')
    expect(updated.revision).toBe(created.revision + 1)

    await deleteBackend(db, created.localId)
    expect(await getBackend(db, created.localId)).toBeUndefined()
    expect(await listBackends(db)).toHaveLength(0)
  })

  it('更新不存在的后端报 404 语义错误', async () => {
    await expect(updateBackend(db, 42, { name: 'x' })).rejects.toBeInstanceOf(
      RepositoryNotFoundError,
    )
  })
})

describe('jobs Repository', () => {
  it('任务列表按 localId 降序，DTO 字段对齐', async () => {
    const row = {
      project_id: projectId,
      status: 'running' as const,
      trigger_type: 'manual',
      retry_epoch: 0,
      pause_requested: false,
      execution_plan_id: null,
      execution_config: null,
      progress_total: 10,
      progress_completed: 3,
      resource_count: 1,
      resource_completed: 0,
      resource_failed: 0,
      error_message: null,
      retention_anchor_at: null,
    }
    const { newRow, getDeviceId } = await import('@/infrastructure/indexeddb/repo')
    const deviceId = await getDeviceId(db)
    const job = await newRow(db, { sequence: 'job', deviceId, fields: row })
    await db.jobs.put(job)

    const rows = await listJobs(db, projectId)
    expect(rows).toHaveLength(1)
    const dto = toJobDto(rows[0]!)
    expect(dto.progress).toEqual({ total: 10, completed: 3 })
    expect(dto.status).toBe('running')
    expect(dto.error_message).toBeUndefined()
  })

  it('任务事件按 seq 升序追加', async () => {
    const first = await appendJobEvent(db, { job_id: 1, type: 'job_started', message: 'a' })
    const second = await appendJobEvent(db, { job_id: 1, type: 'job_done', message: 'b' })
    expect(first.seq).toBe(1)
    expect(second.seq).toBe(2)
    const events = await listJobEvents(db, 1)
    expect(events.map((e) => e.seq)).toEqual([1, 2])
  })

  it('状态流转与不存在的任务', async () => {
    const { newRow, getDeviceId } = await import('@/infrastructure/indexeddb/repo')
    const deviceId = await getDeviceId(db)
    const job = await newRow(db, {
      sequence: 'job',
      deviceId,
      fields: {
        project_id: projectId,
        status: 'running' as const,
        trigger_type: 'manual',
        retry_epoch: 0,
        pause_requested: false,
        execution_plan_id: null,
        execution_config: null,
        progress_total: 0,
        progress_completed: 0,
        resource_count: 0,
        resource_completed: 0,
        resource_failed: 0,
        error_message: null,
        retention_anchor_at: null,
      },
    })
    await db.jobs.put(job)
    const updated = await setJobStatus(db, job.localId, 'paused')
    expect(updated.status).toBe('paused')
    expect(updated.revision).toBe(job.revision + 1)

    await expect(setJobStatus(db, 999, 'paused')).rejects.toBeInstanceOf(
      RepositoryNotFoundError,
    )
  })
})

describe('统计与活动日志', () => {
  it('系统统计按本地表聚合', async () => {
    const stats = await systemStats(db)
    expect(stats.total_users).toBe(1)
    expect(stats.total_projects).toBe(1)
    expect(stats.total_organizations).toBe(0)
    expect(stats.total_resources).toBe(0)
  })

  it('用量统计聚合 usage_records', async () => {
    const { newRow, getDeviceId } = await import('@/infrastructure/indexeddb/repo')
    const deviceId = await getDeviceId(db)
    const usage = await newRow(db, {
      sequence: 'usage',
      deviceId,
      fields: {
        project_id: projectId,
        api_calls: 3,
        input_tokens: 100,
        output_tokens: 50,
        segment_count: 2,
        source: 'openai',
        note: '',
      },
    })
    await db.usage_records.put(usage)

    const stats = await usageStats(db, projectId)
    expect(stats.api_calls).toBe(3)
    expect(stats.input_tokens).toBe(100)
    expect(stats.segment_count).toBe(2)
    expect(stats.usage_records).toBe(1)
  })

  it('活动日志按 localId 降序并可转 DTO', async () => {
    const first = await appendActivity(db, {
      action: 'project_created',
      resource_type: 'project',
      resource_id: String(projectId),
      message: 'ok',
    })
    const second = await appendActivity(db, {
      action: 'job_started',
      resource_type: 'job',
    })
    const rows = await listActivity(db, 10)
    expect(rows[0]!.localId).toBe(second.localId)
    expect(rows[1]!.localId).toBe(first.localId)
    const dto = toActivityDto(rows[1]!)
    expect(dto.action).toBe('project_created')
    expect(dto.resource_id).toBe(projectId)
  })
})
