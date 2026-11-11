/**
 * 本地账号路由（对应 OpenAPI `/users/me...`）。
 *
 * 浏览器本地模式**没有账号体系**：只存在一个隐式的本地管理员身份。
 *
 * | 方法 | 路径 | 行为 |
 * |---|---|---|
 * GET | `/users/me` | 返回固定的本地身份（若本地已有项目，则带上项目归属信息） |
 * PUT | `/users/me` | 无账号表可写：接受请求体但**不修改**任何身份字段，返回当前身份 |
 * GET | `/users/me/login-methods` | 返回空的登录方式清单（无外部 IdP、无本地口令） |
 * PUT | `/users/me/password` | 400：浏览器本地模式没有口令可改 |
 *
 * 语义与 Go 的 local 模式一致：local 模式沿用既有本地身份，页面不提供密码表单。
 */
import type { ApiSchemas, GatewayResult } from '@/gateway/contracts'

import { getCurrentUser } from '../repositories/operations'
import { RepositoryValidationError } from '../repositories/errors'
import { badRequest, json } from '../responses'
import type { LocalRoute } from '../router'
import { bodyObject, route } from './support'

/** 本地身份的登录方式清单（无 IdP、无本地口令）。 */
function localLoginMethods(): ApiSchemas['LoginMethodsResponse'] {
  return {
    available_connections: [],
    bindings: [],
    email: {
      address: null,
      can_recover: false,
      verified: false,
    },
    password: {
      can_delete: false,
      can_login: false,
      can_set: false,
      is_set: false,
      verified: false,
    },
  }
}

export const userRoutes: LocalRoute[] = [
  {
    method: 'GET',
    path: '/users/me',
    handler: (ctx) => route(async () => json(await getCurrentUser(ctx.db))),
  },
  {
    method: 'PUT',
    path: '/users/me',
    handler: (ctx) =>
      route(async () => {
        // 请求体必须合法（与后端一致的 400 语义），但本地没有账号表可写。
        bodyObject(ctx)
        return json(await getCurrentUser(ctx.db))
      }),
  },
  {
    method: 'GET',
    path: '/users/me/login-methods',
    handler: () => route(async () => json(localLoginMethods())),
  },
  {
    method: 'PUT',
    path: '/users/me/password',
    handler: () =>
      route(async () => {
        throw new RepositoryValidationError('浏览器本地模式没有账号口令，无法修改密码')
      }),
  },
]
