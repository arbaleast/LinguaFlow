// Command foldtable 把 Go `unicode.SimpleFold` 的折叠环导出为前端可用的静态表。
//
// 背景：Go `segmatch` 的大小写不敏感子串匹配依赖 `unicode.SimpleFold` 的
// **折叠环最小代表元**（两个 rune 折叠等价当且仅当代表元相同）。
// JS 的 `toLowerCase()` / `toUpperCase()` 是**完整映射**（可能展开成多个码点），
// 与 SimpleFold 的「一码点对一码点」折叠环并不等价
// （如 U+0130 İ、U+017F ſ、U+00DF ß、U+212A K、U+00B5 µ 等处结果不同）。
//
// 本命令从 Go 标准库导出精确的折叠环代表元表，保证前后端匹配结果逐字节一致。
//
// 用法：
//
//	go run ./cmd/foldtable -out ../frontend/src/domain/search/fold-table.ts
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
)

func main() {
	out := flag.String("out", "../frontend/src/domain/search/fold-table.ts", "输出文件路径")
	flag.Parse()

	// 收集所有大小于 1 的折叠环。
	orbits := map[rune]map[rune]bool{}
	for cp := 0; cp <= 0x10FFFF; cp++ {
		r := rune(cp)
		if unicode.SimpleFold(r) == r {
			continue
		}
		orbit := map[rune]bool{}
		for f := unicode.SimpleFold(r); ; f = unicode.SimpleFold(f) {
			orbit[f] = true
			if unicode.SimpleFold(f) == r {
				break
			}
		}
		orbits[r] = orbit
	}

	// 每个码点 → 其折叠环的最小代表元。
	rep := map[rune]rune{}
	for _, orbit := range orbits {
		min := rune(0)
		for r := range orbit {
			if min == 0 || r < min {
				min = r
			}
		}
		for r := range orbit {
			rep[r] = min
		}
	}

	keys := make([]rune, 0, len(rep))
	for r := range rep {
		keys = append(keys, r)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })

	var b strings.Builder
	b.WriteString(header)
	b.WriteString("/**\n")
	b.WriteString(" * 折叠环代表元表（扁平数组：每两个数是一组「码点 → 代表元」）。\n")
	b.WriteString(" *\n")
	b.WriteString(" * 由 `backend/cmd/foldtable` 从 Go 标准库 `unicode.SimpleFold` 导出，\n")
	b.WriteString(" * 覆盖所有大小于 1 的折叠环（1,482 个环 / 2,994 个码点）。\n")
	b.WriteString(" *\n")
	b.WriteString(" * 查表用二分（`foldRepresentative`），未命中的码点即自身即代表元。\n")
	b.WriteString(" *\n")
	b.WriteString(" * 本文件由工具生成，**不要手工编辑**。\n")
	b.WriteString(" */\n")
	b.WriteString("export const FOLD_TABLE: readonly number[] = [\n")
	for i, r := range keys {
		if i%12 == 0 {
			b.WriteString("  ")
		}
		fmt.Fprintf(&b, "0x%04X, 0x%04X,", r, rep[r])
		if i%12 == 11 {
			b.WriteString("\n")
		} else {
			b.WriteString(" ")
		}
	}
	b.WriteString("]\n")
	b.WriteString(footer)

	if err := os.MkdirAll(filepath.Dir(*out), 0o755); err != nil {
		fatalf("创建输出目录失败: %v", err)
	}
	if err := os.WriteFile(*out, []byte(b.String()), 0o644); err != nil {
		fatalf("写入 %s 失败: %v", *out, err)
	}
	fmt.Printf("折叠环表已导出 → %s（%d 个码点）\n", *out, len(keys))
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}

const header = ""

const footer = `
/**
 * 查询码点的折叠环代表元。
 *
 * 两个码点折叠等价当且仅当代表元相同。
 * 未出现在表中的码点没有折叠伙伴，代表元即其自身。
 */
export function foldRepresentative(cp: number): number {
  let lo = 0
  let hi = FOLD_TABLE.length / 2 - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const key = FOLD_TABLE[mid * 2] as number
    if (key === cp) {
      return FOLD_TABLE[mid * 2 + 1] as number
    }
    if (key < cp) {
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return cp
}
`
