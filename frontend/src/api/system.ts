import { t } from '@/i18n'
import { setGatewayMode } from '@/gateway'
import { normalizeServiceMode } from '@/gateway/contracts'

import type { ApiClient, ApiSchemas } from './client-core'
import { apiClient } from './client-core'
import { buildRequestFailureError } from './utils'

export const fetchMode = async (
  client: ApiClient = apiClient,
): Promise<ApiSchemas['ModeResponse']> => {
  const { data, error, response } = await client.GET('/mode')

  if (!data) {
    throw buildRequestFailureError(t('api.errors.fetchModeFailed'), error, response)
  }

  // Gateway 接缝：把运行模式同步给网关，保证「谁在回答」与「谁在发问」一致。
  // 'browser-local' 模式下该请求由 LocalGateway 直接应答。
  setGatewayMode(normalizeServiceMode(data.mode))

  return data
}
