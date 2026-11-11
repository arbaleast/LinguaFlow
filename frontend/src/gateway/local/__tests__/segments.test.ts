/**
 * 段落 Repository / 路由单元测试（fake-indexeddb）。
 *
 * 覆盖三类后端语义：
 *
 * 1. **窗口分页**（`listResourceSegments`）：升序首页 / 游标续页 / desc 窗口倒序
 *    反转 / desc 无游标回落升序 / 锚点窗口（含 group_key 同章校验）/ limit+1
 *    页边界重复检测（409）/ 邻接游标存在性 / include_total 独立计数 /
 *    status + quality 三维 + search（大小写、整词、regex、字段）+ group_key 过滤；
 * 2. **CAS 与代际**：content_version 单调递增、expected_content_version 冲突、
 *    translation_generation 推进、批量审校 / approve-all 的修订历史；
 * 3. **search-replace 三段式**：preview 不写库、apply 单事务替换 + 快照、
 *    undo 逐字节还原 + 反向历史 + 重做、发散段落跳过（409）。
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { GatewayResult } from '@/gateway/contracts'
import { closeDatabase, openDatabase, type LinguaFlowDatabase } from '@/infrastructure/indexeddb/db'
import { ConflictError, getDeviceId, newRow } from '@/infrastructure/indexeddb/repo'
import type {
  BaseRow,
  ProjectRow,
  QualityIssueRow,
  ResourceRow,
  SegmentRow,
  SegmentStatus,
} from '@/infrastructure/indexeddb/types'

import { RepositoryNotFoundError, RepositoryValidationError } from '../repositories/errors'
import { createProject } from '../repositories/projects'
import {
  DuplicateSegmentIndexError,
  NoReversibleSegmentsError,
  SearchReplaceOperationNotFoundError,
  SegmentGroupMismatchError,
  SegmentIssueNotFoundError,
  SegmentMarkupInvalidError,
  applySearchReplace,
  approveAllResourceSegments,
  batchReviewSegments,
  listResourceSegmentGroups,
  listResourceSegments,
  previewSearchReplace,
  setSegmentIssueDisposition,
  undoSearchReplace,
  updateResourceSegment,
} from '../repositories/segments'
import type { LocalRequestContext, LocalRoute } from '../router'
import { segmentRoutes } from '../routes/segments'

let db: LinguaFlowDatabase

beforeEach(async () => {
  await closeDatabase()
  db = await openDatabase(`lf-segments-${Math.random().toString(36).slice(2)}`)
})

afterEach(async () => {
  await closeDatabase()
})

// ── 造数 ──

interface Fixture {
  project: ProjectRow
  resource: ResourceRow
}

async function seedFixture(format = 'txt'): Promise<Fixture> {
  const project = await createProject(db, { name: 'Segments' })
  const deviceId = await getDeviceId(db)
  const resource = await newRow<Omit<ResourceRow, keyof BaseRow>>(db, {
    sequence: 'resource',
    deviceId,
    fields: {
      project_id: project.localId,
      path: 'book.txt',
      name: 'book.txt',
      directory: '',
      format,
      total_segments: 0,
      translated_segments: 0,
      approved_segments: 0,
      current_source_revision_id: null,
      source_generation: 1,
      translation_generation: 1,
      opfs_path: null,
    },
  })
  await db.resources.put(resource)
  return { project, resource }
}

interface SegmentOverrides {
  source_text?: string
  target_text?: string
  status?: SegmentStatus
  review_comment?: string | null
  quality_issues?: QualityIssueRow[] | null
  group_key?: string | null
  meta?: Record<string, unknown> | null
}

async function insertSegment(
  fixture: Fixture,
  segmentIndex: number,
  overrides: SegmentOverrides = {},
): Promise<SegmentRow> {
  const deviceId = await getDeviceId(db)
  const sourceText = overrides.source_text ?? `source ${segmentIndex}`
  const row = await newRow<Omit<SegmentRow, keyof BaseRow>>(db, {
    sequence: 'segment',
    deviceId,
    fields: {
      resource_id: fixture.resource.localId,
      project_id: fixture.project.localId,
      segment_index: segmentIndex,
      source_text: sourceText,
      target_text: overrides.target_text ?? `target ${segmentIndex}`,
      status: overrides.status ?? 'translated',
      review_comment: overrides.review_comment ?? null,
      quality_issues: overrides.quality_issues ?? null,
      group_key: overrides.group_key ?? null,
      content_version: 1,
      meta: overrides.meta ?? null,
      reviewed_by: null,
      source_lower: sourceText.toLowerCase(),
      target_lower: (overrides.target_text ?? `target ${segmentIndex}`).toLowerCase(),
    },
  })
  await db.segments.put(row)
  return row
}

/** 造一条行形态的质量问题（`QualityIssueRow`）。 */
function issue(
  code: string,
  options: { severity?: 'warning' | 'error'; disposition?: string; matched?: string } = {},
): QualityIssueRow {
  return {
    segment_index: 0,
    severity: options.severity ?? 'warning',
    code,
    message: `${code} message`,
    start: 0,
    end: 1,
    target_text: options.matched ?? code,
    ...(options.disposition === undefined ? {} : { disposition: options.disposition }),
  }
}

async function segmentRowByIndex(fixture: Fixture, index: number): Promise<SegmentRow> {
  const row = await db.segments
    .where('resource_id')
    .equals(fixture.resource.localId)
    .filter((item) => item.segment_index === index)
    .first()
  if (!row) throw new Error(`segment ${index} not found`)
  return row
}

// ── 路由调用 ──

function context(
  path: Record<string, string>,
  options: { body?: unknown; query?: Record<string, unknown> } = {},
): LocalRequestContext {
  return {
    db,
    blobs: {} as LocalRequestContext['blobs'],
    vault: {} as LocalRequestContext['vault'],
    path,
    query: options.query ?? {},
    body: options.body,
  }
}

async function invoke(
  method: LocalRoute['method'],
  path: string,
  requestContext: LocalRequestContext,
): Promise<GatewayResult<unknown>> {
  const route = segmentRoutes.find((item) => item.method === method && item.path === path)
  if (!route) throw new Error(`未注册路由：${method} ${path}`)
  return route.handler(requestContext)
}

const BASE = '/projects/{projectId}/resources/{resourceId}/segments'

function pathParams(fixture: Fixture, extra: Record<string, string> = {}): Record<string, string> {
  return {
    projectId: String(fixture.project.localId),
    resourceId: String(fixture.resource.localId),
    ...extra,
  }
}

// ── 窗口分页 ──

describe('segments — 窗口分页', () => {
  it('升序首页：items 按 index 升序、next_cursor 为末条 index、prev 为 null、total 独立计数', async () => {
    const fixture = await seedFixture()
    for (let index = 0; index < 5; index++) await insertSegment(fixture, index)

    const page = await listResourceSegments(db, fixture.project.localId, fixture.resource.localId, {
      limit: 2,
      includeTotal: true,
    })

    expect(page.items.map((item) => item.segment_index)).toEqual([0, 1])
    expect(page.prev_cursor).toBeNull()
    expect(page.next_cursor).toBe('1')
    expect(page.total).toBe(5)
    // include_total=false 时字段不出现（不是 undefined 显式键）。
    const plain = await listResourceSegments(
      db,
      fixture.project.localId,
      fixture.resource.localId,
      {
        limit: 2,
      },
    )
    expect('total' in plain).toBe(false)
  })

  it('cursor 续页不重叠，prev_cursor 指向页首 index，末页 next_cursor 为 null', async () => {
    const fixture = await seedFixture()
    for (let index = 0; index < 5; index++) await insertSegment(fixture, index)

    const second = await listResourceSegments(
      db,
      fixture.project.localId,
      fixture.resource.localId,
      {
        limit: 2,
        cursor: 1,
        hasCursor: true,
      },
    )
    expect(second.items.map((item) => item.segment_index)).toEqual([2, 3])
    expect(second.prev_cursor).toBe('2')
    expect(second.next_cursor).toBe('3')

    const last = await listResourceSegments(db, fixture.project.localId, fixture.resource.localId, {
      limit: 2,
      cursor: 3,
      hasCursor: true,
    })
    expect(last.items.map((item) => item.segment_index)).toEqual([4])
    expect(last.prev_cursor).toBe('4')
    expect(last.next_cursor).toBeNull()
  })

  it('desc 窗口取 cursor 之前紧邻的一页，响应仍按 index 升序', async () => {
    const fixture = await seedFixture()
    for (let index = 0; index < 6; index++) await insertSegment(fixture, index)

    const page = await listResourceSegments(db, fixture.project.localId, fixture.resource.localId, {
      limit: 2,
      cursor: 4,
      hasCursor: true,
      direction: 'desc',
    })
    expect(page.items.map((item) => item.segment_index)).toEqual([2, 3])
    // 窗口之下仍有 0/1 → prev=2；窗口之上仍有 4/5 → next=3。
    expect(page.prev_cursor).toBe('2')
    expect(page.next_cursor).toBe('3')
  })

  it('desc 无游标仍按升序首页返回（descWindow 需要 cursorRequested）', async () => {
    const fixture = await seedFixture()
    for (let index = 0; index < 4; index++) await insertSegment(fixture, index)

    const page = await listResourceSegments(db, fixture.project.localId, fixture.resource.localId, {
      limit: 2,
      direction: 'desc',
    })
    expect(page.items.map((item) => item.segment_index)).toEqual([0, 1])
    expect(page.next_cursor).toBe('1')
  })

  it('anchor 从锚点 index 起开窗，锚点本身不满足筛选也照样作为起点', async () => {
    const fixture = await seedFixture()
    const rows: SegmentRow[] = []
    for (let index = 0; index < 5; index++) {
      rows.push(
        await insertSegment(fixture, index, { status: index === 2 ? 'pending' : 'translated' }),
      )
    }
    const anchor = rows[2]!

    const page = await listResourceSegments(db, fixture.project.localId, fixture.resource.localId, {
      anchorSegmentId: anchor.localId,
      status: 'translated',
      limit: 2,
    })
    // 锚点（index=2, pending）本身不匹配，窗口从其后首个匹配（index=3）开始。
    expect(page.items.map((item) => item.segment_index)).toEqual([3, 4])
    expect(page.prev_cursor).toBe('3')
    expect(page.next_cursor).toBeNull()
  })

  it('anchor 不属于 group_key 章节 → SegmentGroupMismatchError；锚点不存在 → 404', async () => {
    const fixture = await seedFixture()
    const anchor = await insertSegment(fixture, 0, { group_key: 'chapter-a' })
    await insertSegment(fixture, 1, { group_key: 'chapter-b' })

    await expect(
      listResourceSegments(db, fixture.project.localId, fixture.resource.localId, {
        anchorSegmentId: anchor.localId,
        groupKey: 'chapter-b',
      }),
    ).rejects.toBeInstanceOf(SegmentGroupMismatchError)

    await expect(
      listResourceSegments(db, fixture.project.localId, fixture.resource.localId, {
        anchorSegmentId: 999_999,
      }),
    ).rejects.toBeInstanceOf(RepositoryNotFoundError)
  })

  it('升序取到 limit+1 且第 limit+1 行与页尾同 index → DuplicateSegmentIndexError', async () => {
    const fixture = await seedFixture()
    await insertSegment(fixture, 0)
    await insertSegment(fixture, 2)
    await insertSegment(fixture, 2)
    await insertSegment(fixture, 3)

    // 页 [0,2a]，被丢弃的 2b 与页尾同 index：next 游标（=2）无法再表达 2b。
    await expect(
      listResourceSegments(db, fixture.project.localId, fixture.resource.localId, { limit: 2 }),
    ).rejects.toBeInstanceOf(DuplicateSegmentIndexError)
  })

  it('desc 窗口丢弃行与页首同 index → DuplicateSegmentIndexError', async () => {
    const fixture = await seedFixture()
    await insertSegment(fixture, 0)
    await insertSegment(fixture, 2)
    await insertSegment(fixture, 2)
    await insertSegment(fixture, 3)

    await expect(
      listResourceSegments(db, fixture.project.localId, fixture.resource.localId, {
        limit: 2,
        cursor: 4,
        hasCursor: true,
        direction: 'desc',
      }),
    ).rejects.toBeInstanceOf(DuplicateSegmentIndexError)
  })

  it('同一页内出现重复 index（未跨越页边界）不报错', async () => {
    const fixture = await seedFixture()
    await insertSegment(fixture, 0)
    await insertSegment(fixture, 1)
    await insertSegment(fixture, 2)
    await insertSegment(fixture, 2)

    const first = await listResourceSegments(
      db,
      fixture.project.localId,
      fixture.resource.localId,
      {
        limit: 2,
      },
    )
    expect(first.items.map((item) => item.segment_index)).toEqual([0, 1])

    const second = await listResourceSegments(
      db,
      fixture.project.localId,
      fixture.resource.localId,
      {
        limit: 2,
        cursor: Number(first.next_cursor),
        hasCursor: true,
      },
    )
    expect(second.items.map((item) => item.segment_index)).toEqual([2, 2])
    expect(second.next_cursor).toBeNull()
  })

  it('空结果 → items 空、两个游标均为 null；limit 非法值回落默认 50', async () => {
    const fixture = await seedFixture()
    const empty = await listResourceSegments(
      db,
      fixture.project.localId,
      fixture.resource.localId,
      {
        status: 'approved',
      },
    )
    expect(empty.items).toEqual([])
    expect(empty.next_cursor).toBeNull()
    expect(empty.prev_cursor).toBeNull()

    for (let index = 0; index < 3; index++) await insertSegment(fixture, index)
    const fallback = await listResourceSegments(
      db,
      fixture.project.localId,
      fixture.resource.localId,
      {
        limit: 0,
      },
    )
    expect(fallback.items).toHaveLength(3)
    const overMax = await listResourceSegments(
      db,
      fixture.project.localId,
      fixture.resource.localId,
      {
        limit: 500,
      },
    )
    expect(overMax.items).toHaveLength(3)
  })

  it('status / quality has|none / severity / code 过滤，dismissed 不计入问题', async () => {
    const fixture = await seedFixture()
    await insertSegment(fixture, 0, { status: 'pending' })
    await insertSegment(fixture, 1, {
      status: 'translated',
      quality_issues: [issue('length_ratio', { severity: 'warning' })],
    })
    await insertSegment(fixture, 2, {
      status: 'translated',
      quality_issues: [issue('untranslated', { severity: 'error' })],
    })
    await insertSegment(fixture, 3, {
      status: 'translated',
      quality_issues: [issue('length_ratio', { disposition: 'dismissed' })],
    })

    const repo = (options: Parameters<typeof listResourceSegments>[3]) =>
      listResourceSegments(db, fixture.project.localId, fixture.resource.localId, options)

    expect((await repo({ status: 'pending' })).items.map((item) => item.segment_index)).toEqual([0])
    expect((await repo({ qualityIssues: 'has' })).items.map((item) => item.segment_index)).toEqual([
      1, 2,
    ])
    // 只有 dismissed 问题的 3 视为无问题。
    expect((await repo({ qualityIssues: 'none' })).items.map((item) => item.segment_index)).toEqual(
      [0, 3],
    )
    expect(
      (await repo({ qualitySeverity: 'error' })).items.map((item) => item.segment_index),
    ).toEqual([2])
    expect(
      (await repo({ qualityCode: 'length_ratio' })).items.map((item) => item.segment_index),
    ).toEqual([1])
    // 非法枚举值安全降级为不过滤。
    expect((await repo({ qualityIssues: 'bogus' })).items).toHaveLength(4)
    expect((await repo({ qualityCode: 'not_a_code' })).items).toHaveLength(4)
    // 三维为 AND。
    expect(
      (
        await repo({
          qualityIssues: 'has',
          qualitySeverity: 'warning',
          qualityCode: 'length_ratio',
        })
      ).items.map((item) => item.segment_index),
    ).toEqual([1])
  })

  it('搜索：默认大小写敏感 / case_sensitive=false / whole_word / regex / search_field', async () => {
    const fixture = await seedFixture()
    await insertSegment(fixture, 0, { source_text: 'Hello World', target_text: '你好世界' })
    await insertSegment(fixture, 1, { source_text: 'hello there', target_text: 'HELLO 你好' })
    await insertSegment(fixture, 2, { source_text: 'shell', target_text: '壳' })

    const repo = (options: Parameters<typeof listResourceSegments>[3]) =>
      listResourceSegments(db, fixture.project.localId, fixture.resource.localId, options)

    // 默认区分大小写：只有 "Hello"。
    expect((await repo({ search: 'Hello' })).items.map((item) => item.segment_index)).toEqual([0])
    expect(
      (await repo({ search: 'hello', caseSensitive: false })).items.map(
        (item) => item.segment_index,
      ),
    ).toEqual([0, 1])
    // 整词：'hell' 不命中 'Hello'，但 whole_word 下 'shell' 内部的 'hell' 也不命中。
    expect((await repo({ search: 'hell', wholeWord: true })).items).toHaveLength(0)
    expect(
      (await repo({ search: 'Hello', wholeWord: true })).items.map((item) => item.segment_index),
    ).toEqual([0])
    // regex + 大小写不敏感：'^hello' 命中 0（Hello World）与 1（hello there）。
    expect(
      (await repo({ search: '^hello', matchMode: 'regex', caseSensitive: false })).items.map(
        (item) => item.segment_index,
      ),
    ).toEqual([0, 1])
    // regex 默认大小写敏感时只命中 1。
    expect(
      (await repo({ search: '^hello', matchMode: 'regex' })).items.map(
        (item) => item.segment_index,
      ),
    ).toEqual([1])
    // search_field=target 只搜译文；source 只搜原文。
    expect(
      (await repo({ search: 'HELLO', searchField: 'target', caseSensitive: false })).items.map(
        (item) => item.segment_index,
      ),
    ).toEqual([1])
    expect(
      (await repo({ search: 'shell', searchField: 'source' })).items.map(
        (item) => item.segment_index,
      ),
    ).toEqual([2])
    expect((await repo({ search: 'shell', searchField: 'target' })).items).toHaveLength(0)
  })

  it('group_key 过滤 + 搜索时 prev/next 按过滤后的存在性判断', async () => {
    const fixture = await seedFixture()
    await insertSegment(fixture, 0, { group_key: 'a', source_text: 'needle 0' })
    await insertSegment(fixture, 1, { group_key: 'b', source_text: 'needle 1' })
    await insertSegment(fixture, 2, { group_key: 'a', source_text: 'other' })
    await insertSegment(fixture, 3, { group_key: 'a', source_text: 'needle 3' })

    const page = await listResourceSegments(db, fixture.project.localId, fixture.resource.localId, {
      groupKey: 'a',
      search: 'needle',
      limit: 1,
    })
    expect(page.items.map((item) => item.segment_index)).toEqual([0])
    // index 1 命中搜索但不属于章节 a，因此 next 只能跳到 3 —— 存在性判断必须用
    // 完整过滤条件，而不是只看搜索命中。
    expect(page.next_cursor).toBe('0')

    const next = await listResourceSegments(db, fixture.project.localId, fixture.resource.localId, {
      groupKey: 'a',
      search: 'needle',
      limit: 1,
      cursor: 0,
      hasCursor: true,
    })
    expect(next.items.map((item) => item.segment_index)).toEqual([3])
    expect(next.prev_cursor).toBe('3')
    expect(next.next_cursor).toBeNull()
  })

  it('章节分组统计按 meta.epub_file 分组、按首个 index 排序、标题回退 group_key', async () => {
    const fixture = await seedFixture('epub')
    await insertSegment(fixture, 0, {
      status: 'translated',
      meta: { epub_file: 'chap1.xhtml', epub_chapter_title: '第一章' },
    })
    await insertSegment(fixture, 1, {
      status: 'approved',
      meta: { epub_file: 'chap1.xhtml', epub_chapter_title: '第一章' },
    })
    await insertSegment(fixture, 2, { status: 'pending', meta: { epub_file: 'chap2.xhtml' } })

    const groups = await listResourceSegmentGroups(
      db,
      fixture.project.localId,
      fixture.resource.localId,
    )
    expect(groups).toEqual([
      {
        group_key: 'chap1.xhtml',
        group_title: '第一章',
        segment_count: 2,
        translated_count: 2,
        approved_count: 1,
      },
      {
        group_key: 'chap2.xhtml',
        group_title: 'chap2.xhtml',
        segment_count: 1,
        translated_count: 0,
        approved_count: 0,
      },
    ])
  })
})

// ── CAS / 单段更新 ──

describe('segments — CAS 与代际', () => {
  it('PATCH target_text：trim、状态改 edited、content_version +1、翻译代际 +1', async () => {
    const fixture = await seedFixture()
    const row = await insertSegment(fixture, 0, { target_text: '旧译文' })

    const updated = await updateResourceSegment(
      db,
      fixture.project.localId,
      fixture.resource.localId,
      row.localId,
      { targetText: '  新译文  ' },
    )

    expect(updated.target_text).toBe('新译文')
    expect(updated.status).toBe('edited')
    expect(updated.content_version).toBe(row.content_version + 1)
    expect(updated.revision).toBe(row.revision + 1)

    const resource = await db.resources.where('localId').equals(fixture.resource.localId).first()
    expect(resource?.translation_generation).toBe(2)
    expect(resource?.source_generation).toBe(1)
  })

  it('expected_content_version 不匹配 → ConflictError（409 语义），且事务整体回滚', async () => {
    const fixture = await seedFixture()
    const row = await insertSegment(fixture, 0)

    await expect(
      updateResourceSegment(db, fixture.project.localId, fixture.resource.localId, row.localId, {
        targetText: 'x',
        expectedContentVersion: row.content_version + 5,
      }),
    ).rejects.toBeInstanceOf(ConflictError)

    const after = await db.segments.where('localId').equals(row.localId).first()
    expect(after?.target_text).toBe(row.target_text)
    expect(after?.content_version).toBe(row.content_version)
    // 代际推进在同一事务内，失败必须回滚。
    const resource = await db.resources.where('localId').equals(fixture.resource.localId).first()
    expect(resource?.translation_generation).toBe(1)
  })

  it('PATCH 校验：空 target / 无字段 / 段落不存在 均拒绝', async () => {
    const fixture = await seedFixture()
    const row = await insertSegment(fixture, 0)

    await expect(
      updateResourceSegment(db, fixture.project.localId, fixture.resource.localId, row.localId, {
        targetText: '   ',
      }),
    ).rejects.toBeInstanceOf(RepositoryValidationError)
    await expect(
      updateResourceSegment(db, fixture.project.localId, fixture.resource.localId, row.localId, {}),
    ).rejects.toBeInstanceOf(RepositoryValidationError)
    await expect(
      updateResourceSegment(db, fixture.project.localId, fixture.resource.localId, 999_999, {
        targetText: 'x',
      }),
    ).rejects.toBeInstanceOf(RepositoryNotFoundError)
  })

  it('仅 comment 变更不触碰 quality_issues', async () => {
    const fixture = await seedFixture()
    const issues = [issue('length_ratio')]
    const row = await insertSegment(fixture, 0, { quality_issues: issues })

    const updated = await updateResourceSegment(
      db,
      fixture.project.localId,
      fixture.resource.localId,
      row.localId,
      { comment: ' 备注 ' },
    )

    expect(updated.review_comment).toBe('备注')
    expect(updated.quality_issues).toEqual(issues)
    expect(updated.target_text).toBe(row.target_text)
    expect(updated.content_version).toBe(row.content_version + 1)
  })

  it('epub 译文结构非法 → SegmentMarkupInvalidError（txt 不做该校验）', async () => {
    const epub = await seedFixture('epub')
    const epubRow = await insertSegment(epub, 0)
    await expect(
      updateResourceSegment(db, epub.project.localId, epub.resource.localId, epubRow.localId, {
        targetText: '<b>unclosed',
      }),
    ).rejects.toBeInstanceOf(SegmentMarkupInvalidError)

    const txt = await seedFixture('txt')
    const txtRow = await insertSegment(txt, 0)
    const updated = await updateResourceSegment(
      db,
      txt.project.localId,
      txt.resource.localId,
      txtRow.localId,
      { targetText: '<b>unclosed' },
    )
    expect(updated.target_text).toBe('<b>unclosed')
  })
})

// ── 批量审校 ──

describe('segments — 批量审校 / approve-all', () => {
  it('batch-review approve：允许 translated/edited/rejected，跳过 pending，返回全部请求段落', async () => {
    const fixture = await seedFixture()
    const first = await insertSegment(fixture, 0, { status: 'translated' })
    const pending = await insertSegment(fixture, 1, { status: 'pending' })
    const rejected = await insertSegment(fixture, 2, { status: 'rejected' })

    const rows = await batchReviewSegments(db, fixture.project.localId, fixture.resource.localId, {
      segmentIds: [first.localId, pending.localId, rejected.localId],
      action: 'approve',
      comment: ' ok ',
    })

    expect(rows.map((row) => row.localId)).toEqual([
      first.localId,
      pending.localId,
      rejected.localId,
    ])
    expect(rows.map((row) => row.status)).toEqual(['approved', 'pending', 'approved'])
    expect(rows[0]?.review_comment).toBe('ok')
    expect(rows[0]?.content_version).toBe(first.content_version + 1)
    expect(rows[1]?.content_version).toBe(pending.content_version)

    const revisions = await db.segment_revisions
      .where('resource_id')
      .equals(fixture.resource.localId)
      .toArray()
    expect(revisions).toHaveLength(2)
    expect(revisions.every((revision) => revision.kind === 'review')).toBe(true)

    const resource = await db.resources.where('localId').equals(fixture.resource.localId).first()
    expect(resource?.translation_generation).toBe(2)
  })

  it('batch-review reject 只允许 translated/edited；空 ids / 非法 action / 跨资源 404', async () => {
    const fixture = await seedFixture()
    const translated = await insertSegment(fixture, 0, { status: 'translated' })
    const approved = await insertSegment(fixture, 1, { status: 'approved' })

    const rows = await batchReviewSegments(db, fixture.project.localId, fixture.resource.localId, {
      segmentIds: [translated.localId, approved.localId],
      action: 'reject',
    })
    expect(rows.map((row) => row.status)).toEqual(['rejected', 'approved'])

    await expect(
      batchReviewSegments(db, fixture.project.localId, fixture.resource.localId, {
        segmentIds: [],
        action: 'approve',
      }),
    ).rejects.toBeInstanceOf(RepositoryValidationError)
    await expect(
      batchReviewSegments(db, fixture.project.localId, fixture.resource.localId, {
        segmentIds: [translated.localId],
        action: 'nope',
      }),
    ).rejects.toBeInstanceOf(RepositoryValidationError)
    await expect(
      batchReviewSegments(db, fixture.project.localId, fixture.resource.localId, {
        segmentIds: [translated.localId, 999_999],
        action: 'approve',
      }),
    ).rejects.toBeInstanceOf(RepositoryNotFoundError)
  })

  it('approve-all 只批准 translated/edited/rejected 并清空备注，返回批准数量', async () => {
    const fixture = await seedFixture()
    await insertSegment(fixture, 0, { status: 'translated', review_comment: 'a' })
    await insertSegment(fixture, 1, { status: 'edited', review_comment: 'b' })
    await insertSegment(fixture, 2, { status: 'rejected', review_comment: 'c' })
    await insertSegment(fixture, 3, { status: 'pending' })
    await insertSegment(fixture, 4, { status: 'approved' })

    const count = await approveAllResourceSegments(
      db,
      fixture.project.localId,
      fixture.resource.localId,
    )
    expect(count).toBe(3)

    const rows = await db.segments.where('resource_id').equals(fixture.resource.localId).toArray()
    const byIndex = new Map(rows.map((row) => [row.segment_index, row]))
    expect(byIndex.get(0)?.status).toBe('approved')
    expect(byIndex.get(0)?.review_comment).toBeNull()
    expect(byIndex.get(3)?.status).toBe('pending')
    expect(byIndex.get(3)?.content_version).toBe(1)
  })
})

// ── 质量问题裁决 ──

describe('segments — QA disposition', () => {
  it('dismissed 写入裁决者/时间并让 quality_issues=has 不再命中；pending 撤销裁决', async () => {
    const fixture = await seedFixture()
    const row = await insertSegment(fixture, 0, {
      quality_issues: [issue('length_ratio', { matched: '译文' })],
    })

    const dismissed = await setSegmentIssueDisposition(
      db,
      fixture.project.localId,
      fixture.resource.localId,
      row.localId,
      { code: 'length_ratio', matchedText: '译文', disposition: 'dismissed', note: '有意' },
    )
    const dismissedIssue = dismissed.quality_issues?.[0] as unknown as Record<string, unknown>
    expect(dismissedIssue.disposition).toBe('dismissed')
    expect(dismissedIssue.decided_by).toBe(1)
    expect(typeof dismissedIssue.decided_at).toBe('string')
    expect(dismissedIssue.note).toBe('有意')
    expect(dismissed.content_version).toBe(row.content_version + 1)

    const hasFilter = await listResourceSegments(
      db,
      fixture.project.localId,
      fixture.resource.localId,
      {
        qualityIssues: 'has',
      },
    )
    expect(hasFilter.items).toHaveLength(0)

    const reinstated = await setSegmentIssueDisposition(
      db,
      fixture.project.localId,
      fixture.resource.localId,
      row.localId,
      { code: 'length_ratio', matchedText: '译文', disposition: 'pending' },
    )
    const reinstatedIssue = reinstated.quality_issues?.[0] as unknown as Record<string, unknown>
    expect(reinstatedIssue.disposition).toBe('pending')
    expect(reinstatedIssue.decided_by).toBeUndefined()
    expect(reinstatedIssue.decided_at).toBeUndefined()
    expect(reinstatedIssue.note).toBeUndefined()
  })

  it('指纹不匹配 → SegmentIssueNotFoundError；非法 disposition → 400 语义错误', async () => {
    const fixture = await seedFixture()
    const row = await insertSegment(fixture, 0, { quality_issues: [issue('length_ratio')] })

    await expect(
      setSegmentIssueDisposition(
        db,
        fixture.project.localId,
        fixture.resource.localId,
        row.localId,
        {
          code: 'untranslated',
          matchedText: 'length_ratio',
          disposition: 'dismissed',
        },
      ),
    ).rejects.toBeInstanceOf(SegmentIssueNotFoundError)

    await expect(
      setSegmentIssueDisposition(
        db,
        fixture.project.localId,
        fixture.resource.localId,
        row.localId,
        {
          code: 'length_ratio',
          matchedText: 'length_ratio',
          disposition: 'maybe',
        },
      ),
    ).rejects.toBeInstanceOf(RepositoryValidationError)
  })
})

// ── search-replace ──

describe('segments — search-replace', () => {
  it('preview 只读：统计命中段落/替换次数，max_results 截断样本', async () => {
    const fixture = await seedFixture()
    await insertSegment(fixture, 0, { target_text: 'foo foo' })
    await insertSegment(fixture, 1, { target_text: 'foo bar' })
    await insertSegment(fixture, 2, { target_text: 'nothing' })

    const preview = await previewSearchReplace(
      db,
      fixture.project.localId,
      fixture.resource.localId,
      { find: 'foo', replaceWith: 'baz', maxResults: 1 },
    )

    expect(preview.matchedSegmentCount).toBe(2)
    expect(preview.totalReplacements).toBe(3)
    expect(preview.items).toHaveLength(1)
    expect(preview.items[0]).toMatchObject({
      segmentIndex: 0,
      before: 'foo foo',
      after: 'baz baz',
      matchCount: 2,
    })

    // 不写库。
    const row = await segmentRowByIndex(fixture, 0)
    expect(row.target_text).toBe('foo foo')
    expect(await db.segment_revisions.count()).toBe(0)
  })

  it('apply 单事务替换：状态 edited、content_version +1、写 search_replace 历史、返回 operationId', async () => {
    const fixture = await seedFixture()
    const first = await insertSegment(fixture, 0, { target_text: 'foo foo' })
    const second = await insertSegment(fixture, 1, { target_text: 'foo' })
    await insertSegment(fixture, 2, { target_text: 'nothing' })

    const outcome = await applySearchReplace(
      db,
      fixture.project.localId,
      fixture.resource.localId,
      {
        find: 'foo',
        replaceWith: 'baz',
      },
    )

    expect(outcome.operationId).toMatch(/^sr-[0-9a-f]{32}$/)
    expect(outcome.applied).toHaveLength(2)
    // apply 与后端一致：范围内「当前已不含匹配」的段落都会记为
    // no_longer_matches（不是静默忽略），因此 skipped 里会出现 index=2。
    expect(outcome.skipped).toEqual([
      { segmentId: (await segmentRowByIndex(fixture, 2)).localId, reason: 'no_longer_matches' },
    ])

    const rows = await db.segments.where('resource_id').equals(fixture.resource.localId).toArray()
    const byIndex = new Map(rows.map((row) => [row.segment_index, row]))
    expect(byIndex.get(0)?.target_text).toBe('baz baz')
    expect(byIndex.get(0)?.status).toBe('edited')
    expect(byIndex.get(0)?.content_version).toBe(first.content_version + 1)
    expect(byIndex.get(1)?.content_version).toBe(second.content_version + 1)

    const revisions = await db.segment_revisions
      .where('operation_id')
      .equals(outcome.operationId)
      .toArray()
    expect(revisions).toHaveLength(2)
    expect(revisions.every((revision) => revision.kind === 'search_replace')).toBe(true)
    const firstRevision = revisions.find((revision) => revision.segment_id === first.localId)
    expect(firstRevision?.before.target_text).toBe('foo foo')
    expect(firstRevision?.after.target_text).toBe('baz baz')
  })

  it('apply 跳过 no_longer_matches / empty_result，并按 segment_ids 限定范围', async () => {
    const fixture = await seedFixture()
    const a = await insertSegment(fixture, 0, { target_text: 'foo' })
    const b = await insertSegment(fixture, 1, { target_text: 'foo bar' })
    const c = await insertSegment(fixture, 2, { target_text: 'foo foo' })

    const scoped = await applySearchReplace(db, fixture.project.localId, fixture.resource.localId, {
      find: 'foo',
      replaceWith: 'x',
      segmentIds: [a.localId, b.localId],
    })
    expect(scoped.applied.map((row) => row.localId)).toEqual([a.localId, b.localId])

    // 空结果：只把 foo 删掉 → trim 后为空 → empty_result。
    const empty = await applySearchReplace(db, fixture.project.localId, fixture.resource.localId, {
      find: 'x',
      replaceWith: '',
      segmentIds: [a.localId],
    })
    expect(empty.applied).toHaveLength(0)
    expect(empty.skipped).toEqual([{ segmentId: a.localId, reason: 'empty_result' }])

    // 不改动范围外段落 c。
    expect((await segmentRowByIndex(fixture, 2)).target_text).toBe('foo foo')
    expect(c.localId).toBeGreaterThan(0)
  })

  it('regex 模式按 $1 展开捕获组', async () => {
    const fixture = await seedFixture()
    await insertSegment(fixture, 0, { target_text: 'name: Alice' })

    const outcome = await applySearchReplace(
      db,
      fixture.project.localId,
      fixture.resource.localId,
      {
        find: 'name: (\\w+)',
        replaceWith: '姓名: $1',
        matchMode: 'regex',
      },
    )
    expect(outcome.applied[0]?.target_text).toBe('姓名: Alice')
  })

  it('undo 按 operationId 逐字节还原译文并写反向历史，可再撤销（重做）', async () => {
    const fixture = await seedFixture()
    const row = await insertSegment(fixture, 0, {
      target_text: '  foo  bar  ',
      status: 'translated',
      quality_issues: [issue('length_ratio')],
    })
    const beforeSnapshot = {
      target_text: row.target_text,
      status: row.status,
      quality_issues: row.quality_issues,
      review_comment: row.review_comment,
    }

    const applied = await applySearchReplace(
      db,
      fixture.project.localId,
      fixture.resource.localId,
      {
        find: 'foo',
        replaceWith: 'BAZ',
      },
    )
    expect((await segmentRowByIndex(fixture, 0)).target_text).toBe('  BAZ  bar  ')

    const undone = await undoSearchReplace(
      db,
      fixture.project.localId,
      fixture.resource.localId,
      applied.operationId,
    )
    expect(undone.undoOperationId).toMatch(/^sr-u-[0-9a-f]{32}$/)
    expect(undone.undone).toHaveLength(1)
    expect(undone.skipped).toEqual([])

    const restored = await segmentRowByIndex(fixture, 0)
    expect(restored.target_text).toBe(beforeSnapshot.target_text)
    expect(restored.status).toBe(beforeSnapshot.status)
    expect(restored.review_comment).toBe(beforeSnapshot.review_comment)
    expect(restored.quality_issues).toEqual(beforeSnapshot.quality_issues)
    // 内容版本只增不减。
    expect(restored.content_version).toBeGreaterThan(row.content_version + 1)

    // 原 operation 再撤销：当前已与 after 发散 → 409 语义。
    await expect(
      undoSearchReplace(db, fixture.project.localId, fixture.resource.localId, applied.operationId),
    ).rejects.toBeInstanceOf(NoReversibleSegmentsError)

    // 撤销「撤销」= 重做。
    const redone = await undoSearchReplace(
      db,
      fixture.project.localId,
      fixture.resource.localId,
      undone.undoOperationId,
    )
    expect(redone.undone).toHaveLength(1)
    expect((await segmentRowByIndex(fixture, 0)).target_text).toBe('  BAZ  bar  ')
  })

  it('undo 对后续被编辑的段落跳过（target_diverged）；operation 不存在 → 404', async () => {
    const fixture = await seedFixture()
    const first = await insertSegment(fixture, 0, { target_text: 'foo one' })
    await insertSegment(fixture, 1, { target_text: 'foo two' })

    const applied = await applySearchReplace(
      db,
      fixture.project.localId,
      fixture.resource.localId,
      {
        find: 'foo',
        replaceWith: 'baz',
      },
    )

    // 后续手工编辑第 1 段：撤销必须跳过它，不覆盖别人工作。
    await updateResourceSegment(
      db,
      fixture.project.localId,
      fixture.resource.localId,
      first.localId,
      {
        targetText: '人工改写',
      },
    )

    const undone = await undoSearchReplace(
      db,
      fixture.project.localId,
      fixture.resource.localId,
      applied.operationId,
    )
    expect(undone.skipped).toEqual([{ segmentId: first.localId, reason: 'target_diverged' }])
    expect(undone.undone).toHaveLength(1)
    expect((await segmentRowByIndex(fixture, 0)).target_text).toBe('人工改写')
    expect((await segmentRowByIndex(fixture, 1)).target_text).toBe('foo two')

    await expect(
      undoSearchReplace(db, fixture.project.localId, fixture.resource.localId, 'sr-does-not-exist'),
    ).rejects.toBeInstanceOf(SearchReplaceOperationNotFoundError)
  })
})

// ── 路由层 ──

describe('segments — 路由', () => {
  it('注册全部 schema path 模板（与 api/projects.ts 调用逐字一致）', () => {
    expect(segmentRoutes.map((route) => `${route.method} ${route.path}`).sort()).toEqual(
      [
        `GET ${BASE}`,
        `GET ${BASE}/groups`,
        `PATCH ${BASE}/{segmentId}`,
        `POST ${BASE}/batch-review`,
        `POST ${BASE}/approve-all`,
        `POST ${BASE}/{segmentId}/issues/disposition`,
        `POST ${BASE}/search-replace/preview`,
        `POST ${BASE}/search-replace/apply`,
        `POST ${BASE}/search-replace/{operationId}/undo`,
      ].sort(),
    )
  })

  it('GET 响应：游标为字符串，缺省为 null；limit / direction / anchor 组合非法 → 400', async () => {
    const fixture = await seedFixture()
    for (let index = 0; index < 3; index++) await insertSegment(fixture, index)

    const ok = await invoke('GET', BASE, context(pathParams(fixture), { query: { limit: 2 } }))
    expect(ok.response.status).toBe(200)
    expect(ok.data).toMatchObject({
      next_cursor: '1',
      prev_cursor: null,
      items: [{ segment_index: 0 }, { segment_index: 1 }],
    })

    const badDirection = await invoke(
      'GET',
      BASE,
      context(pathParams(fixture), { query: { direction: 'up' } }),
    )
    expect(badDirection.response.status).toBe(400)
    expect(badDirection.error).toMatchObject({ error_code: 'invalid_query_parameter' })

    const badLimit = await invoke(
      'GET',
      BASE,
      context(pathParams(fixture), { query: { limit: 201 } }),
    )
    expect(badLimit.response.status).toBe(400)

    const anchor = await segmentRowByIndex(fixture, 1)
    const both = await invoke(
      'GET',
      BASE,
      context(pathParams(fixture), {
        query: { anchor_segment_id: anchor.localId, cursor: 1 },
      }),
    )
    expect(both.response.status).toBe(400)

    const descAnchor = await invoke(
      'GET',
      BASE,
      context(pathParams(fixture), {
        query: { anchor_segment_id: anchor.localId, direction: 'desc' },
      }),
    )
    expect(descAnchor.response.status).toBe(400)

    const badRegex = await invoke(
      'GET',
      BASE,
      context(pathParams(fixture), { query: { search: '(', match_mode: 'regex' } }),
    )
    expect(badRegex.response.status).toBe(400)
    expect(badRegex.error).toMatchObject({ error_code: 'invalid_query_parameter' })
  })

  it('PATCH：source_text → 400 source_read_only；CAS 冲突 → 409；成功回 Segment DTO', async () => {
    const fixture = await seedFixture()
    const row = await insertSegment(fixture, 0)

    const readOnly = await invoke(
      'PATCH',
      `${BASE}/{segmentId}`,
      context(pathParams(fixture, { segmentId: String(row.localId) }), {
        body: { source_text: 'x' },
      }),
    )
    expect(readOnly.response.status).toBe(400)
    expect(readOnly.error).toMatchObject({ error_code: 'source_read_only' })

    const conflict = await invoke(
      'PATCH',
      `${BASE}/{segmentId}`,
      context(pathParams(fixture, { segmentId: String(row.localId) }), {
        body: { target_text: 'x', expected_content_version: 42 },
      }),
    )
    expect(conflict.response.status).toBe(409)

    const ok = await invoke(
      'PATCH',
      `${BASE}/{segmentId}`,
      context(pathParams(fixture, { segmentId: String(row.localId) }), {
        body: { target_text: ' 新 ', comment: 'c' },
      }),
    )
    expect(ok.response.status).toBe(200)
    expect(ok.data).toMatchObject({
      id: row.localId,
      segment_index: 0,
      target_text: '新',
      status: 'edited',
      review_comment: 'c',
    })
  })

  it('重复 index 跨页 → 409 duplicate_segment_index；批量审校空 ids → 400；缺失段落 → 404', async () => {
    const fixture = await seedFixture()
    await insertSegment(fixture, 0)
    await insertSegment(fixture, 2)
    await insertSegment(fixture, 2)
    await insertSegment(fixture, 3)

    const duplicated = await invoke(
      'GET',
      BASE,
      context(pathParams(fixture), { query: { limit: 2 } }),
    )
    expect(duplicated.response.status).toBe(409)
    expect(duplicated.error).toMatchObject({ error_code: 'duplicate_segment_index' })

    const emptyBatch = await invoke(
      'POST',
      `${BASE}/batch-review`,
      context(pathParams(fixture), { body: { segment_ids: [], action: 'approve' } }),
    )
    expect(emptyBatch.response.status).toBe(400)

    const missing = await invoke(
      'POST',
      `${BASE}/batch-review`,
      context(pathParams(fixture), { body: { segment_ids: [999_999], action: 'approve' } }),
    )
    expect(missing.response.status).toBe(404)
  })

  it('search-replace 三段式路由打通：preview → apply → undo', async () => {
    const fixture = await seedFixture()
    await insertSegment(fixture, 0, { target_text: 'foo bar' })

    const preview = await invoke(
      'POST',
      `${BASE}/search-replace/preview`,
      context(pathParams(fixture), {
        body: { find: 'foo', replace_with: 'baz', max_results: 20 },
      }),
    )
    expect(preview.response.status).toBe(200)
    expect(preview.data).toMatchObject({
      matched_segment_count: 1,
      total_replacements: 1,
      items: [{ before: 'foo bar', after: 'baz bar', match_count: 1 }],
    })

    const applied = await invoke(
      'POST',
      `${BASE}/search-replace/apply`,
      context(pathParams(fixture), { body: { find: 'foo', replace_with: 'baz' } }),
    )
    expect(applied.response.status).toBe(200)
    const applyBody = applied.data as {
      operation_id: string
      applied_count: number
      items: { target_text: string }[]
    }
    expect(applyBody.applied_count).toBe(1)
    expect(applyBody.items[0]?.target_text).toBe('baz bar')

    const undone = await invoke(
      'POST',
      `${BASE}/search-replace/{operationId}/undo`,
      context(pathParams(fixture, { operationId: applyBody.operation_id })),
    )
    expect(undone.response.status).toBe(200)
    expect(undone.data).toMatchObject({
      undone_count: 1,
      skipped_count: 0,
      items: [{ target_text: 'foo bar' }],
    })
  })

  it('disposition 路由：dismissed 返回整个段落 DTO；未命中问题 → 404 issue_not_found', async () => {
    const fixture = await seedFixture()
    const row = await insertSegment(fixture, 0, {
      quality_issues: [issue('length_ratio', { matched: '片段' })],
    })

    const ok = await invoke(
      'POST',
      `${BASE}/{segmentId}/issues/disposition`,
      context(pathParams(fixture, { segmentId: String(row.localId) }), {
        body: { code: 'length_ratio', matched_text: '片段', disposition: 'dismissed' },
      }),
    )
    expect(ok.response.status).toBe(200)
    const dto = ok.data as {
      quality_issues?: { disposition: string; span?: { matched_text: string } }[]
    }
    expect(dto.quality_issues?.[0]?.disposition).toBe('dismissed')
    expect(dto.quality_issues?.[0]?.span?.matched_text).toBe('片段')

    const missing = await invoke(
      'POST',
      `${BASE}/{segmentId}/issues/disposition`,
      context(pathParams(fixture, { segmentId: String(row.localId) }), {
        body: { code: 'untranslated', matched_text: '', disposition: 'dismissed' },
      }),
    )
    expect(missing.response.status).toBe(404)
    expect(missing.error).toMatchObject({ error_code: 'issue_not_found' })
  })

  it('approve-all / groups 路由返回后端外壳', async () => {
    const fixture = await seedFixture('epub')
    await insertSegment(fixture, 0, {
      status: 'translated',
      meta: { epub_file: 'chap.xhtml', epub_chapter_title: '章' },
    })

    const groups = await invoke('GET', `${BASE}/groups`, context(pathParams(fixture)))
    expect(groups.response.status).toBe(200)
    expect(groups.data).toMatchObject({
      items: [{ group_key: 'chap.xhtml', group_title: '章', segment_count: 1 }],
    })

    const approved = await invoke('POST', `${BASE}/approve-all`, context(pathParams(fixture)))
    expect(approved.response.status).toBe(200)
    expect(approved.data).toEqual({ approved_count: 1 })
  })
})
