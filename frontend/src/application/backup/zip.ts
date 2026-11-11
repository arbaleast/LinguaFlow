/**
 * 极简 ZIP 读写（仅本项目备份所需的功能）。
 *
 * ## 为什么自己写
 *
 * - 浏览器端没有 Node 的 `zlib`；`CompressionStream` / `DecompressionStream`
 *   在现代浏览器可用，但**并非所有目标环境都有**（例如某些 WebView、Node < 18）。
 * - 备份必须能在**没有压缩能力**的环境下依然可用，因此写盘默认用 **STORE**
 *   （不压缩），只有当环境提供 `CompressionStream` 时才用 DEFLATE。
 * - 不引入第三方依赖，避免为「打一个包」增加供应链面。
 *
 * ## 支持范围
 *
 * - 写入：`STORE`（方法 0）；可选 `DEFLATE`（方法 8，需 `CompressionStream`）。
 * - 读取：`STORE` 与 `DEFLATE`（需 `DecompressionStream`，否则 DEFLATE 条目报错）。
 * - 不支持：ZIP64、加密条目、多卷归档、目录条目（会自动跳过目录项）。
 */
import { BackupError } from './types'

/** ZIP 条目。 */
export interface ZipEntry {
  /** 条目名（归档内路径）。 */
  name: string
  /** 原始内容。 */
  data: Uint8Array
}

/** CRC-32（IEEE 802.3）查表。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

/** 计算 CRC-32。 */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = (CRC_TABLE[(crc ^ (data[i] as number)) & 0xff] as number) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** 是否支持 DEFLATE 压缩 / 解压。 */
export function supportsDeflate(): boolean {
  return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function'
}

/** 把字节数组拼成一个大数组。 */
function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** 写入 16 位小端整数。 */
function writeU16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value & 0xffff, true)
}

/** 写入 32 位小端整数。 */
function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true)
}

/** 压缩为 raw deflate（`CompressionStream` 的 `deflate-raw`）。 */
async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (!supportsDeflate()) {
    throw new BackupError('unsupported_operation', '当前环境不支持 DEFLATE 压缩')
  }
  const stream = new CompressionStream('deflate-raw')
  const writer = stream.writable.getWriter()
  void writer.write(data as Uint8Array<ArrayBuffer>)
  void writer.close()
  const compressed = await new Response(stream.readable).arrayBuffer()
  return new Uint8Array(compressed)
}

/** 解压 raw deflate。 */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (!supportsDeflate()) {
    throw new BackupError('unsupported_operation', '当前环境不支持 DEFLATE 解压')
  }
  const stream = new DecompressionStream('deflate-raw')
  const writer = stream.writable.getWriter()
  void writer.write(data as Uint8Array<ArrayBuffer>)
  void writer.close()
  const inflated = await new Response(stream.readable).arrayBuffer()
  return new Uint8Array(inflated)
}

/**
 * 打包成 ZIP 字节流。
 *
 * @param entries 条目列表
 * @param compress 是否尝试 DEFLATE（环境不支持时自动降级为 STORE）
 */
export async function createZip(entries: ZipEntry[], compress = false): Promise<Uint8Array> {
  const encoder = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const crc = crc32(entry.data)
    let method = 0
    let payload = entry.data
    if (compress && entry.data.length > 0) {
      try {
        const deflated = await deflateRaw(entry.data)
        if (deflated.length < entry.data.length) {
          method = 8
          payload = deflated
        }
      } catch {
        // 压缩失败 → 保持 STORE。
      }
    }

    const local = new Uint8Array(30 + nameBytes.length)
    const localView = new DataView(local.buffer)
    writeU32(localView, 0, 0x04034b50)
    writeU16(localView, 4, 20) // version needed
    writeU16(localView, 6, 0x0800) // UTF-8 文件名标志
    writeU16(localView, 8, method)
    writeU16(localView, 10, 0) // time
    writeU16(localView, 12, 0x21) // date（1996-01-01，固定值保证可复现）
    writeU32(localView, 14, crc)
    writeU32(localView, 18, payload.length)
    writeU32(localView, 22, entry.data.length)
    writeU16(localView, 26, nameBytes.length)
    writeU16(localView, 28, 0)
    local.set(nameBytes, 30)
    locals.push(local, payload)

    const central = new Uint8Array(46 + nameBytes.length)
    const centralView = new DataView(central.buffer)
    writeU32(centralView, 0, 0x02014b50)
    writeU16(centralView, 4, 20) // version made by
    writeU16(centralView, 6, 20) // version needed
    writeU16(centralView, 8, 0x0800)
    writeU16(centralView, 10, method)
    writeU16(centralView, 12, 0)
    writeU16(centralView, 14, 0x21)
    writeU32(centralView, 16, crc)
    writeU32(centralView, 20, payload.length)
    writeU32(centralView, 24, entry.data.length)
    writeU16(centralView, 28, nameBytes.length)
    writeU16(centralView, 30, 0) // extra
    writeU16(centralView, 32, 0) // comment
    writeU16(centralView, 34, 0) // disk
    writeU16(centralView, 36, 0) // internal attrs
    writeU32(centralView, 38, 0) // external attrs
    writeU32(centralView, 42, offset)
    central.set(nameBytes, 46)
    centrals.push(central)

    offset += local.length + payload.length
  }

  const centralBytes = concat(centrals)
  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  writeU32(eocdView, 0, 0x06054b50)
  writeU16(eocdView, 4, 0)
  writeU16(eocdView, 6, 0)
  writeU16(eocdView, 8, entries.length)
  writeU16(eocdView, 10, entries.length)
  writeU32(eocdView, 12, centralBytes.length)
  writeU32(eocdView, 16, offset)
  writeU16(eocdView, 20, 0)

  return concat([...locals, centralBytes, eocd])
}

/** 解析出的 ZIP 目录项。 */
interface CentralEntry {
  name: string
  method: number
  crc: number
  compressedSize: number
  size: number
  localOffset: number
}

/**
 * 解包 ZIP 字节流。
 *
 * @throws BackupError('corrupt_payload') 当结构非法时
 */
export async function readZip(data: Uint8Array): Promise<ZipEntry[]> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  // 找 End of Central Directory（从尾部回扫最多 65557 字节）。
  let eocd = -1
  const minPos = Math.max(0, data.length - 65557)
  for (let i = data.length - 22; i >= minPos; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) {
    throw new BackupError('corrupt_payload', '不是合法的 ZIP：缺少中央目录结束记录')
  }
  const count = view.getUint16(eocd + 10, true)
  const centralOffset = view.getUint32(eocd + 16, true)

  const decoder = new TextDecoder()
  const entries: CentralEntry[] = []
  let pointer = centralOffset
  for (let i = 0; i < count; i++) {
    if (view.getUint32(pointer, true) !== 0x02014b50) {
      throw new BackupError('corrupt_payload', `ZIP 中央目录第 ${i} 项签名非法`)
    }
    const nameLength = view.getUint16(pointer + 28, true)
    const extraLength = view.getUint16(pointer + 30, true)
    const commentLength = view.getUint16(pointer + 32, true)
    entries.push({
      name: decoder.decode(data.subarray(pointer + 46, pointer + 46 + nameLength)),
      method: view.getUint16(pointer + 10, true),
      crc: view.getUint32(pointer + 16, true),
      compressedSize: view.getUint32(pointer + 20, true),
      size: view.getUint32(pointer + 24, true),
      localOffset: view.getUint32(pointer + 42, true),
    })
    pointer += 46 + nameLength + extraLength + commentLength
  }

  const out: ZipEntry[] = []
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue
    const localNameLength = view.getUint16(entry.localOffset + 26, true)
    const localExtraLength = view.getUint16(entry.localOffset + 28, true)
    const start = entry.localOffset + 30 + localNameLength + localExtraLength
    const raw = data.subarray(start, start + entry.compressedSize)
    let content: Uint8Array
    if (entry.method === 0) {
      content = raw
    } else if (entry.method === 8) {
      content = await inflateRaw(raw)
    } else {
      throw new BackupError('unsupported_operation', `不支持的 ZIP 压缩方法：${entry.method}`)
    }
    if (crc32(content) !== entry.crc) {
      throw new BackupError('corrupt_payload', `ZIP 条目 CRC 校验失败：${entry.name}`)
    }
    out.push({ name: entry.name, data: content })
  }
  return out
}
