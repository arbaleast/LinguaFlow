/**
 * `domain/markup` 黄金向量对拍测试。
 *
 * 期望值全部来自 Go `backend/internal/markup` 的真实输出
 * （由 `backend/internal/markup/golden_vectors_test.go` 导出）。
 */
import { describe, it } from 'vitest'
import markupFixture from '../__fixtures__/markup.json'
import { requiresWellFormedTargets, targetRegression, validateFragment } from '../markup'
import { argString, runGolden, type GoldenFixture } from './helpers/golden'

const fixture = markupFixture as unknown as GoldenFixture

describe('domain/markup 黄金向量', () => {
  it('覆盖全部黄金向量', () => {
    runGolden(fixture, {
      'markup.validate': (args) => {
        const err = validateFragment(argString(args, 's'))
        return { ok: err === null, err: err ?? '' }
      },

      'markup.target_regression': (args) => {
        const err = targetRegression(argString(args, 'source'), argString(args, 'target'))
        return { ok: err === null, err: err ?? '' }
      },

      'markup.requires_well_formed_targets': (args) => {
        return { required: requiresWellFormedTargets(argString(args, 'format')) }
      },
    })
  })
})
