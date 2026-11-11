# LinguaFlow 浏览器优先架构迁移 — Phase 1 交付报告

> 范围：**领域层（Domain）纯 TS 移植**、**黄金测试向量对齐**、**Gateway 无缝接缝落地**。
> 上游依据：《Phase 0 源码审计与迁移蓝图》（`plans/browser-first-phase-0-audit.md`）。

---

## 一、前置架构修正的执行情况

### 修正 #1：Gateway 接缝下沉到 `src/api/` 层（Store 与组件 100% 零改动）

**已执行。** 未修改任何 Pinia Store 与 Vue 组件的 import 路径。

接缝落在 3 个位置，全部在 `src/api/`（及 1 个 composable 的内部实现）：

| 接缝 | 文件 | 机制 |
|---|---|---|
| REST 全量 | `frontend/src/api/client-core.ts` | `apiClient` 代理在派发 `GET/POST/PUT/DELETE/PATCH` 时先询问当前网关；网关不接管（返回 `null`）时**原样**回落到 openapi-fetch |
| 文件上传 | `frontend/src/api/projects.ts` | `uploadProjectResourcesWithProgress` 在既有 raw XHR 之前询问网关；未接管时走原路径 |
| 事件流（SSE） | `frontend/src/composables/sseShared.ts` | `resolveStreamUrl` 在网关不支持事件流时返回 `null`（`globalJobTracker` 既有逻辑自动跳过），不改动 Store |

新增 `frontend/src/gateway/`：

```
frontend/src/gateway/
├── index.ts            # getGateway() / setGatewayMode() / dispatchRequest() …
├── contracts/
│   ├── index.ts        # 统一网关契约（形状刻意模仿 openapi-fetch 的 {data,error,response}）
│   └── mode.ts         # 运行模式定义：'local' | 'server' | 'browser-local'
├── remote/index.ts     # RemoteGateway：不接管任何通道 → 零回归
└── local/index.ts      # LocalGateway：/ping、/mode、/auth/capabilities 本地直接应答
```

### 修正 #2：扫清附录 B 的 3 个核心盲区

见 §四（附录 B 第 1 / 2 / 4 项核查结果）。

### 修正 #3：严格对齐 Go `rune` / `byte` 与 JS UTF-16 字符串语义

**已执行。** 语义差异集中在 `frontend/src/domain/shared/unicode.ts` 单一收口：

| Go | TS | 说明 |
|---|---|---|
| `for _, r := range s`（rune 迭代） | `for (const ch of text)` | JS 字符串迭代按码点，代理对自动合并 |
| `len(s)`（UTF-8 字节） | `utf8Length(text)` | 纯 TS UTF-8 编码器 |
| `utf8.RuneCountInString(s)` | `runeCount(text)` | |
| `string([]rune(s)[:n])` | `sliceRunes(text, 0, n)` | 按码点切片，**不是** `text.slice(0, n)` |
| `unicode.IsLetter` | `isLetter` | `= \p{L}` |
| `unicode.IsDigit` | `isDigit` | `= \p{Nd}`（**不是** `\p{N}`） |
| `unicode.IsSpace` | `isSpace` | 显式实现 Go 的 `White_Space` 集合；**JS `\s` 多含 U+FEFF，不等价** |
| `unicode.Han` / `Hiragana` / `Katakana` / `Hangul` | `isCJK` | `\p{Script=…}` |

移植过程中逐处核对了 Go 源码的索引口径：

- `protect`：占位符 key 全 ASCII，`restoreAll` 的 key 长度排序用 `utf8Length`（与 Go 的字节长度一致）。
- `ruby`：`Extract` / `RestoreItems` / `ApplyOutput` 的偏移在 TS 侧统一为 **UTF-16 code unit**，切片坐标系与 Go 的字节切片在同一字符串上完成，截出的子串逐字节相同；「单个 rune」判定改用码点计数。
- `qa`：`LocateSpan` 按 Go 源码口径实现（码点语义），见 §五对照表备注。
- `batch_utils.CountWords`：按码点迭代，CJK 每字符 1 词；`ExpandBatchWithContext` 的 rune 截断用 `sliceRunes`。
- `repair/json.go`：字节级手术全部按**字节**坐标实现（`domain/repair/strings.ts` 提供 `sliceUtf8Bytes` / `decodeUtf8Lossy`）。

### 修正 #4：正则引擎对齐（RE2）

**已执行。** 全部 Go 正则经 `frontend/src/domain/shared/re2.ts` 编译，底层用前端已安装的 `re2js@2.8.6`（Go `regexp` 的 JS 移植，DFA/NFA 线性时间，无 ReDoS）。

实测确认并已规避的差异（`re2js` 全部按 RE2 语义实现，故直接对齐）：

| 语义 | Go RE2 | JS 原生 `RegExp`（**未使用**） |
|---|---|---|
| `\s` | `[\t\n\f\r ]` | 含 `\v`、NBSP、全角空格、U+FEFF |
| `(?m)^` / `(?m)$` | 只认 `\n` | 还认 `\r` / `\u2028` / `\u2029` |
| `\w` | `[0-9A-Za-z_]` | `u` 标志下多含 Unicode 字母 |
| 匹配语义 | leftmost-first | leftmost-first（一致） |

`re2js` 的偏移量单位是 **UTF-16 code unit**（Go 是 UTF-8 字节），本移植在同坐标系内切片，截出子串一致；凡需字节语义处显式用 `utf8Length`。

---

## 二、黄金测试向量机制（Task 1）

### 2.1 机制

```
Go 生产代码 ──(backend/internal/<pkg>/golden_vectors_test.go)──> frontend/src/domain/__fixtures__/<pkg>.json
                                                                          │
                                                          frontend/src/domain/__tests__/<pkg>.golden.test.ts
                                                                          │
                                                                    100% 深相等断言
```

- **不侵入生产代码**：导出器一律是 `*_test.go`；未设置 `LINGUAFLOW_GOLDEN_OUT` 时 `t.Skip`，常规 `go test ./...` 无任何副作用。
- **期望值来自真实输出**：`Expect` 字段全部由 Go 生产代码计算得出，不是人工誊写。
- **确定性输出**：`goldenv.Write` 按用例 ID 排序；`encoding/json` 对 map key 字典序排序，故输出稳定可 diff。
- **nil / 空归一化**：Go 的 nil slice / nil map 序列化后是 `null`，导出器统一归一为 `[]` / `{}`（TS 侧用空容器表达「无结果」）；语义上表示「无」的字段（如 `Analysis.Mapping`）保持 `null`。

公共设施：`backend/internal/goldenv/goldenv.go`（`Case` / `Fixture` / `Write` / `Args` / `Expect`）。

### 2.2 一键重新生成

```bash
bash scripts/gen-golden-vectors.sh            # 全部
bash scripts/gen-golden-vectors.sh protect    # 指定包
```

### 2.3 用例数量

| 黄金向量文件 | 用例数 | 操作（Op）数 |
|---|---|---|
| `hash.json` | 17 | 1 |
| `protect.json` | 81 | 16 |
| `batch.json` | 69 | 8 |
| `repair.json` | 179 | 19 |
| `ruby.json` | 133 | 23 |
| `markup.json` | 76 | 3 |
| `correct.json` | 74 | 4 |
| `glossary.json` | 114 | 9 |
| `tm.json` | 40 | 5 |
| `script.json` | 98 | 5 |
| `qa.json` | 424 | 47 |
| `prompt.json` | 49 | 13 |
| **合计** | **1,354** | |

---

## 三、Go 源码 ↔ TS `domain/` 模块勾稽对照表

| Go 源文件 | Go 行数 | TS 模块 | TS 行数 | 黄金向量 |
|---|---|---|---|---|
| `internal/hash/hash.go` | 19 | `domain/shared/hash.ts` | 150 | `hash.json`（17） |
| `internal/pipeline/batch_utils.go`（`CountWords`） | 222 | `domain/shared/words.ts` | 72 | `batch.json`（`words.count`） |
| — | — | `domain/shared/unicode.ts` | 150 | 基础设施（rune/byte 对齐） |
| — | — | `domain/shared/re2.ts` | 210 | 基础设施（RE2 对齐） |
| — | — | `domain/shared/result.ts` / `clock.ts` | 78 / 41 | 基础设施 |
| `internal/protect/protect.go` | 200 | `domain/protect/protect.ts` + `core.ts` | 100 / 119 | `protect.json` |
| `internal/protect/placeholder.go` | 41 | `domain/protect/placeholder.ts` | 50 | `protect.json` |
| `internal/protect/code.go` | 40 | `domain/protect/code.ts` | 44 | `protect.json` |
| `internal/protect/link.go` | 58 | `domain/protect/link.ts` | 66 | `protect.json` |
| `internal/protect/xml.go` | 28 | `domain/protect/xml.ts` | 31 | `protect.json` |
| `internal/protect/ruby_adapter.go` | 36 | `domain/protect/ruby_adapter.ts` | 36 | `protect.json` |
| `internal/protect/integrity.go` | 54 | `domain/protect/integrity.ts` | 87 | `protect.json` |
| `internal/protect/structural.go` | 130 | `domain/protect/structural.ts` | 123 | `protect.json` |
| `internal/pipeline/batch.go` | 176 | `domain/batch/batch.ts` | 258 | `batch.json` |
| `internal/pipeline/batch_utils.go`（批次/上下文） | 222 | `domain/batch/context.ts` | 216 | `batch.json` |
| `internal/pipeline/context.go` | 19 | `domain/batch/types.ts` + `context.ts` | 47 | `batch.json` |
| `internal/repair/repair.go` / `json.go` / `text.go` 等 11 个文件 | 2,187 | `domain/repair/**` | 4,453 | `repair.json`（179） |
| `internal/ruby/extractor.go` / `item.go` / `restorer.go` / `alignment*.go` | 2,039 | `domain/ruby/**` | 2,438 | `ruby.json`（133） |
| `internal/markup/fragment.go` | 132 | `domain/markup/fragment.ts` | 497 | `markup.json`（76） |
| `internal/correct/*.go` | 616 | `domain/correct/**` | 799 | `correct.json`（74） |
| `internal/glossary/*.go` | 586 | `domain/glossary/**` | 957 | `glossary.json`（112） |
| `internal/tm/*.go` | 165 | `domain/tm/**` | 373 | `tm.json`（40） |
| `internal/script/*.go` | 592 | `domain/script/**` | 747 | `script.json`（98） |
| `internal/qa/*.go` | 3,447 | `domain/qa/**` | 4,569 | `qa.json`（424） |
| `internal/prompt/*.go` | 1,660 | `domain/prompt/**`（含 `template/`） | 3,999 | `prompt.json`（49） |
| `internal/templates/templates.go` + `default/**` | 271 + 38 KB | `domain/prompt/seeds.ts` | 716 | 生成器 `backend/cmd/promptseed` |

---

## 四、附录 B 第 1 / 2 / 4 项核查结果

### 第 1 项：`prompt/` 模板渲染语法逐行（1,660L）

**结论：Go 侧用的是标准库 `text/template`，本阶段已 1:1 移植为 TypeScript 兼容引擎。**

核查明细：

| 项 | 结论 |
|---|---|
| 渲染引擎 | Go `text/template`（`prompt.go` / `bootstrap.go` / `prune.go` / `revise.go` / `adjudication.go` / `semantic_qa.go` 共 6 个渲染器，全部 `template.New(...).Funcs(...).Parse(...)` + `Execute`） |
| 使用的模板语法 | `{{.Field}}`、`{{if}}` / `{{else if}}` / `{{else}}` / `{{end}}`、`{{range}}`（含 `{{range $i, $v :=}}`）、`{{with}}`、`{{$x :=}}` / `{{$x =}}`、管道 `{{a | b}}`、`{{printf "%q" .X}}` / `{{printf "%.2f" .X}}`、`{{eq}}` / `{{ne}}` / `{{lt}}` / `{{le}} / {{gt}} / {{ge}}`、`{{and}}` / `{{or}}` / `{{not}}`、`{{len}}` / `{{index}}`、括号表达式 `(pipeline)`、注释 `{{/* … */}}` |
| 自定义函数 | 仅 1 个：`mul`（`templateFuncs`，`float32 × int → float64`）；见 `domain/prompt/prompt.ts` 的 `TEMPLATE_FUNCS` |
| 变量注入规则 | 模板视图字段名**沿用 Go 结构体名**（`SourceLang` / `TargetLang` / `Protocol` / `Glossary` / `TMHints` / `InlineBootstrap` / `MaxBootstrapTerms` / `RubyAnnotations` / `RubyMode`）；`HasRuby` 是 Go 的**零参方法**，TS 侧以函数属性提供并在模板引擎里自动调用 |
| 数据来源 | `Data.Vars map[string]any`（模板可访问的全局变量） |
| user 消息构造 | **不走模板**：JSON 协议用 `json.Marshal(userEnvelope)`，text 协议用 `strings.Builder` 手写（`[id] 原文` / `[*] 原文` / `[ruby]` 段落 / `⟦ruby:base/text⟧` 内联） |
| 协议三态 | `text` / `json_loose` / `json_strict`，由 `ProtocolFromResponseMode(response_format)` 推导；未知值按 `json_loose` |
| JSON 字节一致性 | Go `json.Marshal` 对 **struct 保留字段声明顺序**、对 **map 的 key 排序**、字符串做 **HTML 安全转义**（`<`→`\u003c`）。TS 侧 `domain/prompt/json.ts` 显式区分 struct / map 并复刻该语义 |

移植产物：`domain/prompt/template/`（`types.ts` / `parser.ts` / `exec.ts` / `format.ts`），共 1,559 行。

**关键语义（Go 1.27 实测确认，TS 侧逐条对齐）**：

| 语义 | Go 实测 | TS 实现 |
|---|---|---|
| `{{-` 左裁剪 | `-` 之后**必须**是空白，否则解析错误（`{{-.X}}` → `bad number syntax`） | 同 |
| `-}}` 右裁剪 | `-` 必须**紧邻** `}}` 且其前是空白，否则解析错误 | 同 |
| 裁剪的空白集合 | `unicode.IsSpace`（含 `\v`，**不含** U+FEFF） | 同 |
| `{{$x := .Y}}` | 不产生输出 | 同 |
| `{{.HasRuby}}` | 自动调用零参方法 | 同 |
| 缺失字段 | 渲染报错 `can't evaluate field X in type struct` | 同 |
| `{{.Score}}`（float32 0.5） | `0.5` | 同 |
| `{{printf "%.2f" .Score}}` | `0.50` | 同 |
| `{{1000000.0}}`（`%v`） | `1e+06`（Go `%g` 最短规则） | 同（`format.ts` 复刻 `strconv.FormatFloat(v,'g',-1,64)`） |

**验证方式**：用**后端真实内置模板**（`internal/templates/default/prompts/*.tmpl`，逐字节导入到 `domain/prompt/seeds.ts`）渲染 10 组数据，`system` 与 `user` 两个字段与 Go 输出**逐字节相等**（`prompt.json` 的 `prompt.render` 用例）。

### 第 2 项：`internal/hash.Full` 哈希算法细节

**结论：SHA-256，输出小写十六进制。**

`backend/internal/hash/hash.go` 全文 19 行：

```go
func Short(s string) string { sum := sha256.Sum256([]byte(s)); return hex.EncodeToString(sum[:6]) }
func Full(s string) string  { sum := sha256.Sum256([]byte(s)); return hex.EncodeToString(sum[:]) }
```

- 算法：**SHA-256**（`crypto/sha256`），输入为字符串的 **UTF-8 字节**；
- `Short`：取摘要**前 6 字节**（48 bit）→ **12 个小写十六进制字符**；
- `Full`：完整 32 字节 → **64 个小写十六进制字符**；
- 用途：Segment ID（基于 `Source`）与翻译记忆的 `source_hash`。

TS 实现：`domain/shared/hash.ts` —— **纯 TypeScript 的 SHA-256**（不依赖 `crypto.subtle`：其仅在安全上下文可用且是**异步** API，与 Go 的同步语义不符；领域层也要求零平台依赖）。

17 条黄金向量（空串、ASCII、中文、混排、Emoji 代理对、CJK 扩展 B、CRLF、制表符、`__LF_000001__`、阿拉伯语、俄语等）全部与 Go 逐字节一致。

### 第 4 项：`internal/templates` 内置提示词 / 策略的种子写库时机

**结论：内置实体是「负数虚拟 ID」的只读种子，写库时机由前端 Phase 2 的 IndexedDB 初始化承担。**

核查明细：

| 项 | 结论 |
|---|---|
| 内置实体 | 4 类：翻译提示词模板、术语抽取提示词模板、术语精简提示词模板、执行策略。ID 全部为 `-1`（`IsBuiltinID(id) = id < 0`） |
| 元数据来源 | 嵌入 FS 的 `default/catalog.yaml`（`name` / `description` / `id`） |
| 模板内容来源 | 嵌入 FS 的 `default/prompts/default_{translation,bootstrap,prune,adjudication,semantic_qa,revise}.tmpl`，读取后 `TrimRight("\n")` |
| 执行策略来源 | `execution.DefaultProfile()`（`default/profiles/default.yaml` 与之同源） |
| 作用域 | 全部 `Scope: "system"`（用户不可见 / 不可改） |
| 写库时机（现状） | Go 侧：模板与策略是**进程内虚拟实体**，按需从嵌入 FS 构造后直接返回，**从不落库**；落库的只有用户自建的副本 |
| 写库时机（Phase 1 交付） | 导出为前端可用的**静态 Seed 配置** `domain/prompt/seeds.ts`（由 `backend/cmd/promptseed` 从后端生成，内容逐字节一致），供 Phase 2 在 IndexedDB 初始化时写入「内置提示词模板」与「内置执行策略」两类种子数据 |
| Ruby 对齐模板 | `internal/prompt/ruby_templates.go` 的 6 个常量（legacy JSON/Text、v2 JSON/Text、batch JSON/Text）同样导出为种子数据 |

生成器：`backend/cmd/promptseed/main.go`

```bash
cd backend && go run ./cmd/promptseed -out ../frontend/src/domain/prompt/seeds.ts
```

---

## 五、新增文件清单与行数统计

### 5.1 后端（测试基础设施 + 生成器，**零生产代码改动**）

| 文件 | 行数 | 说明 |
|---|---|---|
| `backend/internal/goldenv/goldenv.go` | 104 | 黄金向量公共设施（`Case` / `Fixture` / `Write` / `Args` / `Expect`） |
| `backend/cmd/promptseed/main.go` | 160 | 内置种子配置生成器（从 `internal/templates` + `internal/prompt` 导出 TS） |
| `backend/internal/hash/golden_vectors_test.go` | 75 | |
| `backend/internal/protect/golden_vectors_test.go` | 517 | |
| `backend/internal/pipeline/golden_vectors_test.go` | 440 | |
| `backend/internal/repair/golden_vectors_test.go` | 840 | |
| `backend/internal/ruby/golden_vectors_test.go` | 890 | |
| `backend/internal/markup/golden_vectors_test.go` | 145 | |
| `backend/internal/correct/golden_vectors_test.go` | 350 | |
| `backend/internal/glossary/golden_vectors_test.go` | 774 | |
| `backend/internal/tm/golden_vectors_test.go` | 513 | |
| `backend/internal/script/golden_vectors_test.go` | 234 | |
| `backend/internal/qa/golden_vectors_test.go` | 1,725 | |
| `backend/internal/prompt/golden_vectors_test.go` | 615 | |
| **合计** | **7,382** | **零生产代码改动**（全部为 `_test.go` + 1 个独立 cmd 工具） |

### 5.2 前端 —— 领域层 `frontend/src/domain/`

| 子目录 | TS 行数（不含测试） |
|---|---|
| `shared/` | 712 |
| `protect/` | 703 |
| `batch/` | 527 |
| `repair/` | 4,453 |
| `ruby/` | 2,438 |
| `markup/` | 501 |
| `correct/` | 799 |
| `glossary/` | 957 |
| `tm/` | 373 |
| `script/` | 747 |
| `qa/` | 4,569 |
| `prompt/` | 3,999 |
| **小计（生产代码）** | **20,921** |
| 黄金向量对拍测试（`__tests__/**`） | 2,705 |
| **合计** | **23,626** |

### 5.3 前端 —— 网关层 `frontend/src/gateway/`

| 文件 | 行数 |
|---|---|
| `gateway/index.ts` | 94 |
| `gateway/contracts/index.ts` | 124 |
| `gateway/contracts/mode.ts` | 40 |
| `gateway/local/index.ts` | 113 |
| `gateway/remote/index.ts` | 42 |
| `gateway/__tests__/gateway.test.ts` | 140 |
| `src/api/__tests__/gateway-seam.test.ts`（接缝断言） | 85 |
| **小计** | **638** |

### 5.4 前端 —— 对 `src/api/` 的接缝改动（**不改变既有调用形状**）

| 文件 | 改动 |
|---|---|
| `src/api/client-core.ts` | `apiClient` 代理增加网关分发；新增 `HTTP_METHODS` 常量 |
| `src/api/bootstrap-service.ts` | `ServiceMode` 扩展为含 `'browser-local'`；新增浏览器本地能力探测与模式切换；`resolveBootstrapService` 同步网关模式 |
| `src/api/system.ts` | `fetchMode` 成功后同步网关模式 |
| `src/api/projects.ts` | 上传通道增加网关分发（未接管即回落既有 raw XHR） |
| `src/api/auth-contract.ts` | `isAuthCapabilities` 接受 `'browser-local'` |
| `src/api/browser-local-preference.ts` | **新增**：浏览器本地模式的显式偏好存储 |
| `src/composables/sseShared.ts` | `resolveStreamUrl` 在网关不支持事件流时返回 `null` |

### 5.5 脚本与文档

| 文件 | 说明 |
|---|---|
| `scripts/gen-golden-vectors.sh`（74 行） | 黄金向量一键重新生成 |
| `.tooling/goenv.sh`（15 行） | Go 工具链环境（含 `TMPDIR` 覆盖，规避宿主 `/tmp` 已满） |
| `frontend/src/domain/README.md` | 领域层移植规范（命名映射 / 黄金向量流程 / RE2 与 rune 对齐 / 验证命令） |
| `plans/phase1-domain-port-report.md` | 本报告 |

---

## 六、验证证据

全部验证日志（真实终端输出）存档于 `plans/phase1-verification/`：

| 日志 | 结果 | 说明 |
|---|---|---|
| `vitest-full.log` | **exit 0** — `Test Files 100 passed (100)` / `Tests 1415 passed (1415)` | 前端全量 Vitest（含 12 份黄金向量对拍、gateway 接缝、既有 85 个测试文件零回归） |
| `type-check.log` | **exit 0**（`vue-tsc --build` 无任何输出） | 等价 `pnpm type-check` |
| `go-domain-tests.log` | **exit 0** — 12 个领域包全部 `ok` | hash / protect / repair / ruby / markup / correct / glossary / tm / script / qa / prompt / pipeline |
| `go-full-tests.log` | **exit 0** — 61 个包全部 `ok`、0 FAIL | 后端全量 `go test ./...`（Go 1.27.3） |
| `go-golden-regen.log` | 12 份 fixture 重新生成后与提交版本 **逐字节一致**（`diff -q` 无输出） | 黄金向量可复现性证明 |
| `seed-regen.log` | `promptseed` 重新导出的 `seeds.ts` 与提交版本逐字节一致（46,996 字节） | 种子数据可复现性证明 |

### 6.1 关键终端输出

```
$ cd frontend && pnpm type-check
> frontend@0.0.0 type-check
> vue-tsc --build
（无任何输出，exit 0）
```

```
$ cd frontend && npx vitest run
 Test Files  100 passed (100)
      Tests  1415 passed (1415)
```

```
$ cd backend && go test ./...
（61 个包全部 ok，0 FAIL，exit 0）
```

### 6.2 关键对拍口径

黄金向量期望值**全部由 Go 生产代码**（Go 1.27.3 实测）计算得出；
TS 侧通过 `runGolden` 做 **100% 深相等断言**：

| 对拍文件 | 用例数 | 覆盖的 Go 能力 |
|---|---|---|
| `hash.json` | 17 | `hash.Short` / `hash.Full`（SHA-256 字节级） |
| `protect.json` | 81 | 5 个子保护器 + `mergeAdjacent` + 字面量碰撞 fail-closed + `PlaceholderViolations` + `AnalyzeStructural` + `ProtectText` / `RestoreText` |
| `batch.json` | 69 | `CountWords` + 3 种批次切分 + `ExpandBatchWithContext` + O(1) 前缀和 + `shrinkConstraint` |
| `repair.json` | 179 | `TryRepair` + `json.go` 全部字节级手术 + `text.go` 三段协议 + bootstrap 修复 + 重试提醒渲染 |
| `ruby.json` | 133 | `Extract` / `RestoreItems` / `ParseInlineMarkers` / `ApplyOutput` 状态机 / `MergeByOutput` |
| `markup.json` | 76 | `ValidateFragment` + `TargetRegression` 三重门 |
| `correct.json` | 74 | 3 条白名单纠错规则 + `Apply` 短路 |
| `glossary.json` | 114 | CSV 解析（19 类边界）+ 长词优先 `Lookup` + `Add` + `Save` + `SafeReplace` |
| `tm.json` | 40 | 精确匹配 + 排序 + `source_hash`（`hash.Full`） |
| `script.json` | 98 | 生成字表 + `Profile.Scan` + 变体判定 |
| `qa.json` | 424 | 19 个独立 checker（254 条）+ `LocateSpan` + 保护区 + `Fingerprint` / `ReconcileIssues` + code 词表 + 序列化 |
| `prompt.json` | 49 | **用后端真实内置模板**渲染的 `system` + `user`（JSON / text 双协议）+ 6 个渲染器 + 4 个响应解析器 |
| **合计** | **1,354** | |

---

## 七、遗留与下一阶段

| 项 | 说明 |
|---|---|
| `LocalGateway` 覆盖面 | Phase 1 仅直接应答 `/ping`、`/mode`、`/auth/capabilities`；其余端点回落远端实现（**不产生假成功**）。Phase 2 接入 IndexedDB / OPFS / Worker 后再接管 |
| 上传 / 事件流通道 | 同样回落既有实现；Phase 2 的 OPFS 写入流与 BroadcastChannel 事件总线落地后再接管 |
| `domain/qa` 的 `IssueCode` 语义码清单 | `prompt` 侧以常量副本提供（`SEMANTIC_QA_CODES` / `ADJUDICABLE_CODES`），Phase 2 引入 `domain/qa` 后改为直接引用 |
| 后端 `internal/pipeline` 的其余 9,136 行 | 本阶段只移植了批次切分与上下文窗口（`batch.go` / `batch_utils.go` / `context.go`）；轮次执行器、断点、暂停/恢复等属 Phase 2 的 `application/job-engine` |
