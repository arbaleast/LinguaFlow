# `frontend/src/domain/` — 领域层移植规范

本目录是 LinguaFlow「浏览器优先架构迁移 Phase 1」的产物：把 Go 后端的**纯计算领域逻辑**
1:1 移植为纯 TypeScript，并通过**黄金测试向量（Golden Vectors）**与 Go 侧真实输出做 100% 对拍。

---

## 1. 硬性约束

| 约束       | 说明                                                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 零平台依赖 | 不得使用 DOM / Window / IndexedDB / OPFS / fetch / Node API。领域层是纯函数 + 纯内存状态。                                             |
| 零回归     | 不修改 `frontend/src/api/`、`frontend/src/stores/`、`frontend/src/composables/`、`frontend/src/components/` 的既有 import 路径与行为。 |
| 逐字节一致 | 与 Go 侧输出必须逐字节相同（含占位符 key、大小写、排序、空白）。                                                                       |
| 可测试性   | 不得直接调用 `Date.now()`；需要时间时注入 `Clock`（见 `shared/clock.ts`）。                                                            |

## 2. 命名映射（Go → TS）

| Go                     | TS                                    | 规则                       |
| ---------------------- | ------------------------------------- | -------------------------- |
| `ProtectText`          | `protectText`                         | 导出函数：驼峰             |
| `PlaceholderProtector` | `PlaceholderProtector`                | 导出类型/类：帕斯卡        |
| `model.Segment`        | `ProtectableSegment` / `BatchSegment` | 只保留该模块真正读写的字段 |
| `map[string]string`    | `Record<string, string>`              |                            |
| `map[string]any`       | `Record<string, unknown>`             |                            |
| `[]int`                | `number[]`                            |                            |
| `func(x int) int`      | `(x: number) => number`               |                            |
| `error`                | `void`（失败通过 `Result` 表达）      | 见 `shared/result.ts`      |

**持久化契约例外**：会随 `seg.Meta` 落库并与 Go 后端互通的字段，**沿用 Go 的 snake_case 名字**
（如 `ruby.Item` 的 `source_base` / `target_text`）。见 `domain/ruby/item.ts` 的 `RubyItemWire`。

## 3. 黄金测试向量工作流

```
Go 生产代码 ──(backend/internal/<pkg>/golden_vectors_test.go)──> frontend/src/domain/__fixtures__/<pkg>.json
                                                                          │
                                                          frontend/src/domain/__tests__/<pkg>.golden.test.ts
                                                                          │
                                                                    100% 深相等断言
```

### 3.1 Go 侧导出器

在目标包内新增 `golden_vectors_test.go`（**只允许 `_test.go`**，不侵入生产代码）：

```go
package mypkg

import (
    "testing"
    "github.com/MeowSalty/LinguaFlow/backend/internal/goldenv"
)

func TestGoldenVectors(t *testing.T) {
    out := goldenv.OutDir()
    if out == "" {
        t.Skip("未设置 " + goldenv.EnvOutDir + "，跳过黄金向量导出")
    }
    cases := []goldenv.Case{ /* ... */ }
    n, err := goldenv.Write(out, "mypkg", cases)
    if err != nil { t.Fatalf("写入黄金向量失败: %v", err) }
    t.Logf("mypkg 黄金向量已导出: %d 条 → %s/mypkg.json", n, out)
}
```

- `goldenv.Case{ID, Op, Args, Expect}`：`Op` 是 TS 侧的分派键，`Expect` 是 **Go 真实输出**（不是人工誊写）。
- `goldenv.Write` 按 `ID` 排序输出，`encoding/json` 对 map key 字典序排序，故输出稳定可 diff。
- 常规 `go test ./...` 因未设置环境变量而 `t.Skip`，无副作用。

导出命令：

```bash
cd backend
source ../.tooling/goenv.sh
LINGUAFLOW_GOLDEN_OUT="$(cd .. && pwd)/frontend/src/domain/__fixtures__" \
  go test ./internal/<pkg>/ -run TestGoldenVectors -v
```

### 3.2 Go → JSON 的归一化规则（必须遵守，否则 TS 侧无法直接对拍）

| Go 值                | JSON   | TS 侧对应 | 归一化方式                                         |
| -------------------- | ------ | --------- | -------------------------------------------------- |
| `nil` map            | `null` | `{}`      | 导出器里 `if m == nil { m = map[string]string{} }` |
| `nil` slice          | `null` | `[]`      | 导出器里 `if s == nil { s = []string{} }`          |
| `nil` `[][]int`      | `null` | `[]`      | 同上                                               |
| `nil` map[string]any | `null` | `null`    | 保持 `null`（`meta` 语义上区分「无」与「空」）     |

**规则**：凡 TS 侧用「空数组 / 空对象」表达「无结果」的，导出器一律归一为空容器；
凡 TS 侧用 `null` 表达的（如 `Analysis.Mapping`、`meta`），导出器保持 `null`。

### 3.3 TS 侧对拍测试

位置：`frontend/src/domain/__tests__/<pkg>.golden.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import pkgFixture from '../__fixtures__/<pkg>.json'
import { runGolden, type GoldenFixture } from './helpers/golden'

const fixture = pkgFixture as unknown as GoldenFixture

describe('domain/<pkg> 黄金向量', () => {
  it('覆盖全部黄金向量', () => {
    runGolden(fixture, {
      '<pkg>.<op>': (args) => {
        /* 调用领域层函数，返回待比对值 */
      },
    })
  })
})
```

`runGolden` 会：

1. 按 `Op` 分派；
2. 与 `Expect` 做**深相等**断言（失败时打印用例 ID）；
3. 若某个注册的处理器没有被任何用例覆盖 → 抛错（防止漏实现入口）。

## 4. 正则引擎对齐（RE2）

**禁止**直接把 Go 正则源码搬进 JS `RegExp`。必须用 `re2js`（`domain/shared/re2.ts` 已封装）：

| 语义     | Go RE2                  | JS `RegExp`（差异）                  |
| -------- | ----------------------- | ------------------------------------ |
| `\s`     | `[\t\n\f\r ]`           | 含 `\v`、NBSP、全角空格、U+FEFF      |
| `(?m)^`  | 仅 `\n` 之后            | 也在 `\r` / `\u2028` / `\u2029` 之后 |
| `(?m)$`  | 仅 `\n` 之前 + 文本末尾 | 也在 `\r` / `\u2028` / `\u2029` 之前 |
| 匹配语义 | leftmost-first          | leftmost-first（一致）               |

`domain/shared/re2.ts` 提供 Go `regexp` 等价封装：

| Go                               | TS                                |
| -------------------------------- | --------------------------------- |
| `regexp.MustCompile`             | `compile(pattern)`                |
| `re.ReplaceAllStringFunc(s, fn)` | `replaceAllStringFunc(re, s, fn)` |
| `re.FindAllStringIndex(s, -1)`   | `findAllStringIndex(re, s)`       |
| `re.FindStringSubmatch(s)`       | `findStringSubmatch(re, s)`       |
| `re.FindString(s)`               | `findString(re, s)`               |
| `re.MatchString(s)`              | `matchString(re, s)`              |

**偏移量单位**：re2js 的 `start()` / `end()` 返回 **UTF-16 code unit 下标**（Go 返回 UTF-8 字节下标）。
所有切片都在同一坐标系内完成，截取出的子串与 Go 一致；但若需要**字节**语义（如 Go 里比较 `len()`），
必须显式用 `utf8Length()`。

## 5. rune / byte 语义对齐

Go 的 `for _, r := range s` 迭代 **Unicode 码点**；`len(s)` 是 **UTF-8 字节数**；
`utf8.RuneCountInString(s)` 是码点数。

JS 侧对照（见 `domain/shared/unicode.ts`）：

| Go                           | TS                             | 注意                                  |
| ---------------------------- | ------------------------------ | ------------------------------------- |
| `for _, r := range s`        | `for (const ch of text)`       | JS 的字符串迭代按码点，代理对自动合并 |
| `utf8.RuneCountInString(s)`  | `runeCount(text)`              |                                       |
| `len(s)`（字节）             | `utf8Length(text)`             |                                       |
| `string([]rune(s)[:n])`      | `sliceRunes(text, 0, n)`       | 按码点切片，不是 `text.slice(0, n)`   |
| `unicode.IsLetter(r)`        | `isLetter(cp)`                 | = `\p{L}`                             |
| `unicode.IsDigit(r)`         | `isDigit(cp)`                  | = `\p{Nd}`（**不是** `\p{N}`）        |
| `unicode.IsSpace(r)`         | `isSpace(cp)`                  | **不等于** JS `\s`（JS 多含 U+FEFF）  |
| `unicode.Is(unicode.Han, r)` | `isCJK(cp)` / `\p{Script=Han}` |                                       |

**禁止**在移植代码里用 `text.length` / `text.slice()` 直接代替 Go 的 rune 语义。

## 6. 已完成的模块（可作为范式参考）

| 模块                       | Go 源                                           | 黄金向量                        |
| -------------------------- | ----------------------------------------------- | ------------------------------- |
| `domain/shared/hash.ts`    | `internal/hash/hash.go`                         | `hash.json`                     |
| `domain/shared/words.ts`   | `internal/pipeline/batch_utils.go`              | `batch.json` 内的 `words.count` |
| `domain/shared/re2.ts`     | Go `regexp`（RE2 语义）                         | 全局基础设施                    |
| `domain/shared/unicode.ts` | Go `unicode` / `utf8`                           | 全局基础设施                    |
| `domain/protect/**`        | `internal/protect/*.go`                         | `protect.json`                  |
| `domain/batch/**`          | `internal/pipeline/batch.go` + `batch_utils.go` | `batch.json`                    |
| `domain/repair/**`         | `internal/repair/*.go`                          | `repair.json`                   |
| `domain/ruby/**`           | `internal/ruby/*.go`                            | `ruby.json`                     |
| `domain/markup/**`         | `internal/markup/fragment.go`                   | `markup.json`                   |
| `domain/correct/**`        | `internal/correct/*.go`                         | `correct.json`                  |
| `domain/glossary/**`       | `internal/glossary/*.go`                        | `glossary.json`                 |
| `domain/tm/**`             | `internal/tm/*.go`                              | `tm.json`                       |
| `domain/script/**`         | `internal/script/*.go`                          | `script.json`                   |
| `domain/qa/**`             | `internal/qa/*.go`                              | `qa.json`                       |
| `domain/prompt/**`         | `internal/prompt/*.go` + `internal/templates`   | `prompt.json` + `seeds.ts`      |

### 6.1 Go `text/template` 兼容引擎

`domain/prompt/template/` 是 Go 标准库 `text/template` 的 TypeScript 移植，
用于渲染后端内置的提示词模板（`internal/templates/default/prompts/*.tmpl`）。

已用 Go 1.27 实测确认的关键语义：

| 语义                    | Go                                                | 本移植                     |
| ----------------------- | ------------------------------------------------- | -------------------------- |
| `{{-` 左裁剪            | `-` 之后必须是空白；裁掉前段尾部空白              | 同                         |
| `-}}` 右裁剪            | `-` 必须紧邻 `}}`，且其前是空白；裁掉后段头部空白 | 同                         |
| 空白集合                | `unicode.IsSpace`（含 `\v`，不含 U+FEFF）         | 同（`shared/unicode.ts`）  |
| 变量声明 `{{$x := .Y}}` | 不产生输出                                        | 同                         |
| 零参方法 `{{.HasRuby}}` | 自动调用                                          | 同（函数属性）             |
| 缺失字段                | 渲染报错                                          | 同                         |
| `%v` 浮点               | `1e+06` 形式（Go `%g` 最短规则）                  | 同（`template/format.ts`） |

### 6.2 内置种子数据

`domain/prompt/seeds.ts` 由 `backend/cmd/promptseed` **从后端生成**，
内容与 `internal/templates` / `internal/prompt` 逐字节一致，
供 Phase 2 初始化 IndexedDB 的「内置提示词模板」与「内置执行策略」。

重新生成：

```bash
cd backend && go run ./cmd/promptseed -out ../frontend/src/domain/prompt/seeds.ts
```

### 6.3 黄金向量一键重新生成

```bash
bash scripts/gen-golden-vectors.sh          # 全部
bash scripts/gen-golden-vectors.sh protect  # 指定包
```

## 7. 验证命令

```bash
cd frontend
TMPDIR=/data/dsh/home/workspace/projects/linguaflow/.tooling/tmp/node npx vitest run
TMPDIR=/data/dsh/home/workspace/projects/linguaflow/.tooling/tmp/node npx vue-tsc --build
```

> `TMPDIR` 必须覆盖：宿主 `/tmp` 是 256M tmpfs 且已满，Vite 的 SSR 临时目录会写失败。

后端：

```bash
cd backend
source ../.tooling/goenv.sh
go test ./... 2>&1 | tail -40
```
