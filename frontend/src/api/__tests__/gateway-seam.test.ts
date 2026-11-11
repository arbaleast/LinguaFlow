/**
 * `src/api/` 层的 Gateway 接缝测试。
 *
 * 验证「接缝下沉到 api 层」这一架构修正的核心命题：
 *
 * - `'browser-local'` 模式下，`apiClient.GET('/ping')` 由 `LocalGateway` 直接应答，
 *   **不产生任何网络请求**；
 * - `'server'` / `'local'` 模式下，同一调用原样回落到 openapi-fetch（零回归）；
 * - 调用形状（`client.GET(path, options)`）完全不变，Store 与组件零改动。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client-core'
import { setGatewayMode } from '@/gateway'

afterEach(() => {
  setGatewayMode('server')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('apiClient 的 Gateway 分发', () => {
  it('browser-local 模式下 /ping 由本地网关应答且不发起网络请求', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    setGatewayMode('browser-local')

    const { data, error, response } = await apiClient.GET('/ping')

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(error).toBeUndefined()
    expect(data).toEqual({ status: 'ok', service: 'linguaflow' })
    expect(response.ok).toBe(true)
  })

  it('browser-local 模式下 /mode 由本地网关应答', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    setGatewayMode('browser-local')

    const { data } = await apiClient.GET('/mode')

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(data).toEqual({ mode: 'browser-local' })
  })

  it('server 模式下未接管的端点原样回落到 openapi-fetch', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    // openapi-fetch 在建 client 时就捕获了全局 fetch，因此必须重置模块图后重新导入。
    vi.resetModules()
    const gatewayModule = await import('@/gateway')
    const clientModule = await import('@/api/client-core')
    gatewayModule.setGatewayMode('server')

    await clientModule.apiClient.GET('/storage/capabilities')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const requested = fetchSpy.mock.calls[0]?.[0]
    const url = requested instanceof Request ? requested.url : String(requested)
    expect(url).toContain('/storage/capabilities')
  })

  it('browser-local 模式下未接管的端点同样回落到 openapi-fetch', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    vi.resetModules()
    const gatewayModule = await import('@/gateway')
    const clientModule = await import('@/api/client-core')
    gatewayModule.setGatewayMode('browser-local')

    await clientModule.apiClient.GET('/storage/capabilities')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
