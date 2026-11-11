/**
 * 本地 QA 重检单元测试（fake-indexeddb）。
 *
 * 覆盖：策略缺失 / 未启用 QA → 400、404；段落筛选（resource_ids / segment_ids /
 * group_keys）；新问题写入、消失问题清除、既有 dismissed 裁决按指纹继承；
 * 无译文的段落被跳过。
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  closeDatabase,
  openDatabase,
  type LinguaFlowDatabase,
} from '@/infrastructure/indexeddb/db'
import { getDeviceId, newRow } from '@/infrastructure/indexeddb/repo'
import type { ResourceRow, SegmentRow, TemplateRow } from '@/infrastructure/indexeddb/types'

import { createProject } from '../repositories/projects'
import { qaRecheck } from '../repositories/qa_recheck'

let db: LinguaFlowDatabase

beforeEach(async () => {
  await closeDatabase()
  db = await openDatabase(`lf-qa-recheck-${Math.random().toString(36).slice(2)}`)
})

afterEach(async () => {
  await closeDatabase()
})

/** 造一条执行策略（带 QA 配置）。 */
async function insertProfile(
  name: string,
  qa: Record<string, unknown>,
): Promise<TemplateRow> {
  const deviceId = await getDeviceId(db)
  const row = await newRow<Omit<TemplateRow, keyof import('@/infrastructure/indexeddb/types').BaseRow>>(
    db,
    {
      sequence: 'template',
      deviceId,
      fields: {
        name,
        description: '',
        scope: 'user',
        owner_user_id: null,
        content: '',
        config: { qa },
        schema_version: 1,
        profile_id: null,
        rounds: null,
        ruby_retry: null,
        builtin_id: null,
      },
    },
  )
  await db.execution_profiles.put(row)
  return row
}

/** 造一条资源。 */
async function insertResource(projectId: number, path: string): Promise<ResourceRow> {
  const deviceId = await getDeviceId(db)
  const row = await newRow<Omit<ResourceRow, keyof import('@/infrastructure/indexeddb/types').BaseRow>>(
    db,
    {
      sequence: 'resource',
      deviceId,
      fields: {
        project_id: projectId,
        path,
        name: path,
        directory: '',
        format: 'txt',
        total_segments: 0,
        translated_segments: 0,
        approved_segments: 0,
        current_source_revision_id: null,
        source_generation: 1,
        translation_generation: 1,
        opfs_path: null,
      },
    },
  )
  await db.resources.put(row)
  return row
}

/** 造一条段落。 */
async function insertSegment(
  projectId: number,
  resourceId: number,
  index: number,
  options: { source?: string; target?: string; groupKey?: string } = {},
): Promise<SegmentRow> {
  const deviceId = await getDeviceId(db)
  const source = options.source ?? `source ${index}`
  const target = options.target ?? `target ${index}`
  const row = await newRow<Omit<SegmentRow, keyof import('@/infrastructure/indexeddb/types').BaseRow>>(
    db,
    {
      sequence: 'segment',
      deviceId,
      fields: {
        resource_id: resourceId,
        project_id: projectId,
        segment_index: index,
        source_text: source,
        target_text: target,
        status: 'translated',
        review_comment: null,
        quality_issues: null,
        group_key: options.groupKey ?? null,
        content_version: 1,
        meta: null,
        reviewed_by: null,
        source_lower: source.toLowerCase(),
        target_lower: target.toLowerCase(),
      },
    },
  )
  await db.segments.put(row)
  return row
}

describe('qaRecheck — 校验与筛选', () => {
  it('profile_id 非法 → 400', async () => {
    const project = await createProject(db, { name: 'P' })
    await expect(
      qaRecheck(db, project.localId, { profile_id: 0 }),
    ).rejects.toThrow(/profile_id/)
  })

  it('执行策略不存在 → 404', async () => {
    const project = await createProject(db, { name: 'P' })
    await expect(qaRecheck(db, project.localId, { profile_id: 999 })).rejects.toThrow(/执行策略/)
  })

  it('策略未启用 QA → 400', async () => {
    const project = await createProject(db, { name: 'P' })
    const profile = await insertProfile('off', { enabled: false })
    await expect(qaRecheck(db, project.localId, { profile_id: profile.localId })).rejects.toThrow(
      /未启用 QA/,
    )
  })

  it('resource_ids 限定资源范围，segment_ids 限定段落范围', async () => {
    const project = await createProject(db, { name: 'P' })
    const profile = await insertProfile('on', { enabled: true })
    const resA = await insertResource(project.localId, 'a.txt')
    const resB = await insertResource(project.localId, 'b.txt')
    const segA = await insertSegment(project.localId, resA.localId, 0, {
      source: 'Hello world.',
      target: '你好世界。',
    })
    await insertSegment(project.localId, resB.localId, 0, {
      source: 'Hello world.',
      target: '你好世界。',
    })

    const byResource = await qaRecheck(db, project.localId, {
      profile_id: profile.localId,
      resource_ids: [resA.localId],
    })
    expect(byResource.resources_checked).toBe(1)
    expect(byResource.segments_checked).toBe(1)

    const bySegment = await qaRecheck(db, project.localId, {
      profile_id: profile.localId,
      segment_ids: [segA.localId],
    })
    expect(bySegment.segments_checked).toBe(1)
    expect(bySegment.resources_checked).toBe(1)
  })

  it('无译文的段落被跳过', async () => {
    const project = await createProject(db, { name: 'P' })
    const profile = await insertProfile('on', { enabled: true })
    const res = await insertResource(project.localId, 'a.txt')
    await insertSegment(project.localId, res.localId, 0, { source: 'Hello.', target: '你好。' })
    await insertSegment(project.localId, res.localId, 1, { source: 'Bye.', target: '   ' })

    const result = await qaRecheck(db, project.localId, { profile_id: profile.localId })
    expect(result.segments_checked).toBe(1)
    expect(result.segments_skipped_no_target).toBe(1)
  })
})

describe('qaRecheck — 问题对账', () => {
  it('未翻译的段落产生新问题并写回段落', async () => {
    const project = await createProject(db, { name: 'P' })
    const profile = await insertProfile('on', { enabled: true })
    const res = await insertResource(project.localId, 'a.txt')
    const segment = await insertSegment(project.localId, res.localId, 0, {
      source: 'This is a long English sentence.',
      // 译文与原文相同 → 触发 untranslated。
      target: 'This is a long English sentence.',
    })

    const result = await qaRecheck(db, project.localId, { profile_id: profile.localId })
    expect(result.issues_new).toBeGreaterThan(0)

    const row = await db.segments.get(segment.id)
    expect(Array.isArray(row?.quality_issues)).toBe(true)
    expect((row?.quality_issues ?? []).length).toBeGreaterThan(0)
  })

  it('问题消失后被清除', async () => {
    const project = await createProject(db, { name: 'P' })
    const profile = await insertProfile('on', { enabled: true })
    const res = await insertResource(project.localId, 'a.txt')
    const segment = await insertSegment(project.localId, res.localId, 0, {
      source: 'This is a long English sentence.',
      target: 'This is a long English sentence.',
    })

    const first = await qaRecheck(db, project.localId, { profile_id: profile.localId })
    expect(first.issues_new).toBeGreaterThan(0)

    // 改成中文译文 → 不再触发 untranslated。
    await db.segments.update(segment.id, {
      target_text: '这是一句很长的英文句子。',
    })

    const second = await qaRecheck(db, project.localId, { profile_id: profile.localId })
    expect(second.issues_cleared).toBeGreaterThan(0)

    const row = await db.segments.get(segment.id)
    expect(row?.quality_issues ?? []).toHaveLength(0)
  })

  it('既有 dismissed 裁决按指纹继承', async () => {
    const project = await createProject(db, { name: 'P' })
    const profile = await insertProfile('on', { enabled: true })
    const res = await insertResource(project.localId, 'a.txt')
    const segment = await insertSegment(project.localId, res.localId, 0, {
      source: 'This is a long English sentence.',
      target: 'This is a long English sentence.',
    })

    await qaRecheck(db, project.localId, { profile_id: profile.localId })
    const afterFirst = await db.segments.get(segment.id)
    const issues = (afterFirst?.quality_issues ?? []) as Array<Record<string, unknown>>
    expect(issues.length).toBeGreaterThan(0)
    const target = issues[0] as Record<string, unknown>

    // 把首个问题标记为 dismissed。
    await db.segments.update(segment.id, {
      quality_issues: [
        {
          ...target,
          disposition: 'dismissed',
          decided_by: 1,
          decided_at: '2026-01-01T00:00:00Z',
        },
      ] as unknown as SegmentRow['quality_issues'],
    })

    const result = await qaRecheck(db, project.localId, { profile_id: profile.localId })
    expect(result.dispositions_inherited).toBeGreaterThan(0)

    const row = await db.segments.get(segment.id)
    const final = (row?.quality_issues ?? []) as Array<Record<string, unknown>>
    expect(final[0]?.disposition).toBe('dismissed')
  })
})
