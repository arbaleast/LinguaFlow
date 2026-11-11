import { describe, expect, it } from 'vitest'

import { APP_NAV_SECTIONS } from '@/layouts/navigation'

const navItems = APP_NAV_SECTIONS.flatMap((section) => section.items)
const navPaths = navItems.map((item) => item.path)

describe('app navigation', () => {
  it('converges the sidebar to seven entries', () => {
    expect(navItems).toHaveLength(7)
    expect(navPaths).toEqual([
      '/',
      '/operations',
      '/projects',
      '/backends',
      '/execution-config',
      '/tools/epub-rotate',
      '/admin',
    ])
  })

  it('keeps the configuration group for backends and execution config', () => {
    const configGroup = APP_NAV_SECTIONS.find((section) => section.labelKey === 'nav.configGroup')
    expect(configGroup?.items.map((item) => item.path)).toEqual(['/backends', '/execution-config'])
  })

  it('drops the standalone entries that are now merged into tabs', () => {
    expect(navPaths).not.toContain('/stats')
    expect(navPaths).not.toContain('/prompt-templates')
    expect(navPaths).not.toContain('/bootstrap-prompt-templates')
    expect(navPaths).not.toContain('/prune-prompt-templates')
    expect(navPaths).not.toContain('/execution-profiles')
    expect(navPaths).not.toContain('/execution-plan-templates')
  })
})
