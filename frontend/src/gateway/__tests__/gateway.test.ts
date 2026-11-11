/**
 * `frontend/src/gateway/` 双轨切换接缝测试。
 *
 * 验证三件事：
 *
 * 1. `'browser-local'` 模式下，`LocalGateway` 直接应答 `/ping`、`/mode`、`/auth/capabilities`；
 * 2. `'local'` / `'server'` 模式下，`RemoteGateway` **不接管**任何通道，
 *    请求原样回落到既有 openapi-fetch 实现（零回归）；
 * 3. 接缝位于 `src/api/` 层：`apiClient` 的调用形状不变，
 *    Store 与组件无需任何改动。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
// `browser-local` 模式下本地网关会打开 IndexedDB，Node 环境需要 polyfill。
import 'fake-indexeddb/auto'
import {
  dispatchEventStream,
  dispatchRequest,
  dispatchUpload,
  getGateway,
  getGatewayMode,
  isBrowserLocalGateway,
  localGateway,
  remoteGateway,
  setGatewayMode,
} from '../index'
import { BROWSER_LOCAL_MODE } from '../contracts/mode'

afterEach(() => {
  setGatewayMode('server')
  vi.unstubAllGlobals()
})

describe('gateway 运行模式切换', () => {
  it('默认生效的是远端网关（与 Phase 1 之前一致）', () => {
    expect(getGatewayMode()).toBe('server')
    expect(getGateway()).toBe(remoteGateway)
    expect(isBrowserLocalGateway()).toBe(false)
  })

  it('切换到 browser-local 后生效的是本地网关', () => {
    setGatewayMode(BROWSER_LOCAL_MODE)
    expect(getGatewayMode()).toBe(BROWSER_LOCAL_MODE)
    expect(getGateway()).toBe(localGateway)
    expect(isBrowserLocalGateway()).toBe(true)
  })

  it('切回 local / server 后重新生效远端网关', () => {
    setGatewayMode(BROWSER_LOCAL_MODE)
    setGatewayMode('local')
    expect(getGateway()).toBe(remoteGateway)
    setGatewayMode('server')
    expect(getGateway()).toBe(remoteGateway)
  })
})

describe('RemoteGateway 不接管任何通道（零回归）', () => {
  it('handle / upload / openEventStream 一律返回 null', () => {
    expect(remoteGateway.handle({ method: 'GET', path: '/ping' })).toBeNull()
    expect(remoteGateway.handle({ method: 'GET', path: '/mode' })).toBeNull()
    expect(
      remoteGateway.upload({
        url: '/projects/1/resources',
        files: [],
        idempotencyKey: 'k',
      }),
    ).toBeNull()
    expect(
      remoteGateway.openEventStream({
        url: '/api/v1/jobs/1/stream',
        onEvent: () => {},
        onOpen: () => {},
        onError: () => {},
      }),
    ).toBeNull()
  })

  it('在 server 模式下 dispatchRequest 返回 null（调用方必须回落）', () => {
    setGatewayMode('server')
    expect(dispatchRequest({ method: 'GET', path: '/ping' })).toBeNull()
    expect(dispatchUpload({ url: '/x', files: [], idempotencyKey: 'k' })).toBeNull()
    expect(
      dispatchEventStream({
        url: '/x',
        onEvent: () => {},
        onOpen: () => {},
        onError: () => {},
      }),
    ).toBeNull()
  })
})

describe('LocalGateway 直接应答服务发现类端点', () => {
  it('/ping 返回健康描述', async () => {
    setGatewayMode(BROWSER_LOCAL_MODE)
    const result = dispatchRequest({ method: 'GET', path: '/ping' })
    expect(result).not.toBeNull()
    const resolved = await result
    expect(resolved?.data).toEqual({ status: 'ok', service: 'linguaflow' })
    expect(resolved?.response.ok).toBe(true)
  })

  it('/mode 返回 browser-local', async () => {
    setGatewayMode(BROWSER_LOCAL_MODE)
    const resolved = await dispatchRequest({ method: 'GET', path: '/mode' })
    expect(resolved?.data).toEqual({ mode: 'browser-local' })
  })

  it('/auth/capabilities 返回与 Go local 模式同构的能力描述', async () => {
    setGatewayMode(BROWSER_LOCAL_MODE)
    const resolved = await dispatchRequest({ method: 'GET', path: '/auth/capabilities' })
    expect(resolved?.data).toMatchObject({
      mode: 'browser-local',
      connections: [],
      email_verification_enabled: false,
      password_reset_enabled: false,
      local_account: {
        signup: { email_requirement: 'optional', password_requirement: 'required' },
        signup_requirements: ['local_password'],
      },
    })
  })

  it('未接管的端点返回 null（调用方回落远端实现）', () => {
    setGatewayMode(BROWSER_LOCAL_MODE)
    // 下列端点尚未在本地实现（Phase 2 逐步补齐），必须回落远端。
    expect(dispatchRequest({ method: 'GET', path: '/storage/capabilities' })).toBeNull()
    expect(dispatchRequest({ method: 'POST', path: '/quick-translate' })).toBeNull()
    expect(dispatchUpload({ url: '/x', files: [], idempotencyKey: 'k' })).toBeNull()
    expect(
      dispatchEventStream({
        url: '/x',
        onEvent: () => {},
        onOpen: () => {},
        onError: () => {},
      }),
    ).toBeNull()
  })

  it('本地网关声明不支持事件流（Phase 1 尚未接入浏览器事件总线）', () => {
    expect(localGateway.supportsEventStream).toBe(false)
    expect(remoteGateway.supportsEventStream).toBe(true)
  })
})
