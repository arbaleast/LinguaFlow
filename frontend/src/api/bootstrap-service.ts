import { browserLocalHealth, setGatewayMode } from '@/gateway'
import { normalizeServiceMode, type ServiceMode } from '@/gateway/contracts'
import { readBrowserLocalEnabled, writeBrowserLocalEnabled } from './browser-local-preference'
import { createApiClient, type ApiSchemas } from './client-core'
import { readStoredApiBaseUrl } from './token-storage'
import { captureSession, isSessionCurrent, normalizeApiBaseUrl } from './session-core'

export type { ServiceMode } from '@/gateway/contracts'
export { normalizeServiceMode } from '@/gateway/contracts'
export type ServiceProbe = { health: ApiSchemas['HealthResponse']; mode: ServiceMode }

export const DEFAULT_SERVICE_BASE_URL = '/api/v1'
const PROBE_TIMEOUT_MS = 10_000

const isHealth = (value: unknown): value is ApiSchemas['HealthResponse'] =>
  !!value && typeof value === 'object' && typeof (value as { status?: unknown }).status === 'string'

const isMode = (value: unknown): value is { mode: ServiceMode } =>
  !!value &&
  typeof value === 'object' &&
  ((value as { mode?: unknown }).mode === 'local' ||
    (value as { mode?: unknown }).mode === 'server' ||
    (value as { mode?: unknown }).mode === 'browser-local')

const probeSignal = (signal: AbortSignal | undefined, context: ReturnType<typeof captureSession>) =>
  AbortSignal.any([
    context.signal,
    AbortSignal.timeout(PROBE_TIMEOUT_MS),
    ...(signal ? [signal] : []),
  ])

const isCurrent = (context: ReturnType<typeof captureSession>, signal: AbortSignal): boolean =>
  !signal.aborted && isSessionCurrent(context)

const probeInSession = async (
  baseUrl: string,
  context: ReturnType<typeof captureSession>,
  signal?: AbortSignal,
  isSelectionCurrent: () => boolean = () => true,
): Promise<ServiceProbe | null> => {
  const combined = probeSignal(signal, context)
  const isProbeCurrent = () => isCurrent(context, combined) && isSelectionCurrent()
  if (!isProbeCurrent()) return null
  try {
    const client = createApiClient({ baseUrl, getAccessToken: () => null })
    const healthResponse = await client.GET('/ping', { signal: combined })
    if (!isProbeCurrent() || !healthResponse.response.ok || !isHealth(healthResponse.data))
      return null
    const modeResponse = await client.GET('/mode', { signal: combined })
    if (!isProbeCurrent() || !modeResponse.response.ok || !isMode(modeResponse.data)) return null
    return { health: healthResponse.data, mode: modeResponse.data.mode }
  } catch {
    return null
  }
}

/** Anonymous probe that rejects late results from its original session scope. */
export const probeService = (baseUrl: string, signal?: AbortSignal): Promise<ServiceProbe | null> =>
  probeInSession(baseUrl, captureSession(), signal)

/**
 * 浏览器本地运行模式的能力探测结果。
 *
 * `supported` 为 false 时说明当前环境缺少 IndexedDB / OPFS / Worker 等
 * 浏览器本地运行所必需的能力，UI 应据此禁用「纯浏览器本地」选项。
 */
export interface BrowserLocalSupport {
  supported: boolean
  /** 缺失的能力名（空数组表示全部具备）。 */
  missing: string[]
}

/**
 * 探测当前环境是否具备「纯浏览器本地运行模式」所需的浏览器能力。
 *
 * 探测项与 Phase 0 报告 §6 的浏览器兼容性风险清单对应：
 * IndexedDB（结构化元数据）、OPFS（大文件）、Web Worker（后台引擎）、
 * BroadcastChannel（跨标签页事件总线）。
 */
export const detectBrowserLocalSupport = (): BrowserLocalSupport => {
  const missing: string[] = []
  if (typeof indexedDB === 'undefined') missing.push('indexeddb')
  if (typeof globalThis.navigator?.storage?.getDirectory !== 'function') missing.push('opfs')
  if (typeof Worker === 'undefined') missing.push('worker')
  if (typeof BroadcastChannel === 'undefined') missing.push('broadcast_channel')
  return { supported: missing.length === 0, missing }
}

/**
 * 是否启用了「纯浏览器本地运行模式」。
 *
 * 该偏好是**显式**的：只有明确开启时才生效，
 * 绝不会因为「探测不到服务端」而静默降级——静默降级会把「服务端故障」
 * 伪装成「本地模式」，掩盖真实问题。
 */
export const isBrowserLocalEnabled = (): boolean => readBrowserLocalEnabled()

/**
 * 切换「纯浏览器本地运行模式」。
 *
 * 开启时立即把生效网关切到 `LocalGateway`；关闭时回落到 `RemoteGateway`。
 */
export const setBrowserLocalEnabled = (enabled: boolean): void => {
  writeBrowserLocalEnabled(enabled)
  setGatewayMode(enabled ? 'browser-local' : 'server')
}

/**
 * 构造「纯浏览器本地运行模式」的服务描述。
 *
 * 不发起任何网络请求：本地模式下 `/ping` 与 `/mode` 由浏览器内的
 * `LocalGateway` 直接应答。
 */
export const browserLocalProbe = (): ServiceProbe => ({
  health: browserLocalHealth(),
  mode: 'browser-local',
})

/** Prefer local default service; otherwise probe the explicitly stored server once. */
export const resolveBootstrapService = async (
  signal?: AbortSignal,
): Promise<({ baseUrl: string } & ServiceProbe) | null> => {
  const context = captureSession()
  const stored = readStoredApiBaseUrl()
  const isResolutionCurrent = () =>
    !signal?.aborted && isSessionCurrent(context) && readStoredApiBaseUrl() === stored
  if (!isResolutionCurrent()) return null

  // 显式开启的浏览器本地模式优先：不发起任何网络探测。
  if (readBrowserLocalEnabled()) {
    setGatewayMode('browser-local')
    return { baseUrl: DEFAULT_SERVICE_BASE_URL, ...browserLocalProbe() }
  }

  const defaultProbe = await probeInSession(
    DEFAULT_SERVICE_BASE_URL,
    context,
    signal,
    isResolutionCurrent,
  )
  if (!isResolutionCurrent()) return null
  if (defaultProbe?.mode === 'local') {
    setGatewayMode('local')
    return { baseUrl: DEFAULT_SERVICE_BASE_URL, ...defaultProbe }
  }

  if (!stored) {
    setGatewayMode(normalizeServiceMode(defaultProbe?.mode))
    return null
  }
  if (normalizeApiBaseUrl(stored) === normalizeApiBaseUrl(DEFAULT_SERVICE_BASE_URL)) {
    setGatewayMode(normalizeServiceMode(defaultProbe?.mode))
    return defaultProbe ? { baseUrl: DEFAULT_SERVICE_BASE_URL, ...defaultProbe } : null
  }

  const storedProbe = await probeInSession(stored, context, signal, isResolutionCurrent)
  if (!isResolutionCurrent()) return null
  setGatewayMode(normalizeServiceMode(storedProbe?.mode ?? defaultProbe?.mode))
  return storedProbe ? { baseUrl: stored, ...storedProbe } : null
}
