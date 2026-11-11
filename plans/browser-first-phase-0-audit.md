# LinguaFlow Browser-first / Local-first 架构迁移

## Phase 0 源码审计与迁移蓝图

> **审计基线**：仓库 `/data/dsh/home/workspace/projects/linguaflow`
> **前端**：Vue 3.5 + Pinia 4 + naive-ui + openapi-fetch + vue-router（文件路由）+ Vite 8
> **后端**：Go 1.26 + ent v0.14.6 + chi v5 + SQLite(modernc)/PostgreSQL(pgx) + oapi-codegen
> **审计方式**：三方并行只读审计（前端域 / 后端引擎域 / 服务·数据域）+ 11 组关键文件人工复核
> **约束**：本阶段未修改任何业务代码、配置、路由或数据库结构；全部结论精确到 `文件:行号`，未逐行展开处标注【需人工复核】

---

## 目录

1. [现有架构全景图与目录解析](#1-现有架构全景图与目录解析)
2. [前后端 API 与 Pinia Store 全量映射表](#2-前后端-api-与-pinia-store-全量映射表)
3. [核心翻译算法与任务引擎源码定位清单](#3-核心翻译算法与任务引擎源码定位清单)
4. [目标前端分层目录设计](#4-目标前端分层目录设计)
5. [IndexedDB (Dexie) + OPFS 存储 Schema 设计草案](#5-indexeddb-dexie--opfs-存储-schema-设计草案)
6. [浏览器兼容性、CORS、大文件内存与多标签页并发风险清单](#6-浏览器兼容性cors大文件内存与多标签页并发风险清单)
7. [功能分类矩阵（A/B/C）](#7-功能分类矩阵abc)
8. [Phase 1~6 执行路线图与 Golden Test Vectors 验收计划](#8-phase-16-执行路线图与-golden-test-vectors-验收计划)
- [附录 A：完整端点清单](#附录-a完整端点清单)
- [附录 B：遗留待复核清单](#附录-b遗留待复核清单)

---

## 1. 现有架构全景图与目录解析

### 1.1 当前运行模式 = 「浏览器 ↔ 本地 Go 进程」瘦客户端

**审计 1 结论（本地模式机制盘点）**：今天所谓的「本地模式」**没有任何浏览器本地持久化**，它是一个本地启动的单用户 Go 后端。

| 环节 | 事实 | 源码证据 |
|---|---|---|
| 启动 | `linguaflow local`：单用户模式，默认 `127.0.0.1:18080`，非回环须 `--allow-network` | `backend/internal/cli/local.go:13-30`；`cli/bootstrap.go:159-195`（回环强制 + 10 端口重试） |
| 自动登录 | 启动时创建 `username="local"` + `role=admin` 用户；`resolveAuthUser` 短路免 token，所有受保护端点（含 admin）直通 | `service/initialization.go:78-83,121-149`；`api/server.go:96-108`；`api/auth.go:103-105` |
| 数据库 | local 强制 SQLite（`data_dir/linguaflow.db` + WAL），实例模式初始化后不可改 | `config/config.go:464`；`instance_initialization.go:19`（mode Immutable） |
| 模式探测 | 前端匿名探测同源 `GET /ping` + `GET /mode`；`DEFAULT_SERVICE_BASE_URL='/api/v1'`（同源相对路径），mode=local 直接采用 | `frontend/src/api/bootstrap-service.ts:8,30-82` |
| 前端 local 开关 | 模块级 `_isLocalMode`：请求头省略 Authorization、401 不做 token 轮换、登出只清 localStorage、SSE URL 不拼 `access_token` | `frontend/src/api/client-core.ts:48-52,262-265,304-307,375,391`；`composables/sseShared.ts:91-98` |
| UI 标识 | 顶栏 `NTag type="success"`「本地模式」徽标（`layout.localModeBadge`） | `frontend/src/layouts/AppLayout.vue:57-62,241-254`；`locales/zh-Hans.ts:255` |
| 路由守卫 | local：`/login` `/register` 重定向回源、`/service` 仅 `?force=1`、`/settings/team` 强制跳 `/settings/profile`、未登录非公开页自动放行 | `frontend/src/router/guards.ts:50-114`（:72,:75-89） |
| 打包/开发 | dev 代理 `/api → http://127.0.0.1:18080`；发布二进制把 `frontend/dist` 经 `go:embed` 嵌入 `backend/internal/web/dist` | `frontend/vite.config.ts:21,45-46`；`Taskfile.yml:100-116`；`backend/internal/web/embed.go:5-6`；`api/router.go:37-51` |
| CORS | local 模式白名单=自身端口回环来源；AllowCredentials=false | `backend/internal/api/middleware.go:15-45`（:25-30,:41） |

**演进缝（已存在、可直接复用的前端钩子）**

1. 匿名探测协议可扩展为「浏览器本地能力声明」（`bootstrap-service.ts:40-46`）。
2. `setLocalMode` 单开关贯穿的 3 处分支即未来 Gateway 切换点。
3. `TokenStorage` 接口已是可替换存储抽象（`api/token-storage.ts:6-10`）。
4. `session-core` 的 generation/scope（`baseUrl|userId`，`session-core.ts:36`）+ epoch 模型（`token-storage.ts:103-121`）+ 跨页签 `storage` 事件同步（`auth/cross-tab-session.ts:8-28`）可直接映射到 IndexedDB 隔离与多标签页协调。
5. **store 层已有 transport 注入缝**：`stores/storage.ts:82` `createStorageState(transport = api, ...)`、`stores/credentials.ts:44`、`stores/scopedEntity.ts:18-24`。
6. `sessionIsolation` 持久 store 白名单 `['auth','service','theme','locale']`（`stores/sessionIsolation.ts:8`）。

### 1.2 当前调用链全景

~~~mermaid
flowchart TB
  subgraph Browser["浏览器（Vue 3.5 SPA）"]
    UI["pages/*.vue（文件路由）+ components/*"] --> ST["Pinia Stores（30 个）<br/>service/auth/projects/resource/segment/job/<br/>glossary/operations/globalJobTracker/storage/admin/..."]
    ST --> API["api/*（openapi-fetch Client）<br/>client-core.ts 中间件：Bearer 注入 / 401 轮换<br/>setLocalMode 三分支"]
    ST -.->|"唯一 EventSource"| SSE["EventSource /jobs/{id}/stream<br/>+ REST /jobs/{id}/events 分页"]
    ST -.->|"自适应轮询 2s/3s/5s/10s"| POLL["operations.ts:817-862 协调器<br/>useJobPolling / runtime.ts 5s"]
    API --> XHR["raw XHR multipart 上传<br/>Idempotency-Key（projects.ts:327-412）"]
  end
  XHR -->|"/api/v1"| GW
  API -->|"/api/v1 同源"| GW

  subgraph Go["Go 后端（local/server 双模式）"]
    GW["chi Router /api/v1<br/>oapi-codegen + CORS + 认证中间件<br/>（local: resolveAuthUser 免 token 短路）"] --> SVC["service/*（37,405 行）<br/>job/resource/storage/glossary/auth/<br/>qa_recheck/quick_translate/operation_query"]
    SVC --> ENGINE["engine（1,253 行）<br/>buildRoundConfigs→buildPipelineRounds"]
    ENGINE --> PIPE["pipeline（9,136 行）<br/>RunRound 池推进 / RunStagedRound 候选流水线<br/>Translate/Extract/Adjudicate/SemanticQA/Revise/Correct Handler"]
    PIPE --> DOM["领域算法包<br/>protect 574 / qa 3,447 / repair 2,187 / ruby 2,039<br/>correct 616 / glossary 586 / tm 165 / markup 132<br/>prompt 1,660 / script 纯表 / parser 5,173"]
    PIPE --> PROV["backend/* Provider<br/>openai-go / anthropic-sdk-go / google genai<br/>Metered → RateLimited → PolicyBackend"]
    SVC --> WORKER["worker（5,461 行）<br/>Queue/Dispatcher/JobRunner/PreviewRunner"]
    WORKER --> WS["workstate（2,928 行）<br/>WorkItem/WorkCandidate/WorkRequest<br/>CAS checkpoint / Confirm 提交确认门"]
    WORKER --> PROG["progress/db_reporter<br/>checkpoint 缓冲 + event broker(SSE)"]
    SVC --> STORE["storage 子系统<br/>local 磁盘 driver / S3<br/>Blob+BlobLocation 生命周期"]
  end
  PROG -->|"SSE 回放(Last-Event-ID)+ring"| SSE
  PROV -->|HTTPS| LLM["OpenAI / Anthropic / Gemini<br/>（服务端出站，无代理层）"]
  STORE --> FS["objects/<space>/<project>/<uuid><br/>（service/storage.go:502）"]
~~~

### 1.3 目标分层架构

~~~mermaid
flowchart LR
  subgraph Local["浏览器本地优先"]
    U["源文件 EPUB/MD/DOCX/字幕"] -->|OPFS 原始文件| W["Web Worker 引擎<br/>parser→protect→batch→AI→校验→还原→QA"]
    W <-->|checkpoint| IDB[("IndexedDB (Dexie)<br/>projects/resources/segments/<br/>glossary/jobs/checkpoints/templates")]
    W -->|"fetch 直连（CORS 允许时）"| AI2["AI Provider<br/>+ 可选自定义反代 URL"]
    W <--> BC["BroadcastChannel 进度广播<br/>Web Locks 单实例执行锁"]
    UI2["Vue 页面组件（零改动）"] --> STORES2["Pinia Store（契约不变）"] --> GW["Application Gateway<br/>LocalRepository ⇄ CloudAdapter"]
    GW --> IDB
    GW -.->|可选云端模式| CLOUD["后端 REST/SSE + Cloud Sync"]
  end
~~~

### 1.4 目录解析

| 位置 | 内容 | 体量 |
|---|---|---|
| `frontend/src/api/`（23 模块 + types.d.ts 13,754L） | openapi-fetch 客户端、token/session 基座 | 18,970L |
| `frontend/src/stores/`（30 文件） | Pinia 状态层，8,566L，最大 `storage.ts` 1,171L | 8,566L |
| `frontend/src/composables/`（30+） | 业务会话（上传/替换/预览/守卫）、轮询 | — |
| `frontend/src/pages/` | 文件路由（`/admin/*`、`/settings/*`、`/tools/epub-rotate` 等） | — |
| `backend/internal/api/` | oapi-codegen 生成 + handler + 中间件 | 35,162L |
| `backend/internal/service/` | 领域服务（`job.go` 2,137L 最大） | 37,405L |
| `backend/internal/pipeline|engine|worker|workstate|progress` | 执行引擎与检查点 | ≈21,500L |
| `backend/internal/protect|qa|repair|ruby|correct|glossary|tm|markup|script|prompt` | **纯计算领域包（可 1:1 移植 ≈1.2 万行）** | ≈11,000L |
| `backend/internal/parser/` | 10 格式解析器 | 5,173L |
| `backend/internal/ent/schema/`（62 Schema） | 数据模型源 | 2,937L |

---

## 2. 前后端 API 与 Pinia Store 全量映射表

### 2.1 Store → API → Endpoint 映射总表

> 路径前缀均为 `/api/v1`。完整端点清单见 [附录 A](#附录-a完整端点清单)。

| # | Store（行数） | API 模块 → 关键端点 | 本地化目标（Gateway 后） |
|---|---|---|---|
| 1 | `service.ts`(148) | bootstrap-service/system → `GET /ping`、`GET /mode` | LocalGateway 直接应答 mode=`browser-local` |
| 2 | `auth.ts`(243) | auth/account → `POST /auth/login`、`POST /auth/register`、`GET /users/me`、`PUT /users/me(/password)` | local 免登（现状）；云端模式走原路径 |
| 3 | `project.ts`(69) | projects.ts:136 `GET /projects/{id}` | IDB projects 表 |
| 4 | `projects.ts`(119) | projects.ts:118-190 `GET/POST/PUT/DELETE /projects`、`GET /orgs/{orgId}/projects`(:884-902) | IDB + 云同步标记 |
| 5 | `organizations.ts`(75) | organizations.ts `GET/POST/PUT /orgs*`、`GET /activity` | **C 类**（云端模式） |
| 6 | `backends.ts`(47) | backends.ts:23-71 `GET/POST/PUT/DELETE /backends*`、`POST /backends/models` | IDB backends 表 |
| 7 | `credentials.ts`(287) | credentials.ts:43-105 `/credentials*`（versions/revoke/collect） | IDB 密文保险库（WebCrypto） |
| 8-11 | 4 个模板 store（各 30L） | prompt/prune-prompt/bootstrap-prompt/execution-plan-templates CRUD | IDB templates 表 |
| 12 | `executionProfiles.ts`(30) | execution-profiles.ts CRUD | IDB execution_profiles |
| 13 | `glossary.ts`(723) | glossary.ts:26-245 `GET/POST/PUT/DELETE .../glossary`、`import/export`(multipart/blob)、`sync-impact/sync-execute`、`prune(/apply)`、sync-tasks | IDB glossary + Worker 抽取/精简/同步引擎 |
| 14 | `job.ts`(394) | jobs.ts:17-145 `GET/POST /projects/{id}/jobs`、`GET /jobs/{id}`、`cancel/retry/pause/resume`、`GET /jobs/{id}/events` | 本地 Job 表 + 引擎事件总线 |
| 15 | `operations.ts`(967) | operations.ts:41-52 `GET /operations(/summary)` + 单任务发现（job/sync-task/storage-task 三类） | 本地任务注册表（广播订阅） |
| 16 | `globalJobTracker.ts`(432) | jobs.ts:142 + **SSE `/jobs/{id}/stream`**（唯一 EventSource :134-138） | BroadcastChannel + IndexedDB 事件表回放 |
| 17 | `storage.ts`(1171) | storage.ts:63-663 全量（连接/空间/配额/检查/迁移/源更新/导出/诊断，56 端点） | A 类（本地空间=OPFS）+ C 类（S3/云端） |
| 18 | `taskHistory.ts`(266) | task-history.ts:143-233 retention preview/status、`DELETE /jobs/{id}`、`POST /operations/batch-delete` | IDB 清理（本地）；保留策略 C 类 |
| 19 | `taskMutations.ts`(47) | 无 HTTP（前端互斥） | 原样保留 |
| 20 | `stats.ts`(151) | projects.ts:109 `GET /stats/summary`、misc.ts:11 `GET /activity` | 本地聚合（usage_records） |
| 21 | `runtime.ts`(128) | runtime.ts:13 `GET /admin/runtime/summary` 5s 轮询 | Worker 内存指标 |
| 22 | `resource.ts`(916) | projects.ts:205-478 树/列表/precheck/上传(XHR)/删除/download(2) | OPFS + IDB resources |
| 23 | `segment.ts`(828) | projects.ts:519-721 segments 窗口分页（cursor/anchor/desc、include_total、group_key）、PATCH、issues disposition、translation/revision preview(apply)、batch-review | IDB segments 窗口查询（索引齐全） |
| 24 | `projectWorkspace.ts`(524) | 纯门面（转发 + prepareStorageWrite 治理） | 原样保留 |
| 25 | `admin.ts`(408) | admin.ts:11-148 users/stats/audit-logs/settings | **C 类为主**（local 下自动 admin 直通，见 §7） |
| 26 | `preferences/locale/theme/sessionIsolation` | 本地存储（localStorage/scoped-preferences） | 原样保留（可迁 IDB meta） |

### 2.2 绕过 store 的直接 API 调用点（Gateway 必须覆盖的注入缝）

`useAuthCapabilities.ts:21`、`useTaskRetention.ts:5-9`、`useStorageTargets.ts:3`、`useProjectStorageSnapshot.ts:3`、`useSourceUpdateSession.ts:3,502-504`（已带 deps 注入）、`useSegmentReplaceSession.ts:5-13`、`useSegmentPreviewDrawer.ts:5-9`、`SegmentTranslationPreviewDrawer.vue:61`、`SegmentRevisionPreviewDrawer.vue:68`、`QaRecheckDrawer.vue:211`、`pages/projects/[projectId].vue:8,10`、`components/storage/*`（ProjectStoragePanel/ResourceStorageDrawer/SourceUpdateDrawer/repairSession/exportSession）、`pages/admin/storage.vue:17`、`pages/admin/authentication.vue:169-211`（含裸 `apiClient.GET('/admin/settings')`）、`LoginMethodsPanel.vue`、`pages/settings/team.vue:21`、`pages/settings/profile.vue:28`。

### 2.3 进度通道清单（迁移到浏览器后的替换方案）

| 现通道 | 机制（源码） | 本地替换 |
|---|---|---|
| Job 事件流 | EventSource `GET /jobs/{id}/stream`，Last-Event-ID 回放 + ring/DB 512 窗，5s keepalive | `BroadcastChannel('linguaflow.jobs')` + IDB `job_events` 表（seq 回放） |
| Job 事件历史 | REST `GET /jobs/{id}/events` before/after_seq 分页 50 | IDB 查询 |
| 全任务协调轮询 | `operations.ts:817-862`（running 3s / pending 5s / idle 10s，指数退避 ≤10s） | 本地引擎直推 + `visibilitychange` 重同步 |
| 项目任务列表 | `useJobPolling.ts:28-73`（2s/5s/15s） | 同上 |
| Runtime 摘要 | `runtime.ts:10` 5s | Worker 内指标内存直读 |
| 上传进度 | XHR `upload.onprogress`（projects.ts:369-379） | OPFS 写入流进度 |

### 2.4 数据量事实（影响本地化设计）

- **已窗口化的读路径**：segments（cursor + anchor + desc 上翻，`segment.ts:206-416`）、jobs（50/页）、job events（seq 分页）、operations/activity（cursor）。
- **未分页、迁移时需注意体积**：projects 列表、resource tree（`projects.ts:484` 整树一次性）、glossary（`glossary.ts:26-33` 全量）、storage 连接/空间/检查、admin users(100)/audit-logs(50)。
- **前端当前零本地数据层**：无 IndexedDB、无离线队列、无乐观写回；浏览器持久化仅 localStorage（token-storage 全部键 + theme + scoped-preferences）。
- **写路径幂等键已规范化**：上传 XHR `Idempotency-Key`（projects.ts:335-387）、export/source_update `crypto.randomUUID()`（exportSession.ts:244、useSourceUpdateSession.ts:267）→ 本地排队/重放可复用该模型。
- **blob 下载统一校验**：`storageDownloadResult`（storage.ts:539-572，content-type + Content-Disposition 文件名）。


---

## 3. 核心翻译算法与任务引擎源码定位清单

> 体量为非测试代码实测行数；「难度」评估 1:1 TS 移植成本。

### 3.1 领域算法（纯计算，优先移植）

| 域 | 文件/函数/行 | 签名 | 依赖 | 难度 |
|---|---|---|---|---|
| 保护-还原 | `protect/protect.go`：`Protector` 接口 :23-27、`nextKey` :37-49、`Compose` :56、`ProtectText` :131-140、`RestoreText`→`restoreAll` :144-170、`FromRules` :185-200；占位符 `__LF_%06d__` :31 | `ProtectText(p Protector, text string) (string, map[string]string, error)` | Go RE2 正则（`mergeAdjacentPlaceholderRE` :17 等 11 条）→ **re2js** | 低 |
| 占位符守恒 | `protect/integrity.go` `PlaceholderViolations` :22-54（missing/duplicated/invented 三分类，invented 探测 `(?i)__LF_[A-Z0-9_]+?__` :11） | `(seg) → (missing, duplicated, invented []string)` | strings.Count | 低 |
| 结构判定 | `protect/structural.go` `AnalyzeStructural` :33-59（保护链残差无字母数字 ⇒ StructuralOnly） | `(p, text) → Analysis` | unicode.IsLetter/IsDigit → `\p{L}\p{N}` | 低 |
| 子保护器 | `placeholder.go`(:14-41 {{var}}/{var}/printf/shell $VAR)、`code.go`(:10-40 RE2 无反向引用故围栏两式分写)、`link.go`(:15-58)、`xml.go`(:10-28)、`ruby_adapter.go`(:11-36) | 各 `Protect(seg *model.Segment) error` | 正则 | 低 |
| 批次切分 | `pipeline/batch.go`：`BatchConstraint`（MaxSegments AND MaxWords 双约束）:9-20、`BuildContextAwareBatches` :28-59、`BuildContinuousPendingBatches` :64-97、`BuildPackedPendingBatches` :105-113；`batch_utils.go` `CountWords` :197-214（**CJK 每字符 1 词**、拉丁按空格）、`ExpandBatchWithContext` :47-78、O(1) 前缀和 :106-136 | `(pending, poolIndex) → [][]int` | rune 分支 | 中 |
| 上下文窗口 | `pipeline/context.go` `ContextConfig`（默认 Before=1 After=1）:3-19 | — | — | 低 |
| 译后处理 | `pipeline/translate_handler.go` `processTranslatedSegments` :605-734：漏译清空→ruby 合并→`NormalizePlaceholders`→占位符校验违规清空→Trim→`Unprotect`→`RestoreSegmentRuby`→`markup.TargetRegression` 结构守卫→`TM.Add` | `(doc, idxs, wantIDs, trans, rubyOutputMap, contextSet) → unresolved` | repair/protect/ruby/markup/tm | 中 |
| Prompt 升级重试 | 同上 `tryPromptUpgrade` :560-603（ParseErr 时追加 reminder 再试一次） | — | repair | 低 |
| 术语注入 | `translate_handler.go` `lookupHints` :737-790（glossary+TM 每段查询合并去重）；inline bootstrap `absorbInlineGlossary` :792-847 + 配额 `calcMaxBootstrapTerms`=ceil(words/1000*coeff) :896-907 | — | glossary | 低 |
| 术语抽取 | `pipeline/extract_handler.go` `ProcessBatch` :167-373（多 backend 轮换、best-effort、失败空成功语义） | — | glossary | 中 |
| 术语精简 | `service/glossary_prune.go` `Preview` :206、`computePruneDiff` :442、`Apply` :510（重命名/删/更新） | — | LLM+ent | 中 |
| 术语同步 | `service/glossary_sync_lifecycle.go`（checkpoint JSON :198-264、分批 :449+） + `worker/sync_task_runner.go` | — | ent | 中 |
| CSV 术语表 | `glossary/file.go` `LoadFile` :43-120（BOM/表头/扩展列）、`Lookup` :123-143（**长词优先线性扫描**）、`Add` 严格合并 :151-189、`Save` 原子写 :192-247；`replace.go` `SafeReplace` :35-78（CJK 直接替换/拉丁词边界） | — | — | 中（存储→IDB） |
| QA 检查器 | `qa/qa.go`（code 词表 :18-241、`LocateSpan` :525-578、`ReconcileIssues` :428、`Fingerprint` :401）+ 15 个独立 checker（length/number/duplicate/placeholder_leak/terminology/untranslated/width_mix/punctuation_*/subtitle_line/xml_tag/url_email/source_residual/script_mismatch/whitespace）+ `script` 包（生成字表 tables.go:313L + `Scan` 证据扫描） | `checkInput → []QualityIssue` | 纯字符串/rune | 低（体量大、规则独立） |
| 响应修复 | `repair/`（2,187L）：`TryRepair` :90-232、bootstrap 路径 :241-440、`json.go` 手术（尾逗号 :125、控制字符 :165、未转义引号 :214、截断到最后完整值 :304、括号补全 :348、信封提取 :423、键控对象补丁 :539、对象合并 :636）、text 三段协议解析 `text.go:82` | `TryRepair(text, wantIDs, opt) → Result` | JSON 字节级 | **中-高**（edge case 必须全量带测试） |
| 纠错规则 | `correct/`（616L）：白名单 3 规则（punctuation_missing_wrap/wrap_loss_wrap/width_mix_normalize）、`Apply` 首个 Changed 即停 :87-100 | — | — | 低 |
| 注音 Ruby | `ruby/`（2,039L）：`extractor.go` `Extract` :69-92（多 rt 逐对、相邻合并）、`restorer.go` `RestoreItems` :28-85、`ParseInlineMarkers` :163、`alignment.go` 状态机（`ApplyOutput` :180-268 occurrence 冲突检测）；管线侧 `pipeline/ruby_restore.go` `restoreSegmentRuby` :41-101 + 定向重试 :133-248 | — | 正则 3 条 | 中（rune 偏移精确性） |
| 翻译记忆 | `tm/sqlite.go` :39-126（**完全相等匹配**、Score≡1、usage_count 排序） | `Search/Add` | hash（`internal/hash`【需人工复核：哈希算法细节】） | 低 |
| Markup 守卫 | `markup/fragment.go`（epub 需 WellFormed Targets :37-49、`ValidateFragment` 严格 XML :62-86、`TargetRegression` 三重门 :124-131） | — | encoding/xml 严格等价 | 中（选严格 XML 解析器对照） |
| 文字系统 | `script/`（scan.go 71L + han.go 86L + 生成字表）——opencc 仅构建期（`cmd/hanvariantgen`），运行时零依赖 | `Profile.Scan(text) → Evidence` | `golang.org/x/text/language` → `Intl.Locale` | 极低 |
| 模板渲染 | `prompt/`（1,660L）模板语法【需人工复核：渲染语法逐行】 | — | — | 中 |
| 解析器 | `parser/`：markdown（goldmark AST）、subtitle srt/vtt/ass（手写行级）、jsonp（JSON/TOML/YAML）、html、epub（stdlib zip+xml + OPF + XHTML + TargetInspector）、docx（**无第三方库**，自研 OOXML 映射/渲染）、text/xunity | `Parser{Extensions, Parse, Render}`（parser.go:18-27） | 各异 | md/epub/docx=高；subtitle/text=低；jsonp/html=中 |

### 3.2 执行引擎语义（审计 3/4）

**批次大小口径**：段数 + 字词数双约束（非 token）；`Shrink∈(0,1]` 缩批系数 `floor(orig*Shrink^pool)`；**池数恒 = `Retry.MaxAttempts+1`**（池内全并发、池间串行）；在途重试预算 `transientBudget=min(maxAttempts+1, 3)`（`round_executor.go:119-124,268-281`）；退避 `backoffDuration` :877-897（指数+Jitter，429 取 Retry-After，最小 5s）；fatal=401/403 :867-874。

**RunRound 核心语义**（`pipeline/round_executor.go:88-265`）：池 0 由 handler 扫描 doc（translate 先做 `AnalyzeStructural` 全段保护链分析）；`pending=上一池 unresolved`；`Resolved = 池 0 扫描集合 − finalUnresolved − failedSegments`（`computeResolved` :285-313）；暂停时不进新池 :139-143；`Gate.AcquireInflight`→`Slots.Acquire`→槽位后复查暂停 :404-439；**提交确认门** :461-482（ctx 已死一律 deferred，绝不伪造断点）；`notifyResolvedSegments` 保证 `segment_completed ≡ 断点集合基数` 不变式。

### 3.3 任务状态机（现状枚举）

| 实体 | 枚举 | 证据 |
|---|---|---|
| Job | `pending / running / pausing / paused / completed / failed / cancelled`（pausing=在途排空中间态） | `service/job.go:37-43` |
| JobResource | `pending / running / completed / failed / cancelled` | `service/job.go:47-51` |
| JobRound | `pending / running / completed / failed / skipped`（「JobRound 矩阵是进度唯一事实源」） | `service/job.go:55-59` |
| WorkItem 光标 | `pending / candidate / unresolved`（worker 侧另含 stale/rejected→归并 unresolved、`terminal_failure`） | `pipeline/staged_store.go:18-26`、`round_store.go:101-103`、`stored_round.go:93-95` |
| 请求事实 | `sent / received / unknown / completed / failed` | `workstate/types.go:117-124` |
| 候选提交 | `accepted / already / committed / noop / stale / retryable_storage / rejected / fatal` | `pipeline/staged_store.go:78-86` |
| Dispatcher | `starting → recovering → running →(degraded) → stopping → stopped` | `worker/dispatcher.go:47-63` |

**暂停/恢复/取消/崩溃恢复（现状）**

- **暂停**：API→`PauseRequested/JobStatusPausing` 条件更新→`dispatcher.PauseTask`→`PauseGate.Pause()`（`pipeline/round.go:84-175`，paused=close(done)，`TryStartDispatch` 原子暂停×许可）；不派发新批、在批处理完退出、退避 select 被 `gate.Done()` 中断；排空后 `MarkJobPaused`，资源冻结为 running，resume 从断点续跑。
- **取消**：`Capture()` 先取 claim 防旧 claim 误响（`dispatcher.go:318-347`）→ `queue.CancelExecution`→ctx cancel→资源淡出取消并认可 partial progress→30s `ReconcileJob` 收尾。
- **崩溃恢复**：每 runner 先 `PrepareRecovery`→barrier→`discover` 2s 轮询；CandidateWindow 从 headers 分页 128 重建占用（`job_runner.go:262-285`）。
- **检查点**：`workstate/checkpoint.go` `LockJob`（retry_epoch 抢锁）:18-27、`Confirm` :127-275（bulk 插入 `JobRoundSegment` 完成事实 + 幂等 commit_id + 原子累计）、`Calibrate` :64-123；候选 CAS：`round_store.go` digest 校验 :40-48、`SaveCandidateWithCursor` payload+cursor 原子 :202-206、`Commit` 以 `(ContentVersion, BaselineTarget, Status)` CAS :423-476、`RetireStale` 处理 commit 丢失 :378-411。

**SSE 协议**（`api/handler_job_stream.go:34-252`）：auth 冻结 + 5s 周期复核；Last-Event-ID/query 兜底回放（512 窗、批 200）；`id: seq\nevent: type\ndata: JSON`；`X-Accel-Buffering: no`。事件类型见 `event/broker.go:14-24`（job_started/resource_started/completed/warning/failed/cancelled/job_paused/resumed/completed/warning/failed + progress 层 batch/pool）。

### 3.4 浏览器化目标状态流转（设计）

~~~mermaid
stateDiagram-v2
  [*] --> pending: 创建 Job(IDB)
  pending --> running: Worker 抢占<br/>Web Locks("linguaflow.job."+id)
  running --> pausing: 用户暂停(BroadcastChannel 命令)
  pausing --> paused: 在途批次排空<br/>Gate 等价物=AbortController+计数
  paused --> running: resume(断点=WorkCursor)
  running --> completed: 全 round 终态
  running --> failed: 不可重试终态
  running --> cancelled: cancel=AbortSignal
  paused --> cancelled
  note right of running
    每段 WorkCursor{state,pool,attempts,nextAttemptAt}
    每批次 checkpoint=候选 payload+cursor 原子事务(IDB)
    提交确认门=事务 oncomplete 后才计数
  end note
~~~

### 3.5 Go → TS 移植策略要点

1. goroutine+chan+select → async 函数 + 有界作业队列 + `Promise.race`；Station 信号量 → Promise 队列；PauseGate → 事件标志 + 在途计数 + AbortSignal。
2. `context.Context` → `AbortController`/`AbortSignal` 组合；需区分「执行取消」与「shutdown 清理」两个独立信号（对应 `queue.go:23-30`）。
3. channel（jobs/results/changed）→ 有界队列 + 唤醒回调；`Window.Changed()`「变化信号+重新读」模式 → 回调/事件。
4. mutex/sync.Once → JS 单线程无锁；但**文件锁语义需重建**（DB 事务 → IndexedDB 事务 + revision CAS）。
5. `slog` → 结构化日志对象；`encoding/json` → JSON.parse/stringify（注意 `qa.Disposition` 自定义 Marshal/Unmarshal `qa.go:45-75`、CandidateDTOVersion 版本化 `candidate.go:22`）。
6. Go RE2 → **re2js**（前端已有依赖 `re2js@2.8.6`）：后端正则量少且集中（protect 11 条、code 2 条、markup tagRe、integrity 2 条、qa 若干、ruby 3 条、glossary 无），兼容度高，但 `\b`/`\s` 语义与 `\p{L}` 等 Go 特有写法需逐条对照。
7. 纯计算 vs 有状态划分：纯计算 ≈1.2 万行（含 prompt）可直接 1:1；有状态/IO ≈ workstate 2,928L + worker 5,461L + pipeline 编排 2,800L + parser IO。
8. **风险最高三处**：`round_executor.go` 干道排空/断点不变式（~950L）、`workstate` CAS/事务（~1,250L）、`repair/json.go` JSON 手术 edge case（~1,300L 测试覆盖必须全转）。

---

## 4. 目标前端分层目录设计

~~~
frontend/src/
├── pages/  components/  composables/  layouts/   # 零改动（调用契约不变）
├── stores/                                        # 零改动；仅 api 导入源切换为 gateway
├── gateway/                    # ★ 新增：Application Gateway（唯一接缝）
│   ├── index.ts                #   getGateway()：mode==='browser-local' ? localGateway : remoteGateway
│   ├── contracts/              #   与现有 api/* 签名 1:1 的接口（由 types.d.ts 派生）
│   ├── local/                  #   LocalGateway：实现 contracts，落 IDB/OPFS/Worker
│   ├── remote/                 #   RemoteGateway：薄包装现有 api/*（openapi-fetch 原样）
│   └── sync/                   #   CloudAdapter（Phase 6）：outbox/增量/冲突
├── domain/                     # ★ 跨语言移植层（Go 包 → TS 纯函数）
│   ├── protect/  batch/  qa/  repair/  correct/  ruby/  glossary/  tm/  script/
│   ├── markup/  prompt/  parser/{md,html,epub,docx,subtitle,jsonp,text}/
│   └── shared/{result,clock,hash,words}.ts
├── application/                # ★ 用例编排（worker 主入口逻辑）
│   ├── job-engine/             #   round-executor / staged-runner / pause-gate / admission
│   ├── glossary-workflow/      #   bootstrap / prune / sync
│   ├── export/  import/  quick-translate/  preview/
│   └── events/                 #   事件总线（替代 SSE broker）
├── infrastructure/
│   ├── indexeddb/              #   Dexie db、实体 repo、checkpoint store、迁移
│   ├── opfs/                   #   大文件（EPUB/DOCX/导出产物/字体）
│   ├── worker/                 #   worker 进程壳、RPC（MessageChannel）、池化
│   ├── ai-providers/           #   openai/anthropic/google 兼容客户端（fetch+ReadableStream SSE）
│   ├── locks/                  #   Web Locks 封装（单实例执行 + 刷新锁复用 client-core.ts:91-95 模式）
│   └── broadcast/              #   BroadcastChannel 封装
└── api/  auth/  utils/         # 保留：remote 模式继续使用；token-storage/session-core 复用
~~~

**衔接关系**：`stores/*` → `gateway`（构造函数注入/模块单例，复用 `scopedEntity.ts`、`storage.ts:82`、`credentials.ts:44` 既有 transport 缝）→ `application`（写用例经 Worker RPC）→ `domain`（纯函数）+ `infrastructure`（IDB/OPFS/providers）。Vue 组件与 store 的类型契约完全不变——`contracts/` 以 `api/types.d.ts`（13,754L，openapi-typescript 生成）为唯一 DTO 源。

---

## 5. IndexedDB (Dexie) + OPFS 存储 Schema 设计草案

> 划分原则：结构化元数据/文本 → IndexedDB；大二进制（EPUB/DOCX 源、导出产物、快照、字体、图片）→ OPFS。
> 所有实体预留云同步元字段 `{id, createdAt, updatedAt, revision, deletedAt, deviceId, dirty}`。

### 5.1 Dexie 表草案（v1）

| 表（主键 / 索引） | 对应后端实体 | 关键字段 |
|---|---|---|
| `projects` (`id` / `updatedAt,deletedAt,storageSpaceId`) | Project（project.go:11） | name, sourceLang, targetLang, glossaryEnabled, config, storageSpaceId, storageGeneration |
| `resources` (`id` / `[projectId+path]`唯一, format) | Resource（resource.go:16） | path, format, currentSourceRevisionId, source/translationGeneration, totalSegments, opfsPath |
| `source_revisions` (`id` / `[resourceId,current]`) | SourceRevision（sha256/size/parserVersion/verificationState/retainUntil/deleted 软删） | opfsBlobKey |
| `segments` (`id` / `[resourceId+segmentIndex]`唯一, status, contentVersion) | Segment（contentVersion 只增 hook :15-81 → 迁移为修订递增规则） | sourceText, targetText, meta, qualityIssues, status(pending/translated/edited/approved/rejected) |
| `segment_revisions` (`id` / segmentId, sourceGeneration) | SegmentRevision（before/after 快照，撤销历史） | operationId, kind(replace/reverse) |
| `glossary_entries` (`id` / `[projectId+sourceKey]`) | GlossaryEntry（条件唯一：非禁译 key / 禁译 key+target :43-47） | source, target, caseSensitive, forbidden, mandatory, notes |
| `tm_entries` (`id` / `[projectId+sourceHash]`) | TMEntry（完全相等匹配） | usageCount |
| `translation_prompt_templates` / `bootstrap_prompt_templates` / `prune_prompt_templates` / `execution_plan_templates` / `execution_profiles` | 5 个模板/配置实体（同构：name/description/scope/owner/config 或 content JSON） | schemaVersion, profileId, rounds, rubyRetry |
| `backends` (`id`) | Backend（backend_type openai/anthropic/google、options、credentialId、rateLimitPerMinute） | optionsJson |
| `credential_vault` (`id` / provider) | Credential+CredentialVersion（AEAD 密文；本地用 WebCrypto AES-GCM 派生密钥） | ciphertext, nonce, keyId, currentVersion, revoked |
| `jobs` (`id` / projectId, status, updatedAt) | Job（retryEpoch, pauseRequested, executionPlanId, executionConfig 快照, progressTotal/Completed, retentionAnchorAt） | triggerType, resourceCount/Completed/Failed, errorMessage |
| `job_resources` (`id` / jobId) | JobResource（segmentIds 快照, workWeight, outputPath） | sourceRevisionId, sourceGeneration |
| `job_rounds` (`id` / `[jobId+resourceId+roundIndex]`) | JobRound（manifestSealed, poolIndex, mode, segmentTotal/Completed） | status |
| `job_round_segments` (`id` / `[jobRoundId+segmentId]`唯一) | JobRoundSegment（commitId 幂等键, candidateId, outcome） | — |
| `work_items` (`id` / jobId, state, nextAttemptAt) | WorkItem（四元 ID, retryEpoch, poolIndex, 4 类 attempts, cursor JSON） | candidateId |
| `work_candidates` (`identity` / workItemId, state) | WorkCandidate（dtoVersion, snapshotDigest, baselineVersion/Target/Status, payloadBytes） | payload（CAS 键） |
| `work_requests` (`identity`) | WorkRequest（stage/backendId, members, debits, glossaryReceipt, usageKnown, tokens, durationMs） | state |
| `job_events` (`[jobId+seq]`) | SSEEvent（type, level, stage, message, metadata） | createdAt（BroadcastChannel + 回放双源） |
| `storage_tasks` (`id` / projectId, kind, status) | StorageTask（contractVersion, idempotencyKey, leaseToken, expected_* 四代际, result 引用） | phase, cleanupStatus |
| `export_artifacts` (`id` / resourceId) | ExportArtifact（snapshotBlobId→opfsKey, outputBlobId→opfsKey, rendererVersion, rebuildable, filename, options） | status |
| `blobs` (`identity` / projectId, purpose, status) | Blob（size, sha256, activeLocation）+ BlobLocation（objectKey=opfs 路径, providerVersion='opfs', integrity） | purpose: source/export/snapshot |
| `usage_records` (`id` / projectId, createdAt) | UsageRecord（apiCalls, inputTokens, outputTokens, segmentCount） | source, note |
| `activity_logs` (`id` / createdAt) | ActivityLog（action, resourceType, resourceId, message, metadata） | visibilityScope |
| `preferences` / `kv_meta` | SystemSetting/本地偏好（epoch、schemaVersion、云同步游标） | scope（复用 `session-core.ts:36` 的 baseUrl｜userId） |

### 5.2 OPFS 布局（对应后端 `objects/<space.Identity>/<projectID>/<uuid>`，service/storage.go:502）

~~~
opfs:///linguaflow/
  ├── objects/<spaceIdentity>/<projectId>/<uuid>     # 源文件/导出/快照（Blob.purpose 三类）
  ├── tmp/<writeId>/                                  # StorageWrite 的 candidate→live 原子落位
  └── cache/                                          # 解析中间产物、字体缓存
~~~

预算上限照搬 `ziputil`/`storage` 常量族（`resource_storage.go:229-231` MaxArchiveEntries/MaxExpandedBytes/MaxOutputBytes）与前端 epub-rotate 既有预算（`useEpubRotate.ts:39-44`：80MB 单文件 / 16MB 单条目 / 120MB 总解压 / 8000 条目）。

### 5.3 同步元字段与冲突规则（Phase 6 Cloud Adapter）

- 全表统一：`id`(UUIDv7，可排序)、`createdAt/updatedAt`(ISO8601)、`revision`(单实体单调，替代 ent ContentVersion 的 CAS 语义)、`deletedAt`(软删墓碑)、`deviceId`、`dirty`(outbox 标记)。
- CAS 等价：`work_candidates` 候选提交 = 「读 revision==baseline → 写 revision+1」的 IDB 事务内校验（复刻 `round_store.go` Commit 语义 :423-476）；`segments.contentVersion` 同理。
- 幂等：`job_round_segments.commitId`、上传 `Idempotency-Key`（projects.ts:335-387）、export/source-update UUID key（exportSession.ts:244）原样保留 → 云同步重放安全。


---

## 6. 浏览器兼容性、CORS、大文件内存与多标签页并发风险清单

### 6.1 CORS / Provider 直连矩阵

Provider 现状：三 Provider 均为**服务端进程内直连**（openai-go v3 / anthropic-sdk-go v1.33 / genai v1.54，`backend/*/{openai,anthropic,google}`），base_url 可配（openai 兼容网关/Azure/Ollama）；**无任何 LLM 代理层**（`authhttp` 仅是 OIDC/OAuth2 身份协议出站防护，`authhttp/transport.go:73-100`）。

| Provider | 默认端点 | 浏览器直连 CORS | 应对 |
|---|---|---|---|
| OpenAI 兼容 | `https://api.openai.com/v1/`（credential/transport.go:13-17） | **高风险**：官方 API 未开放浏览器 CORS（须实测确认） | 默认关闭直连；提供「自定义反代 URL」配置项（base_url 本就可配，openai.go:250-252） |
| Anthropic | `https://api.anthropic.com/` | 提供 `anthropic-dangerous-direct-browser-access` 头的浏览器直连支持（须实测验证版本行为） | 直连+显式开关+风险提示；同样支持反代 |
| Gemini | `https://generativelanguage.googleapis.com/` | API key 方式历史上允许浏览器 CORS（须实测） | 直连可用；key 暴露面提示 |
| 自建网关 | 用户 base_url | 取决于网关 | 文档化 + 连接测试器（复用 `auth/connection-test.ts` 模式） |

**必做实测清单（Phase 3 验收项）**：三 Provider 直连预检/流式（`fetch` + `ReadableStream` 手解 SSE——EventSource 不能带 Authorization，服务端已用 `?access_token=` 兜底的先例在 `api/auth.go:100-112`）、JSON schema 响应（openai json_schema strict / anthropic Tool Use :174-186 / gemini ResponseJsonSchema :190-197）、usage 计量字段映射、错误分类移植（`ratelimit.go:38-64` IsRetryable：500 以上或 429 或 408=可重试、401/403/404=否、EmptyResponseError=否转 shrink）。

### 6.2 密钥安全

- 现状：密钥仅 write-only 上传（`stores/credentials.ts:59`「secrets 永不回读」），服务端 AEAD 加密落库（`credentialstore/store.go:28-70` + AssociatedData 绑定 :259-266）；**无 OS keyring**——keyring=0600 本地 JSON 密钥环文件或 master_key（`credential/keyring.go:35-110`）。
- 本地方案：WebCrypto 派生密钥（PBKDF2 / 可选 passphrase 锁）加密存 `credential_vault`；明文仅存在于 Worker 内存变量；UI 层沿用「秘密只作为参数传递」纪律；导出备份时二次加密。可选云端模式下密钥永不入库同步（云端模式仍走服务端凭据 API）。

### 6.3 大文件内存风险

| 风险 | 现状证据 | 应对 |
|---|---|---|
| EPUB 解压爆内存 | 前端 rotate 已设 4 级预算（useEpubRotate.ts:39-44）；后端 zip 限额族 | OPFS 流式写入 + Worker 内逐条目处理；沿用预算常量 |
| 候选窗口内存 | 后端 `CandidateWindow` 256 段/16MiB/1MiB 每项（staged_runtime.go:32-34）+ RSS 双水位保险丝 | Worker 移植同参数；OPFS 溢出页 |
| 响应体限幅 | DefaultMaxResponseBytes=1MiB（response_limit.go:15） | fetch ReadableStream 累计计数等价实现 |
| IndexedDB 大 value | segments 行含全文 | 分表 + 窗口查询已窗口化（segment.ts cursor/anchor）；二进制一律外置 OPFS |

### 6.4 多标签页并发

- 复用既有模式：Web Locks（`client-core.ts:62,91-95` 刷新锁先例）→ 扩展为 `linguaflow.job.<jobId>` 执行主锁（Web Locks API）；`navigator.locks` 不可用时按 `refreshStrategy()`（:84-89）语义降级为「单上下文执行」。
- 进度广播：BroadcastChannel 替代 SSE（`globalJobTracker.ts:134-138` 唯一 EventSource 改造点）；`job_events` 表 seq 回放对齐现有 Last-Event-ID 协议（handler_job_stream.go:125-152）。
- 跨页签上下文：复用 `cross-tab-session.ts:8-28`（storage 事件 + epoch）与 `session-core` generation abort。

### 6.5 其余兼容性

- Web Worker 内不可用：`window/document`（XHTML/OPF 解析需自研流式解析器或主线程 DOMParser 兜底）；`localStorage`（Worker 无——token-storage 的内存 Map 兜底模式可直接复用）。
- iOS Safari：OPFS 同步句柄与 Web Locks 支持较晚，需能力检测 + localStorage 降级（`utils/secureContext.ts`、`utils/storage-availability.ts` 已有检测雏形【需人工复核：覆盖面】）。

---

## 7. 功能分类矩阵（A/B/C）

| 类别 | 判据 | 功能清单（证据） |
|---|---|---|
| **A 类：可直接纯前端化**（Gateway 换底 + IDB 即达） | 现为 CRUD/展示，无重计算无跨语言算法 | 项目/资源树/段落 CRUD 与审校（stores 3,4,22,23,24）、术语表 CRUD/导入导出（CSV 解析中）、5 类模板与执行配置 CRUD、AI 后端与凭据配置、**EPUB 横竖排工具（已是纯前端 fflate，`useEpubRotate.ts`）**、任务列表/历史/删除（分页已窗口化）、Dashboard 统计（本地聚合）、路由守卫/登录语义（local 免登已是现状）、上传 precheck/冲突会话（状态机前端已有） |
| **B 类：跨语言移植 + Web Worker 改造** | Go 算法包或引擎需 1:1 TS 移植 | ① 纯函数域 约1.2 万行：protect(574)/qa(3,447)/repair(2,187)/ruby(2,039)/correct(616)/glossary 匹配/批次切分/prompt 渲染(1,660)/script 字表——**难度低-中**；② 解析器：subtitle/text/jsonp/html（低-中）、markdown/epub/docx（高）；③ 引擎与检查点：round_executor(948L)、staged_runtime 候选窗口、workstate CAS(2,928L)、round_store(476L)、db_reporter(923L)——**难度高**；④ 术语工作流（extract/prune/sync）、TM、导出渲染（parser.Render 按位替换）、存储任务（upload/export/source_update/repair 状态机）、quick-translate（当前纯文本无解析） |
| **C 类：仅云端模式需要** | 依赖多用户/外部身份/远程对象存储/跨设备 | OIDC/OAuth2 外部登录与回调（`/auth/external/*`，AuthTransaction 8 态机）、组织与成员、admin 用户管理与审计日志、S3 存储驱动、存储退役编排（StorageRetirement 双层任务）、站点存储政策/配额治理、任务保留策略、**跨设备增量同步（Cloud Adapter，Phase 6 新能力）**、邮箱注册/验证、部署级恢复令牌 |

**Auth/Admin 边界划分（审计 8 结论）**

纯浏览器本地模式下——认证体系自动免登（等价于现 local 短路语义）；`/admin/*` 默认开放给单机管理员（与现 local 行为一致：`requireAdmin` 在 local 下实时重读 user 校验 active，`api/auth.go:58-65`）；`/settings/team` 隐藏（现状 guards.ts:72）；外部身份源不提供（auth-connections 管理页在本地可保留为「云端模式配置预置」）。

路由组三态矩阵（/api/v1 前缀省略）：

| 路由组 | 纯浏览器本地可行 | 需可选云端 | 纯服务器 |
|---|---|---|---|
| ping/mode/auth/capabilities | ✅ 本地直接应答 | — | ✅ |
| auth/register-login-refresh-logout、users/me/password | ✅（local 免登录） | ✅ | ✅ |
| auth/external/*（OIDC/OAuth2 回调/绑定） | ❌ 本地无外部身份源 | ✅ | ✅ |
| projects/resources/segments/glossary/jobs/SSE/quick-translate/stats/activity/orgs/credentials/backends/模板与计划/execution-profiles | ✅ | ✅ | ✅ |
| storage 用户/项目域（connections/spaces/tasks/uploads/exports） | ✅（driver=local 磁盘 → OPFS） | ✅（S3） | ✅ |
| admin/*（users/auth-connections/local-account/policy/diagnostics/retention/settings/stats/audit-logs/runtime/metrics） | ✅（local 自动 admin） | ✅（真实角色） | ✅ |

---

## 8. Phase 1~6 执行路线图与 Golden Test Vectors 验收计划

| Phase | 内容 | 关键验收（Golden Vectors 来源——全部取自现有 Go 测试） |
|---|---|---|
| **Phase 1：领域层移植 + Gateway 接缝** | `domain/` 移植 protect/repair/qa/correct/ruby/glossary 匹配/批次切分/script；`gateway/contracts` 落地（stores 零改动切换） | ① `protect/*_test.go` 全用例转为向量（含 mergeAdjacent :69-125、字面量碰撞 fail-closed :97-121）；② `repair/json_test.go` + envelope/salvage 全集（最高风险）；③ qa 15 checker 样例集 + `script_test.go` likely-subtags 矩阵；④ 批次切分：`round_executor_unified_test.go`（MaxAttempts=0 单池 / Shrink=1.0 三池同尺寸 :57-88）+ `batch_test.go`；⑤ re2js 与 Go RE2 逐正则对照表 |
| **Phase 2：本地存储基础设施** | Dexie schema v1（§5.1）、OPFS 布局、repo + 快照失效（复用 `utils/storage-snapshots`）、epoch 隔离 | 段落窗口查询与现 API cursor/anchor/desc 语义逐项对拍（segment.ts:206-416 行为快照）；上传→解析→segments 落库端到端；storage_generation 等代际字段行为 |
| **Phase 3：AI Provider 层** | `infrastructure/ai-providers`（fetch+SSE 流式、json schema 三协议、usage、错误分类、限流、反代配置）、quick-translate、段落预览 | §6.1 实测清单全绿；`ratelimit.go` IsRetryable / Retry-After 解析（秒/HTTP 日期/Retry-After-Ms :108-130）向量；`translate_batch_test.go` 错误形态向量（BackendError 发批/截断信号 :24-101） |
| **Phase 4：任务引擎 Worker + 多标签页** | application/job-engine（RunRound 等价物、PauseGate、Station 信号量、admission）、workstate→IDB checkpoint（事务=CAS）、Web Locks 主锁、BroadcastChannel 事件 + seq 回放 | 暂停语义向量：`round_executor_pause_test.go`（池内派发前暂停不计数 :127-135、:278-299）；提交确认门 `round_executor_commit_gate_test.go`（ctx 死→deferred 不伪造断点 :23-50）；drain 协议 `round_executor_drain_test.go`（10s 内返回 :169-172）；Resolved 计数不变式 `round_executor_resolved_test.go` 全集 |
| **Phase 5：文件管线与导出** | parser 全格式（md/html/epub/docx/subtitle/jsonp）、导出渲染（snapshot→render→OPFS）、存储任务本地化、QA recheck/裁决轮 | 解析向量：每格式 parser `*_test.go` + markup `TargetRegression` 三重门；EPUB 章节分组（`/segments/groups` 形状）；导出 round-trip（render 按位替换后 zip 哈希对照）；epub-rotate 已有实现保持回归 |
| **Phase 6：Cloud Adapter（可选）** | 登录/OIDC 接入、组织、outbox 增量同步（revision/deletedAt/dirty）、冲突解决、保留策略服务端 | 同步向量：幂等重放（Idempotency-Key/commitId）、墓碑删除、CAS 冲突样例；现 server 模式全量回归（remoteGateway 直通旧 api/*） |

**总验收门（每 Phase）**：`pnpm type-check` + 既有 vitest 套件（stores/api/composables 14 个测试文件）零回归；Golden Vectors 以「Go 侧 fixture 导出（JSON 快照）→ TS 断言」双轨执行；每 Phase 结束产出对照审计表（本报告 §3/§5 逐项勾稽）。

---

## 附录 A：完整端点清单

> 行号来自 `frontend/src/api/*.ts`。路径前缀 `/api/v1`。

### A.1 通用 / 认证 / 账户

| 方法+路径 | 源码 |
|---|---|
| `GET /ping` | bootstrap-service.ts:41；client-core.ts:433 |
| `GET /mode` | bootstrap-service.ts:44；system.ts:10 |
| `POST {base}/auth/refresh` | client-core.ts:98（raw fetch） |
| `POST /auth/logout` | client-core.ts:319（raw fetch） |
| `POST /auth/login` | auth.ts:14 |
| `POST /auth/register` | auth.ts:33 |
| `GET /auth/capabilities` | auth-capabilities.ts:9 |
| `PUT /users/me` | account.ts:11 |
| `PUT /users/me/password` | account.ts:26 |
| `GET /users/me` | projects.ts:97 |
| `GET /users/me/login-methods` | login-methods.ts:19 |
| `POST /users/me/password` | login-methods.ts:33 |
| `DELETE /users/me/password` | login-methods.ts:47 |
| `DELETE /users/me/login-bindings/{bindingId}` | login-methods.ts:66 |
| `POST /auth/reauthenticate` | login-methods.ts:86 |

### A.2 项目 / 资源 / 段落

| 方法+路径 | 源码 |
|---|---|
| `GET /projects` | projects.ts:122 |
| `GET /projects/{projectId}` | projects.ts:136 |
| `POST /projects` | projects.ts:152 |
| `PUT /projects/{projectId}` | projects.ts:169 |
| `DELETE /projects/{projectId}` | projects.ts:185 |
| `GET /projects/{projectId}/resources` | projects.ts:205 |
| `POST /projects/{projectId}/resources/precheck` | projects.ts:239 |
| `POST /projects/{projectId}/resources` | projects.ts:270（XHR :327-388） |
| `DELETE /projects/{projectId}/resources/{resourceId}` | projects.ts:419 |
| `GET /projects/{projectId}/resources/{resourceId}/download` | projects.ts:437（blob） |
| `GET /projects/{projectId}/resources/{resourceId}/download-translated` | projects.ts:461（blob） |
| `GET /projects/{projectId}/resources/tree` | projects.ts:484 |
| `GET /projects/{projectId}/resources/{resourceId}/segments` | projects.ts:519 |
| `PATCH /projects/{projectId}/resources/{resourceId}/segments/{segmentId}` | projects.ts:543 |
| `POST .../segments/{segmentId}/translation-preview` | projects.ts:593 |
| `POST .../segments/{segmentId}/revision-preview` | projects.ts:622 |
| `POST .../segments/{segmentId}/translation-preview/apply` | projects.ts:653 |
| `POST .../segments/batch-review` | projects.ts:680 |
| `POST .../segments/approve-all` | projects.ts:700 |
| `POST .../segments/{segmentId}/issues/disposition` | projects.ts:721 |
| `POST .../segments/search-replace/preview` | projects.ts:777 |
| `POST .../segments/search-replace/apply` | projects.ts:819 |
| `POST .../segments/search-replace/{operationId}/undo` | projects.ts:849 |
| `GET .../segments/groups` | epub.ts:26 |
| `POST /projects/{projectId}/qa-recheck` | projects.ts:867 |
| `GET /stats/summary` | projects.ts:109 |
| `GET /activity` | misc.ts:11；organizations.ts:80 |
| `POST /quick-translate` | quick-translate.ts:11 |

### A.3 任务 / 事件 / 组织

| 方法+路径 | 源码 |
|---|---|
| `GET /projects/{projectId}/jobs` | jobs.ts:17 |
| `POST /projects/{projectId}/jobs` | jobs.ts:33 |
| `GET /jobs/{jobId}` | jobs.ts:50 |
| `POST /jobs/{jobId}/cancel` | jobs.ts:66 |
| `POST /jobs/{jobId}/retry` | jobs.ts:81 |
| `POST /jobs/{jobId}/pause` | jobs.ts:96 |
| `POST /jobs/{jobId}/resume` | jobs.ts:111 |
| `GET /jobs/{jobId}/events` | jobs.ts:142 |
| `GET {base}/jobs/{jobId}/stream`（SSE） | sseShared.ts:98 |
| `GET /operations` | operations.ts:41 |
| `GET /operations/summary` | operations.ts:52 |
| `GET /orgs` | organizations.ts:6 |
| `GET /orgs/{orgId}` | organizations.ts:11 |
| `POST /orgs` | organizations.ts:21 |
| `PUT /orgs/{orgId}` | organizations.ts:30 |
| `GET /orgs/{orgId}/members` | organizations.ts:38 |
| `POST /orgs/{orgId}/members` | organizations.ts:49 |
| `PUT /orgs/{orgId}/members/{userId}` | organizations.ts:62 |
| `DELETE /orgs/{orgId}/members/{userId}` | organizations.ts:74 |
| `POST /orgs/{orgId}/projects` | projects.ts:884 |
| `GET /orgs/{orgId}/projects` | projects.ts:902 |

### A.4 术语表

| 方法+路径 | 源码 |
|---|---|
| `GET /projects/{projectId}/glossary` | glossary.ts:26 |
| `POST /projects/{projectId}/glossary` | glossary.ts:42 |
| `PUT /projects/{projectId}/glossary/{entryId}` | glossary.ts:60 |
| `DELETE /projects/{projectId}/glossary/{entryId}` | glossary.ts:77 |
| `POST /projects/{projectId}/glossary/import` | glossary.ts:91（multipart） |
| `GET /projects/{projectId}/glossary/export` | glossary.ts:114（blob） |
| `POST .../glossary/{entryId}/sync-impact` | glossary.ts:140 |
| `POST .../glossary/{entryId}/sync-execute` | glossary.ts:165 |
| `GET /projects/{projectId}/sync-tasks/{taskId}` | glossary.ts:188 |
| `POST /projects/{projectId}/sync-tasks/{taskId}/cancel` | glossary.ts:209 |
| `POST /projects/{projectId}/glossary/prune` | glossary.ts:227 |
| `POST /projects/{projectId}/glossary/prune/apply` | glossary.ts:245 |

### A.5 存储（56 端点）

`GET/PUT /admin/storage/policy`（storage.ts:63/101）、`GET /storage/capabilities`（:77）、`GET /admin/storage/connections`、`GET /orgs/{orgId}/storage/connections`、`GET /storage/connections`（:117/120/126）、`POST .../connections`（:139/148）、`PATCH /storage/connections/{connectionId}`（:160）、`GET|POST /storage/connections/{connectionId}/spaces`（:169/181）、`PATCH /storage/spaces/{spaceId}`（:196）、`PUT /storage/spaces/{spaceId}/quota`（:211）、`POST /storage/connections/{connectionId}/authorize`（:225）、`POST .../check`（:246）、`POST .../revoke`（:260）、`GET|PUT /projects/{projectId}/storage`（:269/286）、`POST /projects/{projectId}/storage/migrations`（:301）、`GET /projects/{projectId}/storage/tasks`（:310）、`POST /projects/{projectId}/storage/tasks`（:354）、`GET .../storage/tasks/{taskId}`（:367）、`PUT .../storage/tasks/{taskId}/content`（:382）、`POST .../cancel`（:396）、`POST .../retry`（:407）、`GET .../resources/{resourceId}/versions`（:418）、`POST .../source-preview`（:431）、`POST .../source-commit`（:452）、`GET .../resources/{resourceId}/exports`（:469）、`POST .../exports`（:484）、`POST /projects/{projectId}/exports/{artifactId}/rebuild`（:499）、`DELETE /projects/{projectId}/exports/{artifactId}`（:513）、`GET /projects/{projectId}/exports/{artifactId}/download`（:525）、`GET /storage/options`（:579）、`GET /projects/{projectId}/storage/options`（:604）、`GET /storage/connections/{connectionId}/checks`（:617）、`GET .../checks/{checkId}`（:628）、`GET .../storage/tasks/{taskId}/legacy-snapshot`（:642）、`GET /admin/storage/diagnostics`（:663）。

### A.6 凭据 / AI 后端 / 模板 / 配置 / 管理

`GET /credentials`、`GET /orgs/{orgId}/credentials`、`POST ...`（credentials.ts:43/44/55/56）、`GET /credentials/{credentialId}/versions`（:66）、`POST .../versions`（:79）、`POST .../versions/{version}/revoke`（:91）、`POST .../collect`（:105）；`GET /backends`、`GET /orgs/{orgId}/backends`、`POST /backends/models`、`POST ...`、`PUT /backends/{backendId}`、`PUT /orgs/{orgId}/backends/{backendId}`、`DELETE ...`（backends.ts:23-71）；`/translation-prompt-templates`、`/prune-prompt-templates`、`/bootstrap-prompt-templates`、`/execution-plan-templates`、`/execution-profiles` 各自 CRUD（prompt-templates.ts:16-86、prune-prompt-templates.ts:16-83、bootstrap-prompt-templates.ts:16-101、execution-plan-templates.ts:16-96、execution-profiles.ts:16-79）；`GET /admin/stats`、`GET /admin/users`、`GET /admin/users/{userId}`、`POST /admin/users`、`PATCH /admin/users/{userId}`、`DELETE /admin/users/{userId}`、`PUT /admin/users/{userId}/password`、`GET /admin/audit-logs`、`GET /admin/settings`、`PATCH /admin/settings`（admin.ts:11-148）；`GET|PATCH /admin/local-account`、`GET /admin/local-account/attributes`、`POST /admin/local-account/preview`、`POST /admin/local-account/impact`（local-account.ts:52-87）；`/admin/auth-connections/*`（auth-connections.ts:69-267）；`GET /admin/runtime/summary`（runtime.ts:13）；`POST /admin/task-retention/preview`、`GET /admin/task-retention/status`、`DELETE /jobs/{jobId}`、`DELETE /projects/{projectId}/sync-tasks/{taskId}`、`POST /operations/batch-delete`（task-history.ts:143-233）。

---

## 附录 B：遗留待复核清单

1. `prompt/` 模板渲染语法逐行（1,660L）。
2. `internal/hash.Full` 哈希算法（TM 的 source_hash 生成）。
3. go-genai（google provider）SDK 内建重试/退避默认行为未显式配置（`google/google.go:276-340` 无重试开关）。
4. `internal/templates` 内置提示词/策略的种子写库时机。
5. iOS Safari OPFS/Web Locks 能力矩阵实测。
6. 三 Provider 浏览器 CORS 实测（§6.1 清单）。
7. `resource.format` 注释枚举过期（以 parser 注册表为准，`parser/parser.go:18-27`）。
8. `AuthConnection.identity_authority_id` 与 `kind=provider` 的语义。
9. `utils/secureContext.ts`、`utils/storage-availability.ts` 能力检测覆盖面。
10. `workstate/request.go`、`request_members.go` 细粒度事务。
11. `job_runner.go` 尾部 helper（1417-1779）与 `preview_runner/quick_translate_runner` 内部。

---

*本报告为 Phase 0 最终交付。三方并行审计（前端域 / 后端引擎域 / 服务·数据域）+ 11 组关键文件人工复核已交叉验证一致；审计过程未修改任何业务代码、配置、路由或数据库结构。*
