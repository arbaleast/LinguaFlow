/**
 * 注音对齐状态机（对应 Go `backend/internal/ruby/alignment.go` 与
 * `alignment_regions.go`）。
 *
 * 设计要点（与 Go 逐条对齐）：
 * - `AlignmentState` 是任务私有的可序列化草稿：Translation / Items / Regions 构造后
 *   不可变，只有 Verified 增长；Digest 覆盖全部不可变字段，**不**持久化 Aligned 标志。
 * - `ApplyOutput` 先校验整份响应再接受任何区间：未知/重复 ID、非法 occurrence、
 *   不安全文本边界都会被拒绝，且不污染既有事实。
 * - 区间以**原始候选文本**的偏移表达；译文区域（region）把「解码后的可见文本」
 *   映射回原始文本，实体与换行是不可分割的原子区间。
 *
 * 偏移量单位：Go 用 UTF-8 字节偏移；本移植统一使用 UTF-16 code unit 偏移，
 * 查找与切片同坐标系，截取结果一致。唯一需要显式判定的是「视图下标是否落在
 * 一个码点中间」（代理对低半区），见 `rawBoundary`。
 */
import { compile, matchString } from '../shared/re2'
import { fullHash } from '../shared/hash'
import { utf8Length } from '../shared/unicode'
import { rawWellFormedError } from '../markup/fragment'
import { isValidKind, type OutputEntry, type RubyItem } from './item'
import { hasLoneSurrogate, htmlEscapeString } from './text'

export const ALIGNMENT_STATE_VERSION = 1
export const ALIGNMENT_VALIDATOR_VERSION = 1
export const PROTOCOL_LEGACY = 1
export const PROTOCOL_V2 = 2

/** 把解码文本的区段映射回原始候选文本（Go `RegionMapping`）。 */
export interface RegionMapping {
  view_start: number
  view_end: number
  raw_start: number
  raw_end: number
  /** 线性区段可按差值换算；实体与换行是原子区段（false）。 */
  linear: boolean
}

/** 一块可见译文文本及其回原始文本的映射（Go `TranslationRegion`）。 */
export interface TranslationRegion {
  text: string
  mappings: RegionMapping[]
}

/** 参与对齐的源条目（Go `AlignmentItem`）。 */
export interface AlignmentItem {
  item: RubyItem
  preserve: boolean
}

/** 已验证的对齐事实（Go `VerifiedAlignment`）。 */
export interface VerifiedAlignment {
  id: string
  base: string
  text: string
  kind: string
  occurrence: number
  start: number
  end: number
  source_fallback: boolean
}

/** 任务私有对齐草稿（Go `AlignmentState`；字段名沿用 JSON tag 以参与持久化）。 */
export interface AlignmentState {
  version: number
  validator_version: number
  protocol_version: number
  translation: string
  format: string
  items: AlignmentItem[]
  regions: TranslationRegion[]
  digest: string
  verified: VerifiedAlignment[]
}

/** 一次 ApplyOutput 的进展（Go `AlignmentProgress`）。 */
export interface AlignmentProgress {
  added: number
  /** 被拒绝的条目 ID → 拒绝原因（Go map）。 */
  rejected: Record<string, string>
}

/** 对齐区间（Go `alignmentInterval`）。 */
interface AlignmentInterval {
  start: number
  end: number
  valid: boolean
}

/** 探测文本中是否存在 XML / HTML 标签（Go `alignmentTagRE`）。 */
const alignmentTagRE = compile('</?[A-Za-z][A-Za-z0-9:-]*(?:\\s+[^<>]*)?/?>')

/**
 * HTML 具名实体表的常用子集。
 *
 * Go 的 `html.UnescapeString` 使用完整 HTML5 实体表（约 2200 项）；领域层只保留
 * 译文场景真正会出现的实体。`legacy=true` 表示允许省略分号（HTML5 的
 * no-semicolon legacy 集合）。缺失的生僻实体将原样保留（不回退为错误）。
 */
const HTML_ENTITIES: Record<string, { text: string; legacy: boolean }> = {
  amp: { text: '&', legacy: true },
  lt: { text: '<', legacy: true },
  gt: { text: '>', legacy: true },
  quot: { text: '"', legacy: true },
  apos: { text: "'", legacy: true },
  nbsp: { text: '\u00a0', legacy: true },
  copy: { text: '\u00a9', legacy: true },
  reg: { text: '\u00ae', legacy: true },
  not: { text: '\u00ac', legacy: true },
  deg: { text: '\u00b0', legacy: true },
  plusmn: { text: '\u00b1', legacy: true },
  middot: { text: '\u00b7', legacy: true },
  laquo: { text: '\u00ab', legacy: true },
  raquo: { text: '\u00bb', legacy: true },
  frac12: { text: '\u00bd', legacy: true },
  times: { text: '\u00d7', legacy: true },
  divide: { text: '\u00f7', legacy: true },
  euro: { text: '\u20ac', legacy: false },
  hellip: { text: '\u2026', legacy: false },
  mdash: { text: '\u2014', legacy: false },
  ndash: { text: '\u2013', legacy: false },
  lsquo: { text: '\u2018', legacy: false },
  rsquo: { text: '\u2019', legacy: false },
  ldquo: { text: '\u201c', legacy: false },
  rdquo: { text: '\u201d', legacy: false },
  bull: { text: '\u2022', legacy: false },
  dagger: { text: '\u2020', legacy: false },
  Dagger: { text: '\u2021', legacy: false },
  permil: { text: '\u2030', legacy: false },
  trade: { text: '\u2122', legacy: false },
  larr: { text: '\u2190', legacy: false },
  rarr: { text: '\u2192', legacy: false },
  harr: { text: '\u2194', legacy: false },
  NotEqualTilde: { text: '\u2242\u0338', legacy: false },
}

/** 把一个码点追加为字符串（非法码点按 Go 的 `html` 语义替换为 U+FFFD）。 */
function codePointToString(cp: number): string {
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\ufffd'
  return String.fromCodePoint(cp)
}

/**
 * Go `html.UnescapeString` 的常用子集实现。
 *
 * 逐字符扫描 `&`：数字引用（十进制/十六进制，分号可选）与具名实体（最长前缀
 * 匹配，legacy 实体允许省略分号）。未识别的 `&` 原样保留。
 */
export function htmlUnescapeString(s: string): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i] as string
    if (c !== '&') {
      out += c
      i++
      continue
    }
    // 数字字符引用
    if (s[i + 1] === '#') {
      let j = i + 2
      const hex = s[j] === 'x' || s[j] === 'X'
      if (hex) j++
      const digitsStart = j
      while (j < s.length && /[0-9A-Fa-f]/.test(s[j] as string)) j++
      if (j > digitsStart) {
        const digits = s.slice(digitsStart, j)
        let consumed = j
        if (s[consumed] === ';') consumed++
        const cp = Number.parseInt(digits, hex ? 16 : 10)
        out += codePointToString(cp)
        i = consumed
        continue
      }
    }
    // 具名实体：取最长可匹配前缀
    let end = i + 1
    while (end < s.length && /[A-Za-z0-9]/.test(s[end] as string)) end++
    const name = s.slice(i + 1, end)
    let matched: { text: string; legacy: boolean; len: number } | null = null
    for (let len = name.length; len >= 1; len--) {
      const entry = HTML_ENTITIES[name.slice(0, len)]
      if (entry === undefined) continue
      const hasSemicolon = s[i + 1 + len] === ';'
      if (entry.legacy || (len === name.length && hasSemicolon)) {
        matched = { text: entry.text, legacy: entry.legacy, len }
        break
      }
    }
    if (matched !== null) {
      out += matched.text
      let consumed = i + 1 + matched.len
      if (s[consumed] === ';') consumed++
      i = consumed
      continue
    }
    out += c
    i++
  }
  return out
}

/** HTML 区域实体解码结果：解码文本 + 被消费的原始字符数（0 表示未命中）。 */
interface RegionEntity {
  text: string
  consumed: number
}

/**
 * 解码一个 HTML 实体的**已消费前缀**（Go `decodeHTMLRegionEntity`）。
 *
 * HTML 允许部分具名/数字引用不带分号；必须找出真正被消费的前缀，否则
 * 「解码后的实体原文」会变成可匹配文本，或把普通后缀并入原子实体区间。
 */
export function decodeHTMLRegionEntity(raw: string): RegionEntity {
  let end = 1
  while (end < raw.length) {
    const c = raw[end] as string
    if (c === ';') {
      end++
      break
    }
    if (c !== '#' && !/[0-9A-Za-z]/.test(c)) break
    end++
  }
  const encoded = raw.slice(0, end)
  const decoded = htmlUnescapeString(encoded)
  if (decoded === encoded) return { text: '', consumed: 0 }
  let rawEnd = encoded.length
  let decodedEnd = decoded.length
  while (rawEnd > 1 && decodedEnd > 1 && encoded[rawEnd - 1] === decoded[decodedEnd - 1]) {
    rawEnd--
    decodedEnd--
  }
  if (htmlUnescapeString(encoded.slice(0, rawEnd)) !== decoded.slice(0, decodedEnd)) {
    return { text: decoded, consumed: encoded.length }
  }
  return { text: decoded.slice(0, decodedEnd), consumed: rawEnd }
}

/** XML 模式的实体解码：只接受 5 个预定义实体与数字引用（Go `xml.Unmarshal`）。 */
function decodeXMLEntity(encoded: string): string | null {
  if (!encoded.startsWith('&')) return null
  const body = encoded.slice(1, encoded.endsWith(';') ? -1 : undefined)
  if (!encoded.endsWith(';')) return null
  const numeric = /^#(?:[0-9]+|[xX][0-9A-Fa-f]+)$/.test(body)
  if (numeric) {
    const hex = body[1] === 'x' || body[1] === 'X'
    const literal = body.slice(hex ? 2 : 1)
    const cp = Number.parseInt(literal, hex ? 16 : 10)
    if (!Number.isFinite(cp) || cp > 0x10ffff) return null
    const ch = String.fromCodePoint(cp)
    // XML Char 范围校验（与 encoding/xml 一致）。
    if (
      !(
        cp === 0x09 ||
        cp === 0x0a ||
        cp === 0x0d ||
        (cp >= 0x20 && cp <= 0xd7ff) ||
        (cp >= 0xe000 && cp <= 0xfffd) ||
        (cp >= 0x10000 && cp <= 0x10ffff)
      )
    ) {
      return null
    }
    return ch
  }
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
  }
  return Object.prototype.hasOwnProperty.call(named, body) ? (named[body] as string) : null
}

/**
 * 构建 UTF-16 下标 → UTF-8 字节下标的映射（长度 = `text.length + 1`）。
 *
 * Go 的所有偏移量都是 UTF-8 字节偏移；JS 的查找/切片却以 UTF-16 code unit 计。
 * 本模块把「对外可见的偏移」统一为**字节偏移**（与黄金向量、持久化草稿逐字节一致），
 * 仅在需要切片时用本映射换回 UTF-16 下标。
 */
function utf16ToByteOffsets(text: string): number[] {
  const map: number[] = Array.from({ length: text.length + 1 }, () => 0)
  let bytes = 0
  for (let i = 0; i < text.length;) {
    map[i] = bytes
    const cp = text.codePointAt(i) ?? 0
    const width = cp > 0xffff ? 2 : 1
    if (width === 2) map[i + 1] = bytes // 代理对内部的字节下标无意义，取起始值
    bytes += utf8Length(String.fromCodePoint(cp))
    i += width
    map[i] = bytes
  }
  map[text.length] = bytes
  return map
}

/** 构建 UTF-8 字节下标 → UTF-16 下标的映射（仅 rune 起始字节有有效项）。 */
function byteToUtf16Offsets(text: string): Map<number, number> {
  const map = new Map<number, number>()
  let bytes = 0
  for (let i = 0; i < text.length;) {
    map.set(bytes, i)
    const cp = text.codePointAt(i) ?? 0
    const width = cp > 0xffff ? 2 : 1
    bytes += utf8Length(String.fromCodePoint(cp))
    i += width
  }
  map.set(bytes, text.length)
  return map
}

/**
 * 解码一块原始文本为可见译文文本 + 回原始文本的映射（Go `decodeRegion`）。
 *
 * 换行（`\r` / `\r\n`）与实体都映射为**原子**区段（linear=false），避免模型
 * 定位到其中间位置。所有偏移量均为 **UTF-8 字节偏移**（与 Go 一致）。
 */
function decodeRegion(raw: string, rawStart: number, xmlMode: boolean): TranslationRegion {
  let text = ''
  let textBytes = 0
  const rawBytes = utf16ToByteOffsets(raw)
  const mappings: RegionMapping[] = []
  const appendPiece = (piece: string, start: number, end: number, linear: boolean): void => {
    if (piece === '') return
    const viewStart = textBytes
    const pieceBytes = utf8Length(piece)
    text += piece
    textBytes += pieceBytes
    if (linear && mappings.length > 0) {
      const last = mappings[mappings.length - 1] as RegionMapping
      if (last.linear && last.raw_end === rawStart + (rawBytes[start] ?? 0)) {
        last.view_end = textBytes
        last.raw_end = rawStart + (rawBytes[end] ?? 0)
        return
      }
    }
    mappings.push({
      view_start: viewStart,
      view_end: textBytes,
      raw_start: rawStart + (rawBytes[start] ?? 0),
      raw_end: rawStart + (rawBytes[end] ?? 0),
      linear,
    })
  }
  for (let i = 0; i < raw.length;) {
    if (raw[i] === '\r') {
      let end = i + 1
      if (end < raw.length && raw[end] === '\n') end++
      appendPiece('\n', i, end, false)
      i = end
      continue
    }
    if (raw[i] === '&') {
      if (!xmlMode) {
        const decoded = decodeHTMLRegionEntity(raw.slice(i))
        if (decoded.consumed > 0) {
          appendPiece(decoded.text, i, i + decoded.consumed, false)
          i += decoded.consumed
          continue
        }
      }
      const semicolon = raw.indexOf(';', i)
      if (xmlMode && semicolon >= 0 && semicolon - i <= 64) {
        const end = semicolon + 1
        const encoded = raw.slice(i, end)
        const decoded = decodeXMLEntity(encoded)
        if (decoded === null) {
          throw new Error(
            `ruby entity: XML syntax error on line 1: invalid character entity ${encoded}`,
          )
        }
        appendPiece(decoded, i, end, false)
        i = end
        continue
      }
    }
    const cp = raw.codePointAt(i) ?? 0
    const size = cp > 0xffff ? 2 : 1
    appendPiece(raw.slice(i, i + size), i, i + size, true)
    i += size
  }
  return { text, mappings }
}

/** 标记分词结果种类。 */
type MarkupTokenKind = 'start' | 'end' | 'selfclosing' | 'text' | 'other'

/** 一个标记分词（只保留区域构建需要的字段）。 */
interface MarkupToken {
  kind: MarkupTokenKind
  raw: string
  /** 小写化后的本地标签名（仅 start / end）。 */
  name: string
}

/** 以原始文本元素（raw text）方式扫描内容的标签集合（x/net/html 行为）。 */
const RAW_TEXT_ELEMENTS = new Set([
  'script',
  'style',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'title',
  'textarea',
])

/** 大小写不敏感查找（避免 `toLowerCase()` 改变长度的边角情况）。 */
function indexOfCaseInsensitive(text: string, needle: string, from: number): number {
  const lowerNeedle = needle.toLowerCase()
  for (let i = from; i + needle.length <= text.length; i++) {
    if (text.slice(i, i + needle.length).toLowerCase() === lowerNeedle) return i
  }
  return -1
}

/** 解析开始标签名称（`[A-Za-z][A-Za-z0-9:-]*`）。 */
function matchTagName(text: string, pos: number, close: boolean): string | null {
  const start = pos + (close ? 2 : 1)
  const first = /[A-Za-z]/.exec(text.slice(start, start + 1))
  if (first === null) return null
  let end = start + 1
  while (end < text.length && /[A-Za-z0-9:-]/.test(text[end] as string)) end++
  return text.slice(start, end)
}

/**
 * 把译文切分为标记/文本 token（x/net/html tokenizer 的等价子集）。
 *
 * 注释、CDATA、指令、处理指令归为 `other`（区域构建忽略）；`<` 后不构成标签时
 * 按文本处理（与 HTML tokenizer 一致）；raw-text 元素内容整段作为文本。
 */
export function tokenizeMarkup(text: string): MarkupToken[] {
  const tokens: MarkupToken[] = []
  let pos = 0
  while (pos < text.length) {
    if (text[pos] !== '<') {
      const next = text.indexOf('<', pos)
      const end = next < 0 ? text.length : next
      tokens.push({ kind: 'text', raw: text.slice(pos, end), name: '' })
      pos = end
      continue
    }
    if (text.startsWith('<!--', pos)) {
      const close = text.indexOf('-->', pos + 4)
      const end = close < 0 ? text.length : close + 3
      tokens.push({ kind: 'other', raw: text.slice(pos, end), name: '' })
      pos = end
      continue
    }
    if (text.startsWith('<![CDATA[', pos)) {
      const close = text.indexOf(']]>', pos + 9)
      const end = close < 0 ? text.length : close + 3
      tokens.push({ kind: 'other', raw: text.slice(pos, end), name: '' })
      pos = end
      continue
    }
    if (text.startsWith('<!', pos)) {
      const close = text.indexOf('>', pos + 2)
      const end = close < 0 ? text.length : close + 1
      tokens.push({ kind: 'other', raw: text.slice(pos, end), name: '' })
      pos = end
      continue
    }
    if (text.startsWith('<?', pos)) {
      const close = text.indexOf('?>', pos + 2)
      const end = close < 0 ? text.length : close + 2
      tokens.push({ kind: 'other', raw: text.slice(pos, end), name: '' })
      pos = end
      continue
    }
    if (text.startsWith('</', pos)) {
      const name = matchTagName(text, pos, true)
      if (name === null) {
        tokens.push({ kind: 'text', raw: '<', name: '' })
        pos++
        continue
      }
      const close = text.indexOf('>', pos + 2)
      const end = close < 0 ? text.length : close + 1
      tokens.push({ kind: 'end', raw: text.slice(pos, end), name: name.toLowerCase() })
      pos = end
      continue
    }
    const name = matchTagName(text, pos, false)
    if (name === null) {
      tokens.push({ kind: 'text', raw: '<', name: '' })
      pos++
      continue
    }
    let i = pos + 1 + name.length
    let quote = ''
    while (i < text.length) {
      const c = text[i] as string
      if (quote !== '') {
        if (c === quote) quote = ''
        i++
        continue
      }
      if (c === '"' || c === "'") {
        quote = c
        i++
        continue
      }
      if (c === '>') break
      i++
    }
    if (i >= text.length) {
      // 未闭合标签：HTML tokenizer 在 EOF 时报错；此处按剩余文本处理。
      tokens.push({ kind: 'text', raw: text.slice(pos), name: '' })
      pos = text.length
      break
    }
    let j = i - 1
    while (j > pos && /\s/.test(text[j] as string)) j--
    const selfClosing = text[j] === '/'
    const lowerName = name.toLowerCase()
    tokens.push({
      kind: selfClosing ? 'selfclosing' : 'start',
      raw: text.slice(pos, i + 1),
      name: lowerName,
    })
    pos = i + 1
    if (!selfClosing && RAW_TEXT_ELEMENTS.has(lowerName)) {
      const close = indexOfCaseInsensitive(text, `</${lowerName}`, pos)
      const end = close < 0 ? text.length : close
      if (end > pos) {
        tokens.push({ kind: 'text', raw: text.slice(pos, end), name: '' })
      }
      pos = end
    }
  }
  return tokens
}

/** 取标签名的本地部分（去掉命名空间前缀，Go `localTagName`）。 */
function localTagName(name: string): string {
  const i = name.lastIndexOf(':')
  return i >= 0 ? name.slice(i + 1) : name
}

/** 是否属于「整体排除」的标签（Go `excludedRubyRegion`）。 */
function excludedRubyRegion(name: string): boolean {
  switch (name) {
    case 'ruby':
    case 'script':
    case 'style':
    case 'iframe':
    case 'xmp':
    case 'noembed':
    case 'noframes':
      return true
    default:
      return false
  }
}

/**
 * 冻结模型可定位的译文文本（Go `BuildTranslationRegions`）。
 *
 * 纯文本原样保留；标记文本排除全部标签语法、注释、既有 ruby 以及 body 之外的
 * script/style 内容；区域绝不跨节点拼接。EPUB 走 XML 实体/换行规则。
 *
 * 失败时抛出 `Error`，消息与 Go 的返回错误逐字一致。
 */
export function buildTranslationRegions(translation: string, format: string): TranslationRegion[] {
  if (hasLoneSurrogate(translation)) {
    throw new Error('ruby candidate is not valid UTF-8')
  }
  const lowerFormat = format.toLowerCase()
  const xmlMode = lowerFormat === 'epub'
  const markupMode =
    xmlMode ||
    lowerFormat === 'html' ||
    lowerFormat === 'docx' ||
    matchString(alignmentTagRE, translation)
  if (!markupMode) {
    if (translation === '') return []
    return [
      {
        text: translation,
        mappings: [
          {
            view_start: 0,
            view_end: utf8Length(translation),
            raw_start: 0,
            raw_end: utf8Length(translation),
            linear: true,
          },
        ],
      },
    ]
  }
  if (xmlMode) {
    const err = rawWellFormedError(translation, 'lf-ruby-view')
    if (err !== null) {
      throw new Error(`ruby candidate XML: ${err}`)
    }
  }
  const tokens = tokenizeMarkup(translation)
  const regions: TranslationRegion[] = []
  let excluded: string[] = []
  let pos = 0
  for (const token of tokens) {
    const start = pos
    pos += utf8Length(token.raw)
    switch (token.kind) {
      case 'start': {
        const name = localTagName(token.name)
        if (excluded.length > 0 || excludedRubyRegion(name)) {
          excluded.push(name)
        }
        break
      }
      case 'end': {
        const name = localTagName(token.name)
        for (let i = excluded.length - 1; i >= 0; i--) {
          if (excluded[i] === name) {
            excluded = excluded.slice(0, i)
            break
          }
        }
        break
      }
      case 'text': {
        if (excluded.length !== 0 || token.raw === '') break
        const region = decodeRegion(token.raw, start, xmlMode)
        if (region.text !== '') regions.push(region)
        break
      }
      default:
        break
    }
  }
  return regions
}

/** 一个区域的字节坐标索引（只在 occurrences 内构建一次）。 */
interface RegionIndex {
  byteLen: number
  utf16ToByte: number[]
  starts: Set<number>
}

/** 构建区域索引：UTF-16→字节映射、rune 起始字节集合。 */
function indexRegion(region: TranslationRegion): RegionIndex {
  const utf16ToByte = utf16ToByteOffsets(region.text)
  return {
    byteLen: utf8Length(region.text),
    utf16ToByte,
    starts: new Set(byteToUtf16Offsets(region.text).keys()),
  }
}

/** 视图字节下标 → 原始文本字节下标（Go `TranslationRegion.rawBoundary`）。 */
function rawBoundary(
  region: TranslationRegion,
  view: number,
  index: RegionIndex,
): [number, boolean] {
  if (view < 0 || view > index.byteLen) return [0, false]
  if (!index.starts.has(view)) return [0, false] // 码点中间
  for (const m of region.mappings) {
    if (view < m.view_start || view > m.view_end) continue
    if (view === m.view_start) return [m.raw_start, true]
    if (view === m.view_end) return [m.raw_end, true]
    if (m.linear) return [m.raw_start + view - m.view_start, true]
    return [0, false]
  }
  return [0, false]
}

/**
 * 保留完整视图序号的合法出现位置（Go `legalOccurrences`）。
 *
 * 返回最后一个合法位置的 1 基序号与实际合法数量；无法映射的（会劈开实体的）
 * 出现位置被跳过但**不重编号**。
 */
function legalOccurrences(locations: readonly AlignmentInterval[]): {
  position: number
  count: number
} {
  let position = 0
  let count = 0
  for (let i = 0; i < locations.length; i++) {
    if ((locations[i] as AlignmentInterval).valid) {
      position = i + 1
      count++
    }
  }
  return { position, count }
}

/** 在全部区域中查找 base 的出现位置（Go `AlignmentState.occurrences`）。 */
function occurrences(state: AlignmentState, base: string): AlignmentInterval[] {
  if (base === '') return []
  const found: AlignmentInterval[] = []
  for (const region of state.regions) {
    const index = indexRegion(region)
    const limit = region.text.length - base.length
    let from = 0
    while (from <= limit) {
      const rel = region.text.indexOf(base, from)
      if (rel < 0) break
      const start = index.utf16ToByte[rel] ?? 0
      const end = index.utf16ToByte[rel + base.length] ?? 0
      const [rawStart, okStart] = rawBoundary(region, start, index)
      const [rawEnd, okEnd] = rawBoundary(region, end, index)
      found.push({ start: rawStart, end: rawEnd, valid: okStart && okEnd })
      from = rel + base.length
    }
  }
  return found
}

/** 区间是否重叠（半开区间）。 */
function overlaps(start: number, end: number, otherStart: number, otherEnd: number): boolean {
  return start < otherEnd && otherStart < end
}

/**
 * 只冻结主响应里可信的分类（Go `ClassifyInitialItems`）。
 *
 * 重复/缺失 ID 或畸形行不能剥掉源条目的分类；已有分类不会被模型覆盖。
 */
export function classifyInitialItems(
  items: readonly RubyItem[],
  output: readonly OutputEntry[],
): RubyItem[] {
  const classified = items.map((it) => ({ ...it }))
  const counts = new Map<string, number>()
  for (const entry of output) {
    counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1)
  }
  const kinds = new Map<string, string>()
  for (const entry of output) {
    if (
      entry.id !== '' &&
      counts.get(entry.id) === 1 &&
      !entry.invalid &&
      entry.base !== '' &&
      entry.text !== '' &&
      isValidKind(entry.kind)
    ) {
      kinds.set(entry.id, entry.kind)
    }
  }
  for (const item of classified) {
    if (item.kind === '') {
      item.kind = kinds.get(item.id) ?? ''
    }
  }
  return classified
}

/** 构造对齐状态（Go `NewAlignmentState`）。 */
export function newAlignmentState(
  translation: string,
  format: string,
  items: readonly RubyItem[],
  keep: Record<string, boolean> | null,
  protocolVersion: number,
): AlignmentState {
  if (protocolVersion !== PROTOCOL_LEGACY && protocolVersion !== PROTOCOL_V2) {
    throw new Error('unsupported ruby protocol version')
  }
  const regions = buildTranslationRegions(translation, format)
  const state: AlignmentState = {
    version: ALIGNMENT_STATE_VERSION,
    validator_version: ALIGNMENT_VALIDATOR_VERSION,
    protocol_version: protocolVersion,
    translation,
    format,
    items: [],
    regions,
    digest: '',
    verified: [],
  }
  const seen = new Set<string>()
  for (const source of items) {
    if (source.id === '' || seen.has(source.id)) {
      throw new Error('ruby source item IDs must be nonempty and unique')
    }
    seen.add(source.id)
    const it: RubyItem = { ...source, aligned: false }
    const preserve = keep === null || it.kind === '' || keep[it.kind] === true
    state.items.push({ item: it, preserve })
  }
  state.digest = immutableDigest(state)
  return state
}

// ---------------------------------------------------------------------------
// Digest：Go `json.Marshal` 的逐字节等价实现
// ---------------------------------------------------------------------------

/**
 * Go `encoding/json` 的字符串编码：转义 `"`、`\`、控制字符、`<`、`>`、`&`
 * 以及 U+2028 / U+2029；其余字符原样输出（UTF-8）。
 */
function goJSONString(s: string): string {
  let out = '"'
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    switch (ch) {
      case '"':
        out += '\\"'
        break
      case '\\':
        out += '\\\\'
        break
      case '\n':
        out += '\\n'
        break
      case '\r':
        out += '\\r'
        break
      case '\t':
        out += '\\t'
        break
      case '\b':
        out += '\\b'
        break
      case '\f':
        out += '\\f'
        break
      case '<':
        out += '\\u003c'
        break
      case '>':
        out += '\\u003e'
        break
      case '&':
        out += '\\u0026'
        break
      default:
        if (cp < 0x20) {
          out += `\\u${cp.toString(16).padStart(4, '0')}`
        } else if (cp === 0x2028) {
          out += '\\u2028'
        } else if (cp === 0x2029) {
          out += '\\u2029'
        } else {
          out += ch
        }
    }
  }
  return out + '"'
}

/** Go `ruby.Item` 的 JSON 形态（omitempty 空串、aligned 不参与）。 */
function goJSONItem(item: RubyItem): string {
  const fields: string[] = [`"id":${goJSONString(item.id)}`]
  if (item.source_base !== '') fields.push(`"source_base":${goJSONString(item.source_base)}`)
  if (item.source_text !== '') fields.push(`"source_text":${goJSONString(item.source_text)}`)
  if (item.target_base !== '') fields.push(`"target_base":${goJSONString(item.target_base)}`)
  if (item.target_text !== '') fields.push(`"target_text":${goJSONString(item.target_text)}`)
  if (item.kind !== '') fields.push(`"kind":${goJSONString(item.kind)}`)
  return `{${fields.join(',')}}`
}

/** Go `ruby.RegionMapping` 的 JSON 形态。 */
function goJSONMapping(m: RegionMapping): string {
  return (
    `{"view_start":${m.view_start},"view_end":${m.view_end},` +
    `"raw_start":${m.raw_start},"raw_end":${m.raw_end},"linear":${m.linear ? 'true' : 'false'}}`
  )
}

/** Go `ruby.TranslationRegion` 的 JSON 形态（nil mappings 序列化为 null）。 */
function goJSONRegion(r: TranslationRegion): string {
  const mappings = r.mappings.length === 0 ? 'null' : `[${r.mappings.map(goJSONMapping).join(',')}]`
  return `{"text":${goJSONString(r.text)},"mappings":${mappings}}`
}

/** 计算不可变字段摘要（Go `AlignmentState.immutableDigest`）。 */
export function immutableDigest(state: AlignmentState): string {
  const items =
    state.items.length === 0
      ? 'null'
      : `[${state.items
          .map(
            (it) => `{"item":${goJSONItem(it.item)},"preserve":${it.preserve ? 'true' : 'false'}}`,
          )
          .join(',')}]`
  const regions =
    state.regions.length === 0 ? 'null' : `[${state.regions.map(goJSONRegion).join(',')}]`
  const json =
    `{"version":${state.version},"validator_version":${state.validator_version},` +
    `"protocol_version":${state.protocol_version},"translation":${goJSONString(state.translation)},` +
    `"format":${goJSONString(state.format)},"items":${items},"regions":${regions},` +
    `"digest":"","verified":null}`
  return fullHash(json)
}

/** 两个区域列表是否深度相等（Go `reflect.DeepEqual` 的等价实现）。 */
function regionsEqual(a: readonly TranslationRegion[], b: readonly TranslationRegion[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as TranslationRegion
    const y = b[i] as TranslationRegion
    if (x.text !== y.text || x.mappings.length !== y.mappings.length) return false
    for (let j = 0; j < x.mappings.length; j++) {
      const m = x.mappings[j] as RegionMapping
      const n = y.mappings[j] as RegionMapping
      if (
        m.view_start !== n.view_start ||
        m.view_end !== n.view_end ||
        m.raw_start !== n.raw_start ||
        m.raw_end !== n.raw_end ||
        m.linear !== n.linear
      ) {
        return false
      }
    }
  }
  return true
}

/**
 * 校验加载后的草稿（Go `AlignmentState.Validate`）。
 *
 * 拒绝不受支持/损坏的数据，但不丢弃、不静默重译。失败时抛出 `Error`。
 */
export function validateAlignmentState(state: AlignmentState | null): void {
  if (
    state === null ||
    state.version !== ALIGNMENT_STATE_VERSION ||
    state.validator_version !== ALIGNMENT_VALIDATOR_VERSION ||
    (state.protocol_version !== PROTOCOL_LEGACY && state.protocol_version !== PROTOCOL_V2)
  ) {
    throw new Error('unsupported ruby alignment state version')
  }
  if (state.digest === '' || state.digest !== immutableDigest(state)) {
    throw new Error('ruby alignment state digest mismatch')
  }
  const regions = buildTranslationRegions(state.translation, state.format)
  if (!regionsEqual(regions, state.regions)) {
    throw new Error('ruby alignment regions cannot be reproduced')
  }
  const items = new Map<string, AlignmentItem>()
  for (const it of state.items) {
    if (it.item.id === '') {
      throw new Error('ruby alignment item missing ID')
    }
    if (items.has(it.item.id)) {
      throw new Error('ruby alignment duplicate source ID')
    }
    items.set(it.item.id, it)
  }
  const seen = new Set<string>()
  for (let i = 0; i < state.verified.length; i++) {
    const v = state.verified[i] as VerifiedAlignment
    const it = items.get(v.id)
    if (
      it === undefined ||
      !it.preserve ||
      seen.has(v.id) ||
      v.text === '' ||
      !isValidKind(v.kind)
    ) {
      throw new Error('invalid verified ruby entry')
    }
    seen.add(v.id)
    const locations = occurrences(state, v.base)
    if (v.occurrence < 1 || v.occurrence > locations.length) {
      throw new Error('verified ruby occurrence missing')
    }
    const p = locations[v.occurrence - 1] as AlignmentInterval
    const legal = legalOccurrences(locations)
    if (
      !p.valid ||
      p.start !== v.start ||
      p.end !== v.end ||
      (v.source_fallback && (v.base !== it.item.source_base || legal.count !== 1))
    ) {
      throw new Error('verified ruby position mismatch')
    }
    for (let k = 0; k < i; k++) {
      const earlier = state.verified[k] as VerifiedAlignment
      if (overlaps(v.start, v.end, earlier.start, earlier.end)) {
        throw new Error('verified ruby intervals overlap')
      }
    }
  }
}

/** 返回所有尚未验证、且需要保留的条目（Go `AlignmentState.Missing`）。 */
export function missingItems(state: AlignmentState): RubyItem[] {
  const done = new Set<string>()
  for (const v of state.verified) done.add(v.id)
  const missing: RubyItem[] = []
  for (const it of state.items) {
    if (it.preserve && !done.has(it.item.id)) missing.push(it.item)
  }
  return missing
}

/**
 * 校验完整响应后再接受区间（Go `AlignmentState.ApplyOutput`）。
 *
 * `requestedIds` 是本次请求冻结的精确子集；v2 对齐请求需 `requireOccurrence`，
 * 初始主响应则不需要。就地追加 `state.verified`。
 */
export function applyOutput(
  state: AlignmentState,
  requestedIds: readonly string[],
  entries: readonly OutputEntry[],
  requireOccurrence: boolean,
): AlignmentProgress {
  const progress: AlignmentProgress = { added: 0, rejected: {} }
  const requested = new Set(requestedIds)
  const missing = new Map<string, RubyItem>()
  for (const it of missingItems(state)) missing.set(it.id, it)
  const counts = new Map<string, number>()
  for (const e of entries) counts.set(e.id, (counts.get(e.id) ?? 0) + 1)

  const proposed: VerifiedAlignment[] = []
  for (const e of entries) {
    const it = missing.get(e.id)
    if (e.id === '' || !requested.has(e.id) || it === undefined) {
      progress.rejected[e.id] = 'unrequested_id'
      continue
    }
    if ((counts.get(e.id) ?? 0) !== 1) {
      progress.rejected[e.id] = 'duplicate_id'
      continue
    }
    if (
      e.invalid ||
      e.base === '' ||
      e.text === '' ||
      !isValidKind(e.kind) ||
      e.occurrence < 0 ||
      (requireOccurrence && e.occurrence === 0)
    ) {
      progress.rejected[e.id] = 'invalid_entry'
      continue
    }
    let locations = occurrences(state, e.base)
    let base = e.base
    let occurrence = e.occurrence
    let fallback = false
    const legal = legalOccurrences(locations)
    if (legal.count === 0 && it.source_base !== '' && it.source_base !== e.base) {
      locations = occurrences(state, it.source_base)
      const fallbackLegal = legalOccurrences(locations)
      if (fallbackLegal.count === 1) {
        base = it.source_base
        occurrence = fallbackLegal.position
        fallback = true
      } else {
        progress.rejected[e.id] = 'source_fallback_ambiguous'
        continue
      }
    }
    if (occurrence === 0 && !requireOccurrence) {
      const current = legalOccurrences(locations)
      if (current.count === 1) occurrence = current.position
    }
    if (occurrence < 1 || occurrence > locations.length) {
      progress.rejected[e.id] = 'invalid_occurrence'
      continue
    }
    const p = locations[occurrence - 1] as AlignmentInterval
    if (!p.valid) {
      progress.rejected[e.id] = 'unsafe_text_boundary'
      continue
    }
    const v: VerifiedAlignment = {
      id: e.id,
      base,
      text: e.text,
      kind: e.kind,
      occurrence,
      start: p.start,
      end: p.end,
      source_fallback: fallback,
    }
    let conflict = false
    for (const old of state.verified) {
      if (overlaps(v.start, v.end, old.start, old.end)) {
        conflict = true
        break
      }
    }
    if (conflict) {
      progress.rejected[e.id] = 'verified_interval_conflict'
      continue
    }
    proposed.push(v)
  }

  const conflicts = new Set<string>()
  for (let i = 0; i < proposed.length; i++) {
    const a = proposed[i] as VerifiedAlignment
    for (let j = i + 1; j < proposed.length; j++) {
      const b = proposed[j] as VerifiedAlignment
      if (overlaps(a.start, a.end, b.start, b.end)) {
        conflicts.add(a.id)
        conflicts.add(b.id)
      }
    }
  }
  for (const v of proposed) {
    if (conflicts.has(v.id)) {
      progress.rejected[v.id] = 'interval_conflict'
      continue
    }
    state.verified.push(v)
    progress.added++
  }
  return progress
}

/**
 * 渲染最终译文（Go `AlignmentState.Render`）。
 *
 * 先 `Validate`；按 start 升序插入 `<ruby>`，注音文本做 HTML 转义。
 */
export function renderAlignmentState(state: AlignmentState): {
  text: string
  result: { matched: number; total: number }
} {
  validateAlignmentState(state)
  const result = { matched: state.verified.length, total: 0 }
  for (const it of state.items) {
    if (it.preserve) result.total++
  }
  const byteToUtf16 = byteToUtf16Offsets(state.translation)
  const ordered = [...state.verified].sort((a, b) => a.start - b.start)
  let out = ''
  let start = 0
  for (const v of ordered) {
    const from = byteToUtf16.get(v.start)
    const to = byteToUtf16.get(v.end)
    if (from === undefined || to === undefined) {
      throw new Error('verified ruby position mismatch')
    }
    out += state.translation.slice(start, from)
    out += `<ruby>${state.translation.slice(from, to)}<rt>${htmlEscapeString(v.text)}</rt></ruby>`
    start = to
  }
  out += state.translation.slice(start)
  return { text: out, result }
}
