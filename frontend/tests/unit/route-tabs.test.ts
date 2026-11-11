import { createApp } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { describe, expect, it, vi } from 'vitest'

import { useRouteTab } from '@/composables/useRouteTab'
import { legacyRedirectRoutes, workbenchUsageRedirect } from '@/router/legacy-redirects'

const stub = { render: () => null }

const createRouterWithLegacy = (): Router =>
  createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: stub },
      { path: '/playground', component: stub },
      { path: '/execution-config', component: stub },
      { path: '/backends', component: stub },
      ...legacyRedirectRoutes,
    ],
  })

const PROMPT_TABS = [{ value: 'translation' }, { value: 'bootstrap' }, { value: 'prune' }] as const

describe('useRouteTab', () => {
  it('falls back to the default tab when the query is missing', async () => {
    const router = createRouterWithLegacy()
    await router.push('/playground')
    await router.isReady()
    const app = createApp({})
    app.use(router)

    const { activeTab } = app.runWithContext(() => useRouteTab(PROMPT_TABS, 'translation'))
    expect(activeTab.value).toBe('translation')
  })

  it('reads the tab from the url so a direct link lands on the requested tab', async () => {
    const router = createRouterWithLegacy()
    await router.push('/playground?tab=bootstrap')
    await router.isReady()
    const app = createApp({})
    app.use(router)

    const { activeTab } = app.runWithContext(() => useRouteTab(PROMPT_TABS, 'translation'))
    expect(activeTab.value).toBe('bootstrap')
  })

  it('falls back to the default tab for an unknown query value', async () => {
    const router = createRouterWithLegacy()
    await router.push('/playground?tab=unknown')
    await router.isReady()
    const app = createApp({})
    app.use(router)

    const { activeTab } = app.runWithContext(() => useRouteTab(PROMPT_TABS, 'translation'))
    expect(activeTab.value).toBe('translation')
  })

  it('writes the tab into the query and keeps the remaining query parameters', async () => {
    const router = createRouterWithLegacy()
    await router.push('/playground?org_id=7')
    await router.isReady()
    const app = createApp({})
    app.use(router)

    const { activeTab, setTab } = app.runWithContext(() => useRouteTab(PROMPT_TABS, 'translation'))
    setTab('prune')

    await vi.waitFor(() => {
      expect(router.currentRoute.value.query.tab).toBe('prune')
    })
    expect(router.currentRoute.value.query.org_id).toBe('7')
    expect(activeTab.value).toBe('prune')
  })

  it('keeps the tab in sync when the browser navigates back and forth', async () => {
    const router = createRouterWithLegacy()
    await router.push('/playground')
    await router.isReady()
    const app = createApp({})
    app.use(router)

    const { activeTab, setTab } = app.runWithContext(() => useRouteTab(PROMPT_TABS, 'translation'))
    setTab('bootstrap')
    await vi.waitFor(() => {
      expect(router.currentRoute.value.query.tab).toBe('bootstrap')
    })

    router.back()
    await vi.waitFor(() => {
      expect(activeTab.value).toBe('translation')
    })
  })

  it('supports a custom query key for nested tab levels', async () => {
    const router = createRouterWithLegacy()
    await router.push('/playground?tab=prompts&promptTab=bootstrap')
    await router.isReady()
    const app = createApp({})
    app.use(router)

    const { activeTab, setTab } = app.runWithContext(() =>
      useRouteTab(PROMPT_TABS, 'translation', { queryKey: 'promptTab' }),
    )
    expect(activeTab.value).toBe('bootstrap')

    setTab('prune')
    await vi.waitFor(() => {
      expect(router.currentRoute.value.query.promptTab).toBe('prune')
    })
    // 一级 Tab 的 ?tab= 不被内层切换覆盖
    expect(router.currentRoute.value.query.tab).toBe('prompts')
  })
})

describe('legacy route redirects', () => {
  it.each([
    ['/bootstrap-prompt-templates', '/backends?tab=prompts&promptTab=bootstrap'],
    ['/prune-prompt-templates', '/backends?tab=prompts&promptTab=prune'],
    ['/execution-profiles', '/execution-config?tab=profiles'],
    ['/execution-plan-templates', '/execution-config?tab=plans'],
    ['/stats', '/backends?tab=usage'],
  ])('redirects %s to %s', async (legacy, expected) => {
    const router = createRouterWithLegacy()
    await router.push(legacy)
    await router.isReady()
    const current = router.currentRoute.value
    expect(`${current.path}${current.fullPath.slice(current.path.length)}`).toBe(expected)
  })

  it('redirects the merged prompt entry and remaps its inner tab query', async () => {
    const router = createRouterWithLegacy()
    await router.push('/prompt-templates?tab=bootstrap&org_id=7')
    await router.isReady()
    const current = router.currentRoute.value
    expect(current.path).toBe('/backends')
    expect(current.query.tab).toBe('prompts')
    expect(current.query.promptTab).toBe('bootstrap')
    expect(current.query.org_id).toBe('7')
  })

  it('redirects the merged prompt entry without an inner tab to the default panel', async () => {
    const router = createRouterWithLegacy()
    await router.push('/prompt-templates')
    await router.isReady()
    const current = router.currentRoute.value
    expect(current.path).toBe('/backends')
    expect(current.query.tab).toBe('prompts')
    expect(current.query.promptTab).toBeUndefined()
  })

  it('keeps other query parameters while redirecting', async () => {
    const router = createRouterWithLegacy()
    await router.push('/execution-profiles?org_id=7')
    await router.isReady()
    const current = router.currentRoute.value
    expect(current.path).toBe('/execution-config')
    expect(current.query.tab).toBe('profiles')
    expect(current.query.org_id).toBe('7')
  })

  it('lands on the merged page instead of looping back to the legacy path', async () => {
    const router = createRouterWithLegacy()
    await router.push('/stats')
    await router.isReady()
    expect(router.currentRoute.value.path).toBe('/backends')
    expect(router.currentRoute.value.query.tab).toBe('usage')
  })
})

describe('workbench usage redirect guard', () => {
  const to = (path: string, query: Record<string, unknown> = {}) =>
    ({
      path,
      fullPath: path,
      query,
      meta: {},
    }) as unknown as Parameters<typeof workbenchUsageRedirect>[0]

  it('moves the workbench usage tab to the backends page', () => {
    expect(workbenchUsageRedirect(to('/', { tab: 'usage', org_id: '7' }))).toEqual({
      path: '/backends',
      query: { tab: 'usage', org_id: '7' },
    })
  })

  it('leaves ordinary workbench visits untouched', () => {
    expect(workbenchUsageRedirect(to('/'))).toBeUndefined()
    expect(workbenchUsageRedirect(to('/', { tab: 'overview' }))).toBeUndefined()
    expect(workbenchUsageRedirect(to('/backends', { tab: 'usage' }))).toBeUndefined()
  })

  it('redirects /?tab=usage to /backends?tab=usage once installed on a router', async () => {
    const router = createRouterWithLegacy()
    router.beforeEach(workbenchUsageRedirect)
    await router.push('/?tab=usage')
    await router.isReady()
    expect(router.currentRoute.value.path).toBe('/backends')
    expect(router.currentRoute.value.query.tab).toBe('usage')

    await router.push('/')
    expect(router.currentRoute.value.path).toBe('/')
  })
})
