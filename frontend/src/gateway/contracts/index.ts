/**
 * 网关契约（Gateway Contracts）。
 *
 * 契约的唯一 DTO 来源是 `frontend/src/api/types.d.ts`（openapi-typescript 生成，
 * 13,754 行）。本文件**不重复定义**任何 DTO，只定义「网关如何被调用」的形状，
 * 以及少量由契约派生出的别名。
 *
 * 关键设计：契约刻意模仿 **openapi-fetch** 的调用形状
 * （`{ data, error, response }`），使得 `src/api/*.ts` 里的既有调用代码
 * **一行都不用改**就能被网关接管——这是「Store 与组件 100% 零改动」的前提。
 */
import type { components } from '../../api/types'
import type { ServiceMode } from './mode'

/** API schema 别名（与 `api/client-core.ts` 中的 `ApiSchemas` 同源）。 */
export type ApiSchemas = components['schemas']

/** HTTP 方法（openapi-fetch 支持的集合）。 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'

/** openapi-fetch 的请求选项（此处只声明网关关心的字段，其余原样透传）。 */
export interface GatewayRequestOptions {
  body?: unknown
  params?: {
    path?: Record<string, unknown>
    query?: Record<string, unknown>
    header?: Record<string, unknown>
    cookie?: Record<string, unknown>
  }
  signal?: AbortSignal
  headers?: Record<string, string>
  [key: string]: unknown
}

/** 一次网关请求。 */
export interface GatewayRequest {
  /** HTTP 方法。 */
  method: HttpMethod
  /** openapi-fetch 的 schema path，例如 `'/ping'`、`'/mode'`、`'/auth/capabilities'`。 */
  path: string
  /** openapi-fetch 的请求选项。 */
  options?: GatewayRequestOptions
}

/**
 * 一次网关响应。
 *
 * 形状与 openapi-fetch 的返回值一致：
 *
 * - `data`：成功时的响应体；
 * - `error`：失败时的响应体（RFC 7807 Problem 或其他）；
 * - `response`：`Response` 对象（`ok` / `status` / `headers`）。
 */
export interface GatewayResult<T = unknown> {
  data?: T
  error?: unknown
  response: Response
}

/** 上传通道请求（XHR 通道）。 */
export interface GatewayUploadRequest {
  /** 目标资源路径（相对于 API base）。 */
  url: string
  /** 待上传文件。 */
  files: File[]
  /** 可选的相对路径覆盖。 */
  paths?: string[]
  /** 幂等键。 */
  idempotencyKey: string
  /** 取消信号。 */
  signal?: AbortSignal
  /** 上传进度回调（百分比 0–100）。 */
  onProgress?: (percent: number) => void
  /** 服务端开始处理（上传字节完成）回调。 */
  onServerProcessing?: () => void
}

/** 上传通道结果。 */
export interface GatewayUploadResult {
  status: number
  text: string
}

/** 事件流（SSE）请求。 */
export interface GatewayStreamRequest {
  /** 事件流 URL。 */
  url: string
  /** 事件类型处理器。 */
  onEvent: (type: string, handler: (event: MessageEvent) => void) => void
  /** 连接建立回调。 */
  onOpen: () => void
  /** 连接中断回调。 */
  onError: () => void
}

/** 事件流句柄。 */
export interface GatewayStreamHandle {
  close(): void
}

/**
 * 网关实现。
 *
 * 语义约定：
 *
 * - `handle()` 返回 `null` 表示「本网关不接管该端点」，调用方必须回落到
 *   既有的远端实现（openapi-fetch / XHR / EventSource）。这是 `'local'` 与
 *   `'server'` 模式**零回归**的技术前提。
 * - `upload()` / `openEventStream()` 同理：返回 `null` 表示回落。
 */
export interface Gateway {
  /** 该网关对应的运行模式。 */
  readonly mode: ServiceMode
  /** 处理一个 REST 请求。 */
  handle<T = unknown>(request: GatewayRequest): Promise<GatewayResult<T>> | null
  /** 处理一次上传。 */
  upload(request: GatewayUploadRequest): Promise<GatewayUploadResult> | null
  /** 打开一条事件流。 */
  openEventStream(request: GatewayStreamRequest): GatewayStreamHandle | null
  /** 该网关是否支持事件流通道。 */
  readonly supportsEventStream: boolean
}

export * from './mode'
