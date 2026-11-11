/**
 * 应用网关（Application Gateway）——**唯一接缝**。
 *
 * 职责：在「远端实现（openapi-fetch / XHR / EventSource）」与「浏览器本地实现
 * （Phase 2 的 IndexedDB / OPFS / Worker）」之间做**运行时**切换。
 *
 * 关键约束（Phase 1 架构修正 #1）：
 *
 * > 不要去修改 30 个 Pinia Store 和组件的 import 路径。
 *
 * 因此网关的接入点被**下沉到 `src/api/` 层**：
 *
 * - `api/client-core.ts` 的 `apiClient` 代理在派发 `GET/POST/PUT/DELETE/PATCH` 时
 *   先询问当前网关；网关不接管（返回 `null`）时**原样**回落到 openapi-fetch。
 * - `api/projects.ts` 的 raw XHR 上传、`composables/sseShared.ts` 的 EventSource
 *   同样先询问网关。
 *
 * 结果：`src/stores/**` 与 `src/components/**` **零改动**，
 * `'local'` / `'server'` 两种模式**零回归**。
 */
import type {
  Gateway,
  GatewayRequest,
  GatewayResult,
  GatewayStreamHandle,
  GatewayStreamRequest,
  GatewayUploadRequest,
  GatewayUploadResult,
} from './contracts'
import { BROWSER_LOCAL_MODE, normalizeServiceMode, type ServiceMode } from './contracts/mode'
import { localGateway } from './local'
import { remoteGateway } from './remote'

export * from './contracts'
export { localGateway, browserLocalAuthCapabilities, browserLocalHealth } from './local'
export { remoteGateway } from './remote'

/** 当前运行模式。默认 `'server'`（与 Phase 1 之前的行为一致）。 */
let runtimeMode: ServiceMode = 'server'

/** 当前生效的网关。 */
let activeGateway: Gateway = remoteGateway

/**
 * 设置运行模式并切换生效网关。
 *
 * - `'local'` / `'server'` → `RemoteGateway`（既有实现，零回归）；
 * - `'browser-local'` → `LocalGateway`。
 */
export function setGatewayMode(mode: ServiceMode): void {
  runtimeMode = normalizeServiceMode(mode)
  activeGateway = runtimeMode === BROWSER_LOCAL_MODE ? localGateway : remoteGateway
}

/** 当前运行模式。 */
export function getGatewayMode(): ServiceMode {
  return runtimeMode
}

/** 当前生效的网关。 */
export function getGateway(): Gateway {
  return activeGateway
}

/** 当前是否处于纯浏览器本地运行模式。 */
export function isBrowserLocalGateway(): boolean {
  return runtimeMode === BROWSER_LOCAL_MODE
}

/**
 * 让当前网关处理一个 REST 请求。
 *
 * @returns 网关的响应；返回 `null` 表示当前网关不接管该端点，
 *          调用方**必须**回落到既有远端实现。
 */
export function dispatchRequest<T = unknown>(
  request: GatewayRequest,
): Promise<GatewayResult<T>> | null {
  return activeGateway.handle<T>(request)
}

/** 让当前网关处理一次上传；返回 `null` 表示回落。 */
export function dispatchUpload(request: GatewayUploadRequest): Promise<GatewayUploadResult> | null {
  return activeGateway.upload(request)
}

/** 让当前网关打开一条事件流；返回 `null` 表示回落。 */
export function dispatchEventStream(request: GatewayStreamRequest): GatewayStreamHandle | null {
  return activeGateway.openEventStream(request)
}
