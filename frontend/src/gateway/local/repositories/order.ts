/**
 * 字符串排序比较器（复刻 Go 的字节序）。
 *
 * Go 的 `<` 对 `string` 按 **UTF-8 字节**逐字节比较；JS 的 `<` 按 UTF-16
 * code unit 比较，对基本平面字符一致，但对增补平面字符（emoji、扩展 CJK）
 * 会因代理对落在 0xD800–0xDFFF 而与 UTF-8 顺序相反。
 *
 * 资源树子节点与术语 CSV 顺序都要与后端逐字节一致，故这里显式编码为 UTF-8
 * 后比较。`utf8Encode` 是领域层的纯函数，不依赖 TextEncoder。
 */
import { utf8Encode } from '@/domain/shared/unicode'

/** 按 UTF-8 字节序比较两个字符串（等价 Go 的 `a < b`）。 */
export function compareUtf8(a: string, b: string): number {
  const left = utf8Encode(a)
  const right = utf8Encode(b)
  const length = Math.min(left.length, right.length)
  for (let i = 0; i < length; i++) {
    const diff = (left[i] as number) - (right[i] as number)
    if (diff !== 0) return diff
  }
  return left.length - right.length
}
