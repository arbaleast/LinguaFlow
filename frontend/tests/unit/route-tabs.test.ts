import { createApp } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { describe, expect, it, vi } from 'vitest'

import { useRouteTab } from '@/composables/useRouteTab'
import { legacyRedirectRoutes } from '@/router/legacy-redirects'

const stub = { render: () => null }

const createRouterWithLegacy = (): Router =>
  createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: stub },
      { path: '/prompt-templates', component: stub },
      { path: '/execution-config', component: stub },
      ...legacyRedirectRoutes,
    ],
  })

const PROMPT_TABS = [{ value: 'translation' }, { value: 'bootstrap' }, { value: 'prune' }] as const

describe('useRouteTab', () => {
  it('falls back to the default tab when the query is missing', async () => {
    const router = createRouterWithLegacy()
    await router.push('/prompt-templates')
    await router.isReady()
    const app = createApp({})
    app.use(router)

    const { activeTab } = app.runWithContext(() => useRouteTab(PROMPT_TABS, 'translation'))
    expect(activeTab.value).toBe('translation')
  })

  it('reads the tab from the url so a direct link lands on the requested tab', async () => {
    const router = createRouterWithLegacy()
    await router.push('/prompt-templates?tab=bootstrap')
    await router.isReady()
    const app = createApp({})
    app.use(router)

    const { activeTab } = app.runWithContext(() => useRouteTab(PROMPT_TABS, 'translation'))
    expect(activeTab.value).toBe('bootstrap')
  })

  it('falls back to the default tab for an unknown query value', async () => {
    const router = createRouterWithLegacy()
    await router.push('/prompt-templates?tab=unknown')
    await router.isReady()
    const app = createApp({})
    app.use(router)

    const { activeTab } = app.runWithContext(() => useRouteTab(PROMPT_TABS, 'translation'))
    expect(activeTab.value).toBe('translation')
  })

  it('writes the tab into the query and keeps the remaining query parameters', async () => {
    const router = createRouterWithLegacy()
    await router.push('/prompt-templates?org_id=7')
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
    await router.push('/prompt-templates')
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
})

describe('legacy route redirects', () => {
  it.each([
    ['/bootstrap-prompt-templates', '/prompt-templates?tab=bootstrap'],
    ['/prune-prompt-templates', '/prompt-templates?tab=prune'],
    ['/execution-profiles', '/execution-config?tab=profiles'],
    ['/execution-plan-templates', '/execution-config?tab=plans'],
    ['/stats', '/?tab=usage'],
  ])('redirects %s to %s', async (legacy, expected) => {
    const router = createRouterWithLegacy()
    await router.push(legacy)
    await router.isReady()
    const current = router.currentRoute.value
    expect(`${current.path}${current.fullPath.slice(current.path.length)}`).toBe(expected)
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
    expect(router.currentRoute.value.path).toBe('/')
    expect(router.currentRoute.value.query.tab).toBe('usage')
  })
})
