/**
 * `domain/shared/hash` 黄金向量对拍测试。
 *
 * 期望值全部来自 Go `backend/internal/hash` 的真实输出
 * （由 `backend/internal/hash/golden_vectors_test.go` 导出）。
 */
import { describe, expect, it } from 'vitest'
import hashFixture from '../__fixtures__/hash.json'
import { fullHash, shortHash } from '../shared/hash'
import { argString, runGolden, type GoldenFixture } from './helpers/golden'

const fixture = hashFixture as unknown as GoldenFixture

describe('domain/shared/hash 黄金向量', () => {
  it('覆盖全部黄金向量', () => {
    runGolden(fixture, {
      'hash.compute': (args) => {
        const text = argString(args, 'text')
        return { short: shortHash(text), full: fullHash(text) }
      },
    })
  })

  it('短哈希为 12 位十六进制、完整哈希为 64 位十六进制', () => {
    for (const testCase of fixture.cases) {
      const short = (testCase.expect as { short: string }).short
      const full = (testCase.expect as { full: string }).full
      expect(short).toMatch(/^[0-9a-f]{12}$/)
      expect(full).toMatch(/^[0-9a-f]{64}$/)
      expect(full.slice(0, 12)).toBe(short)
    }
  })
})
