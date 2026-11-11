/**
 * 运行模式定义（Gateway 层）。
 *
 * 三种运行模式：
 *
 * - `'local'`：连接**本地 Go 进程**（浏览器 ↔ 本地进程的瘦客户端，现状）。
 * - `'server'`：连接**远程服务端**。
 * - `'browser-local'`：**纯浏览器本地运行**（无后端进程，全部计算与存储在浏览器内完成）。
 *
 * `'browser-local'` 是 Phase 1 新增的模式：它不改变任何既有协议，
 * 只是把「本来由 Go 进程应答的少量端点」改为由浏览器内的 `LocalGateway` 直接应答，
 * 为 Phase 2 的 IndexedDB / OPFS / Worker 落地做准备。
 *
 * 模式与网关实现的关系：
 *
 * | 运行模式 | 生效网关 | 说明 |
 * |---|---|---|
 * | `'local'` | `RemoteGateway` | 现有 openapi-fetch / XHR / EventSource 逻辑**完全不变** |
 * | `'server'` | `RemoteGateway` | 同上 |
 * | `'browser-local'` | `LocalGateway` | 端点级分发：本地能应答的直接应答，其余回落到远端实现 |
 */

/** 运行模式。 */
export type ServiceMode = 'local' | 'server' | 'browser-local'

/** 纯浏览器本地运行模式的常量。 */
export const BROWSER_LOCAL_MODE = 'browser-local' as const

/** 现有两种模式（不依赖浏览器本地能力）。 */
export const REMOTE_MODES = ['local', 'server'] as const

/** 判断是否为纯浏览器本地运行模式。 */
export function isBrowserLocal(mode: ServiceMode | null | undefined): boolean {
  return mode === BROWSER_LOCAL_MODE
}

/** 把任意值收敛为合法的运行模式（非法值回落到 `'server'`）。 */
export function normalizeServiceMode(value: unknown): ServiceMode {
  return value === 'local' || value === 'server' || value === BROWSER_LOCAL_MODE ? value : 'server'
}
