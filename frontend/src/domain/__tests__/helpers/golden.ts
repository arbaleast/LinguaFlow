/**
 * 黄金测试向量（Golden Vectors）加载与对拍工具。
 *
 * 黄金向量由 Go 侧生产代码的真实输出导出（见 `backend/internal/<pkg>/golden_vectors_test.go`），
 * 前端 `src/domain/` 的 TypeScript 移植层必须与之 **100% 一致**。
 *
 * 本文件位于 `__tests__/helpers/` 下，只被测试引用，不属于领域层运行时。
 */
import { expect } from 'vitest'

/** 单条黄金向量。 */
export interface GoldenCase {
  /** 稳定用例 ID。 */
  id: string
  /** 被测操作标识（TS 侧按此分派）。 */
  op: string
  /** 输入参数。 */
  args: Record<string, unknown>
  /** Go 侧真实输出（期望值）。 */
  expect: Record<string, unknown>
}

/** 一个领域包的黄金向量集合。 */
export interface GoldenFixture {
  package: string
  generator: string
  schema: number
  cases: GoldenCase[]
}

/** 操作处理器：接收输入，返回与 `expect` 对比的实际值。 */
export type GoldenHandler = (args: Record<string, unknown>) => unknown

/**
 * 运行整份黄金向量。
 *
 * 每个用例都会：
 * 1. 按 `op` 分派到处理器；
 * 2. 与 Go 侧导出的期望值做**深相等**断言；
 * 3. 失败时输出用例 ID 与两侧的实际值，便于定位。
 *
 * @param fixture 黄金向量集合
 * @param handlers `op` → 处理器映射
 */
export function runGolden(fixture: GoldenFixture, handlers: Record<string, GoldenHandler>): void {
  const seenOps = new Set<string>()
  for (const testCase of fixture.cases) {
    const handler = handlers[testCase.op]
    if (!handler) {
      throw new Error(
        `黄金向量 ${fixture.package}/${testCase.id} 使用了未注册的操作 "${testCase.op}"`,
      )
    }
    seenOps.add(testCase.op)
    const actual = handler(testCase.args)
    expect(actual, `黄金向量不匹配: ${fixture.package}/${testCase.id} (op=${testCase.op})`).toEqual(
      testCase.expect,
    )
  }
  // 提示未被任何用例覆盖的处理器，避免移植时漏实现某个入口。
  for (const op of Object.keys(handlers)) {
    if (!seenOps.has(op)) {
      throw new Error(`处理器 "${op}" 未被 ${fixture.package} 的任何黄金向量覆盖`)
    }
  }
}

/** 从黄金向量参数中取字符串。 */
export function argString(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string') {
    throw new Error(`黄金向量参数 "${key}" 期望为 string，实际为 ${typeof v}`)
  }
  return v
}

/** 从黄金向量参数中取数值。 */
export function argNumber(args: Record<string, unknown>, key: string): number {
  const v = args[key]
  if (typeof v !== 'number') {
    throw new Error(`黄金向量参数 "${key}" 期望为 number，实际为 ${typeof v}`)
  }
  return v
}

/** 从黄金向量参数中取布尔值。 */
export function argBoolean(args: Record<string, unknown>, key: string): boolean {
  const v = args[key]
  if (typeof v !== 'boolean') {
    throw new Error(`黄金向量参数 "${key}" 期望为 boolean，实际为 ${typeof v}`)
  }
  return v
}

/** 从黄金向量参数中取字符串数组（缺省为空数组）。 */
export function argStringArray(args: Record<string, unknown>, key: string): string[] {
  const v = args[key]
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) {
    throw new Error(`黄金向量参数 "${key}" 期望为数组，实际为 ${typeof v}`)
  }
  return v as string[]
}

/** 从黄金向量参数中取数字数组（缺省为空数组）。 */
export function argNumberArray(args: Record<string, unknown>, key: string): number[] {
  const v = args[key]
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) {
    throw new Error(`黄金向量参数 "${key}" 期望为数组，实际为 ${typeof v}`)
  }
  return v as number[]
}

/** 从黄金向量参数中取字符串字典。 */
export function argStringRecord(
  args: Record<string, unknown>,
  key: string,
): Record<string, string> {
  const v = args[key]
  if (v === undefined || v === null) return {}
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`黄金向量参数 "${key}" 期望为对象，实际为 ${typeof v}`)
  }
  return v as Record<string, string>
}

/** 从黄金向量参数中取可空字符串字典。 */
export function argNullableStringRecord(
  args: Record<string, unknown>,
  key: string,
): Record<string, string> | null {
  const v = args[key]
  if (v === undefined || v === null) return null
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`黄金向量参数 "${key}" 期望为对象或 null，实际为 ${typeof v}`)
  }
  return v as Record<string, string>
}
