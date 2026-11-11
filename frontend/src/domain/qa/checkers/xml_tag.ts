/**
 * `xml_tag_mismatch` checker（对应 Go `checker_xml_tag.go`）。
 *
 * 对源/译做两条正交的 XML 判定：
 *
 * 1. **结构合法性**：译文必须能作为 well-formed 片段嵌入 XHTML 元素内容
 *    （`markup.targetRegression` 自带「源文含标签且源文合法」的门禁）。ruby 族在此
 *    **不能**排除：`preserve_kinds` 合法移除全部 ruby 后译文仍然平衡，结构判定不会
 *    误报；而译文丢一个 `</ruby>`（标签总数守恒但嵌套非法）只有结构判定能抓到。
 * 2. **标签守恒**：比对源/译 XML 标签多重集合。ruby 族在此排除：`preserve_kinds`
 *    过滤会合法地从译文移除这些标签。
 *
 * 结构判定优先：命中时只报结构问题，不再为同段追加多重集 issue——结构损坏更具体、
 * 更可操作，且保持每段最多一条 `xml_tag_mismatch`。
 */
import { targetRegression } from '../../markup'
import { trimSpace } from '../../ruby'
import { compile, findAllStringIndex, findStringSubmatch } from '../../shared/re2'
import { CHECK_XML_TAG_MISMATCH } from '../codes'
import { multisetEqual } from './number'
import { keysOf } from './url_email'
import { SEVERITY_ERROR, type CheckInput, type Checker, type QualityIssue } from '../types'

/** 与 protect.XMLProtector 一致：匹配 `<tag>` / `</tag>` / `<tag attr>` / `<tag/>`。 */
const xmlTagTokenRe = compile('</?[A-Za-z][A-Za-z0-9:-]*(?:\\s+[^<>]*)?/?>')

/** 从标签 token 中提取标签名（Go `xmlTagNameRe`）。 */
const xmlTagNameRe = compile('^</?([A-Za-z][A-Za-z0-9:-]*)')

/**
 * HTML ruby 注音标签族（Go `rubyTagFamily`）。
 *
 * 其守恒由 ruby 还原子系统独立负责，与通用 XML 标签守恒正交：`preserve_kinds`
 * 过滤会合法地从译文移除这些标签，因此在多重集比对中一律排除。
 */
const RUBY_TAG_FAMILY: ReadonlySet<string> = new Set(['ruby', 'rt', 'rp', 'rb'])

/** XML 标签守恒检测器。 */
export class XMLTagMismatchChecker implements Checker {
  name(): string {
    return CHECK_XML_TAG_MISMATCH
  }

  check(segments: readonly CheckInput[]): QualityIssue[] {
    const issues: QualityIssue[] = []
    for (const seg of segments) {
      const src = seg.sourceText
      const tgt = seg.targetText
      if (trimSpace(src) === '') {
        continue
      }
      // 结构合法性判定先于多重集比对：多重集的门禁（提取后非空）会跳过纯 ruby 源文，
      // 而那里的结构损坏恰恰必须被抓到。
      const err = targetRegression(src, tgt)
      if (err !== null) {
        issues.push({
          segmentIndex: seg.index,
          severity: SEVERITY_ERROR,
          code: CHECK_XML_TAG_MISMATCH,
          message: `译文 XML 结构损坏（标签未闭合或嵌套错误）：${err}`,
          span: { matchedText: markupCulprit(tgt) },
          disposition: '',
        })
        continue
      }
      const srcTags = extractXMLTagMultiset(src)
      if (srcTags.size === 0) {
        continue
      }
      const tgtTags = extractXMLTagMultiset(tgt)
      if (multisetEqual(srcTags, tgtTags)) {
        continue
      }
      issues.push({
        segmentIndex: seg.index,
        severity: SEVERITY_ERROR,
        code: CHECK_XML_TAG_MISMATCH,
        message: `XML 标签不一致：原文 ${formatTagList(keysOf(srcTags))}，译文 ${formatTagList(keysOf(tgtTags))}`,
        disposition: '',
      })
    }
    return issues
  }
}

/** 等价 Go `fmt.Sprintf("%v", []string)`（本文件的 message 拼接）。 */
function formatTagList(items: readonly string[]): string {
  return `[${items.join(' ')}]`
}

/** 提取 XML 标签多重集合（Go `extractXMLTagMultiset`；ruby 族排除）。 */
export function extractXMLTagMultiset(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const [start, end] of findAllStringIndex(xmlTagTokenRe, text)) {
    const m = text.slice(start, end)
    const nameMatch = findStringSubmatch(xmlTagNameRe, m)
    if (nameMatch !== null && nameMatch.length >= 2) {
      if (RUBY_TAG_FAMILY.has((nameMatch[1] ?? '').toLowerCase())) {
        continue
      }
    }
    counts.set(m, (counts.get(m) ?? 0) + 1)
  }
  return counts
}

/**
 * 在 target 中定位触发结构错误的标签 token，作为 issue 的指纹载体（Go `markupCulprit`）。
 *
 * `Fingerprint = code:matched_text`：优先多余的闭标签，其次最内层未闭合的开标签；
 * 裸 `&` 等非标签错误退回末个标签 token，仍无标签时退回片段本身。
 */
export function markupCulprit(target: string): string {
  const tokens = findAllStringIndex(xmlTagTokenRe, target).map(([start, end]) =>
    target.slice(start, end),
  )
  interface OpenTag {
    name: string
    tok: string
  }
  const stack: OpenTag[] = []
  for (const tok of tokens) {
    const nameMatch = findStringSubmatch(xmlTagNameRe, tok)
    if (nameMatch === null) {
      continue
    }
    const name = (nameMatch[1] ?? '').toLowerCase()
    if (tok.startsWith('</')) {
      let matched = false
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.name === name) {
          stack.length = i
          matched = true
          break
        }
      }
      if (!matched) {
        return tok
      }
      continue
    }
    if (!tok.endsWith('/>')) {
      stack.push({ name, tok })
    }
  }
  if (stack.length > 0) {
    return stack[stack.length - 1]!.tok
  }
  if (tokens.length > 0) {
    return tokens[tokens.length - 1]!
  }
  return target
}
