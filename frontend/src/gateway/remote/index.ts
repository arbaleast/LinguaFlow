/**
 * 远端网关（对应现有 `'local'` / `'server'` 两种运行模式）。
 *
 * **零回归是硬要求**：本实现**不接管**任何请求，
 * `handle()` / `upload()` / `openEventStream()` 一律返回 `null`，
 * 由调用方回落到既有的 openapi-fetch / raw XHR / EventSource 实现。
 *
 * 换言之：`'local'`（连接本地 Go 进程）与 `'server'`（连接远程服务端）
 * 两种模式下的行为与 Phase 1 之前**逐字节一致**。
 */
import type {
  Gateway,
  GatewayRequest,
  GatewayStreamHandle,
  GatewayStreamRequest,
  GatewayUploadRequest,
  GatewayUploadResult,
} from '../contracts'

/** 远端网关：不接管任何通道，全部回落既有实现。 */
export class RemoteGateway implements Gateway {
  readonly mode: 'local' | 'server' = 'server'
  readonly supportsEventStream = true

  /** 始终返回 `null`：远端实现保持原样，不做任何拦截。 */
  handle<T = unknown>(
    _request: GatewayRequest,
  ): Promise<import('../contracts').GatewayResult<T>> | null {
    return null
  }

  /** 始终返回 `null`：上传继续走既有 raw XHR 实现。 */
  upload(_request: GatewayUploadRequest): Promise<GatewayUploadResult> | null {
    return null
  }

  /** 始终返回 `null`：事件流继续走既有 EventSource 实现。 */
  openEventStream(_request: GatewayStreamRequest): GatewayStreamHandle | null {
    return null
  }
}

/** 共享的远端网关单例。 */
export const remoteGateway = new RemoteGateway()
