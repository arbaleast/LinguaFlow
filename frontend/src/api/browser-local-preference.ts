/**
 * 「纯浏览器本地运行模式」（`'browser-local'`）的**显式偏好**存储。
 *
 * 单独成模块的原因：`token-storage` 是认证凭据的存储，而本偏好与认证无关；
 * 分开可以让「浏览器本地模式」的开关与凭据生命周期彻底解耦。
 *
 * 语义：该偏好是**显式**的——只有用户（或启动参数）明确开启时才生效，
 * 绝不会因为「探测不到服务端」而静默降级。静默降级会把「服务端故障」
 * 伪装成「本地模式」，掩盖真实问题。
 */
import { getDefaultTokenStorage } from './token-storage'

/** localStorage 键名。 */
export const BROWSER_LOCAL_STORAGE_KEY = 'linguaflow.browser_local'

/** 是否启用「纯浏览器本地运行模式」。 */
export const readBrowserLocalEnabled = (): boolean =>
  getDefaultTokenStorage()?.getItem(BROWSER_LOCAL_STORAGE_KEY) === '1'

/** 写入「纯浏览器本地运行模式」偏好。 */
export const writeBrowserLocalEnabled = (enabled: boolean): void => {
  const storage = getDefaultTokenStorage()
  if (!storage) return
  if (enabled) {
    storage.setItem(BROWSER_LOCAL_STORAGE_KEY, '1')
    return
  }
  storage.removeItem(BROWSER_LOCAL_STORAGE_KEY)
}
