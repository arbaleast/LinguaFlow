/**
 * `domain/search` 黄金向量对拍测试。
 *
 * 期望值全部来自 Go `backend/internal/service/segmatch` 的真实输出
 * （由 `backend/internal/service/segmatch/golden_vectors_test.go` 导出），
 * 本移植层必须与之 100% 一致。
 *
 * 向量按 Op 分派：
 *
 * - `search.find`：`find()` 的码点区间 + `hasMatch()` 的布尔结果；
 * - `search.replace`：`replaceAll()` 的新文本与替换次数（含 ExpandString 展开）；
 * - `search.candidate`：`candidateLiteral()` 的字面量锚点；
 * - `search.error`：构造期错误的错误码（无错误为空串）。
 */
import { describe, expect, it } from 'vitest'
import searchFixture from '../__fixtures__/search.json'
import {
  createSearchMatcher,
  SearchError,
  type SearchMatchMode,
  type SearchMatcher,
  type SearchOptions,
} from '../search'
import { argBoolean, argString, runGolden, type GoldenFixture } from './helpers/golden'

const fixture = searchFixture as unknown as GoldenFixture

/** 由黄金向量参数构造 `SearchOptions`（error 用例缺省可选字段）。 */
function optionsFrom(args: Record<string, unknown>): SearchOptions {
  const options: SearchOptions = {
    find: argString(args, 'find'),
    matchMode: argString(args, 'matchMode') as SearchMatchMode,
  }
  if (args.caseSensitive !== undefined) {
    options.caseSensitive = argBoolean(args, 'caseSensitive')
  }
  if (args.wholeWord !== undefined) {
    options.wholeWord = argBoolean(args, 'wholeWord')
  }
  return options
}

/** 由黄金向量参数构造匹配器。 */
function matcherFrom(args: Record<string, unknown>): SearchMatcher {
  return createSearchMatcher(optionsFrom(args))
}

describe('domain/search 黄金向量', () => {
  it('覆盖全部黄金向量', () => {
    runGolden(fixture, {
      'search.find': (args) => {
        const matcher = matcherFrom(args)
        const text = argString(args, 'text')
        return {
          matches: matcher.find(text),
          hasMatch: matcher.hasMatch(text),
        }
      },
      'search.replace': (args) => {
        const matcher = matcherFrom(args)
        const result = matcher.replaceAll(
          argString(args, 'text'),
          argString(args, 'replaceWith'),
        )
        return { text: result.text, count: result.count }
      },
      'search.candidate': (args) => {
        return { literal: matcherFrom(args).candidateLiteral() }
      },
      'search.error': (args) => {
        try {
          createSearchMatcher(optionsFrom(args))
          return { error: '' }
        } catch (error) {
          return { error: error instanceof SearchError ? error.code : `unexpected:${String(error)}` }
        }
      },
    })
  })

  it('错误码与冻结契约常量一致', () => {
    const codes = new Set(
      fixture.cases
        .filter((testCase) => testCase.op === 'search.error')
        .map((testCase) => testCase.expect.error)
        .filter((code): code is string => typeof code === 'string' && code !== ''),
    )
    // 黄金向量必须覆盖三类构造错误，且错误码取自 types.ts 的冻结常量。
    expect(codes).toEqual(
      new Set(['invalid_regex_pattern', 'pattern_too_long', 'unsupported_match_mode']),
    )
  })
})
