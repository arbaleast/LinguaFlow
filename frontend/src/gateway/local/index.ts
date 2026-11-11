/**
 * 纯浏览器本地网关（`LocalGateway`）。
 *
 * 对应运行模式 `'browser-local'`：**没有任何后端进程**，全部计算与存储都在浏览器内。
 *
 * Phase 1 范围（骨架）：
 *
 * - 直接应答 3 个「服务发现类」端点：`/ping`、`/mode`、`/auth/capabilities`；
 * - 其余端点一律**回落**到既有远端实现（返回 `null`），保证在浏览器本地模式
 *   尚未接满之前不会产生「假成功」；
 * - 上传与事件流通道同样回落（Phase 2 接入 OPFS / BroadcastChannel 后再接管）。
 *
 * Phase 2 计划：把 `handle()` 的端点表扩展到 IndexedDB / OPFS / Worker 支撑的
 * 全部资源、项目、段落、术语表与任务端点。
 */
import type {
  ApiSchemas,
  Gateway,
  GatewayRequest,
  GatewayResult,
  GatewayStreamHandle,
  GatewayStreamRequest,
  GatewayUploadRequest,
  GatewayUploadResult,
} from '../contracts'
import { BROWSER_LOCAL_MODE } from '../contracts/mode'

/** 构造一个 JSON 响应（形状与 openapi-fetch 返回的 `response` 一致）。 */
function jsonResponse<T>(data: T, status = 200): GatewayResult<T> {
  const body = JSON.stringify(data)
  return {
    data,
    error: undefined,
    response: new Response(body, {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  }
}

/**
 * 浏览器本地模式的认证能力描述。
 *
 * 结构与 Go 侧 `local` 模式（`handler_auth.go:139`）**完全一致**，
 * 仅 `mode` 取 `'browser-local'`：浏览器本地模式没有服务端账号体系，
 * 本地账号策略等价于 Go 的 local 模式（口令必填、邮箱可选）。
 */
export function browserLocalAuthCapabilities(): ApiSchemas['AuthCapabilities'] {
  return {
    mode: BROWSER_LOCAL_MODE,
    local_account: {
      can_login: false,
      can_signup: false,
      can_enroll_password: false,
      password_login_enabled: false,
      password_enrollment_enabled: false,
      username_login_enabled: false,
      email_login_enabled: false,
      signup: { email_requirement: 'optional', password_requirement: 'required' },
      signup_requirements: ['local_password'],
    },
    connections: [],
    email_verification_enabled: false,
    password_reset_enabled: false,
  } as unknown as ApiSchemas['AuthCapabilities']
}

/** 浏览器本地模式的服务健康描述（与 Go `/ping` 的形状一致）。 */
export function browserLocalHealth(): ApiSchemas['HealthResponse'] {
  return { status: 'ok', service: 'linguaflow' }
}

/** 纯浏览器本地网关。 */
export class LocalGateway implements Gateway {
  readonly mode = BROWSER_LOCAL_MODE
  /** Phase 1 尚无本地事件总线，事件流回落远端实现。 */
  readonly supportsEventStream = false

  /**
   * 处理一个 REST 请求。
   *
   * 只接管「服务发现类」端点；其余返回 `null` 表示回落。
   */
  handle<T = unknown>(request: GatewayRequest): Promise<GatewayResult<T>> | null {
    switch (request.path) {
      case '/ping':
        return Promise.resolve(jsonResponse(browserLocalHealth()) as GatewayResult<T>)
      case '/mode':
        return Promise.resolve(
          jsonResponse({ mode: BROWSER_LOCAL_MODE }) as unknown as GatewayResult<T>,
        )
      case '/auth/capabilities':
        return Promise.resolve(
          jsonResponse(browserLocalAuthCapabilities()) as unknown as GatewayResult<T>,
        )
      default:
        return null
    }
  }

  /** 上传回落：Phase 2 接入 OPFS 后再接管。 */
  upload(_request: GatewayUploadRequest): Promise<GatewayUploadResult> | null {
    return null
  }

  /** 事件流回落：Phase 2 接入 BroadcastChannel 后再接管。 */
  openEventStream(_request: GatewayStreamRequest): GatewayStreamHandle | null {
    return null
  }
}

/** 共享的本地网关单例。 */
export const localGateway = new LocalGateway()
