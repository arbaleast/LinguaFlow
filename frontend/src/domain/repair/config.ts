/**
 * 修复策略运行时配置（对应 Go `backend/internal/repair/config.go`）。
 */
import type { RepairOptions } from './types'

/** 修复策略的运行时配置（Go `repair.Config`）。 */
export interface RepairConfig {
  enabled: boolean
  jsonStructural: boolean
  schemaAliases: boolean
  placeholderNormalize: boolean
  promptUpgrade: boolean
}

/** 规范化配置：`enabled=false` 时强制清零所有子开关（Go `Config.Normalize`）。 */
export function normalizeConfig(config: RepairConfig): RepairConfig {
  if (!config.enabled) {
    return {
      ...config,
      jsonStructural: false,
      schemaAliases: false,
      placeholderNormalize: false,
      promptUpgrade: false,
    }
  }
  return { ...config }
}

/** 把配置转换为修复选项（Go `Config.ToOptions`）。 */
export function configToOptions(config: RepairConfig): RepairOptions {
  return {
    jsonStructural: config.jsonStructural,
    schemaAliases: config.schemaAliases,
    placeholderNormalize: config.placeholderNormalize,
    promptUpgrade: config.promptUpgrade,
    bareArrayAccept: null,
    salvageDeclined: false,
    inSalvage: false,
  }
}
