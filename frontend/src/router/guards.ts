import type { Router } from 'vue-router'

import { setUnauthorizedHandler } from '@/api/client'
import { t } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import { useServiceStore } from '@/stores/service'
import { safeReturnPath } from '@/auth/return-path'
import { workbenchUsageRedirect } from '@/router/legacy-redirects'

const PUBLIC_PATHS = new Set(['/login', '/register', '/service', '/auth/complete'])
const AUTH_ENTRY_PATHS = new Set(['/login', '/register'])

const ROUTE_TITLES: Record<string, string> = {
  '/': 'nav.dashboard',
  '/about': 'nav.about',
  '/admin/': 'nav.adminDashboard',
  '/admin/audit-logs': 'nav.adminAuditLogs',
  '/admin/settings': 'nav.adminSettings',
  '/admin/users': 'nav.adminUsers',
  '/backends': 'nav.backends',
  '/changelog': 'nav.changelog',
  '/execution-config': 'nav.executionConfig',
  '/login': 'login.title',
  '/auth/complete': 'authentication.callbackTitle',
  '/admin/authentication': 'authentication.adminTitle',
  '/projects': 'nav.projects',
  '/projects/[projectId]': 'nav.projects',
  '/profile': 'account.profile.title',
  '/register': 'register.title',
  '/security': 'account.security.title',
  '/service': 'service.title',
  '/operations': 'operations.title',
  '/settings/': 'workbench.settings.title',
  '/settings/profile': 'workbench.settings.profile',
  '/settings/security': 'workbench.settings.security',
  '/settings/preferences': 'workbench.settings.preferences',
  '/settings/storage': 'storage.title',
  '/admin/storage': 'storage.adminTitle',
  '/settings/team': 'workbench.settings.team',
  '/admin/runtime': 'runtime.title',
  '/tools/epub-rotate': 'nav.epubRotate',
  '/[...all]': 'notFound.title',
}

const applyDocumentTitle = (routeName: string | symbol | null | undefined): void => {
  const key = typeof routeName === 'string' ? ROUTE_TITLES[routeName] : undefined
  document.title = key ? `${t(key)} · LinguaFlow` : 'LinguaFlow'
}

export const installRouterGuards = (router: Router): void => {
  const service = useServiceStore()
  const auth = useAuthStore()

  setUnauthorizedHandler(() => {
    auth.clearSession()
    if (!service.isLocal && router.currentRoute.value.path !== '/login') {
      router.push('/login')
    }
  })

  // 旧用量页并入「AI 后端」：/ > /backends（仅当显式携带 tab=usage 时重定向）
  router.beforeEach(workbenchUsageRedirect)

  router.beforeEach((to) => {
    const service = useServiceStore()
    const auth = useAuthStore()

    if (!service.isAppReady) {
      return false
    }

    const isPublic = to.meta.public === true || PUBLIC_PATHS.has(to.path)
    const forceService = to.query.force === '1'

    if (service.isLocal && to.path === '/settings/team') return { path: '/settings/profile' }
    if (to.path.startsWith('/admin') && auth.user?.role !== 'admin') return { path: '/' }

    if (service.isLocal) {
      if (AUTH_ENTRY_PATHS.has(to.path)) {
        const redirect = safeReturnPath(to.query.redirect)
        return redirect ? { path: redirect } : { path: '/' }
      }

      if (to.path === '/service' && !forceService) {
        const redirect = safeReturnPath(to.query.redirect)
        return redirect ? { path: redirect } : { path: '/' }
      }

      if (!auth.user && !isPublic) {
        const redirect = safeReturnPath(to.query.redirect)
        return redirect ? { path: redirect } : { path: '/' }
      }

      return undefined
    }

    if (!service.hasSelected && to.path !== '/service') {
      return {
        path: '/service',
        query: to.fullPath !== '/' ? { redirect: to.fullPath } : {},
      }
    }

    if (auth.isAuthenticated && AUTH_ENTRY_PATHS.has(to.path)) {
      const redirect = safeReturnPath(to.query.redirect)
      return redirect ? { path: redirect } : { path: '/' }
    }

    if (!auth.isAuthenticated && !isPublic) {
      return {
        path: '/login',
        query: { redirect: to.fullPath },
      }
    }

    return undefined
  })

  router.afterEach((to) => {
    applyDocumentTitle(to.name)
  })
}
