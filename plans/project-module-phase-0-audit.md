# LinguaFlow 项目模块 Phase 0 产品功能审计

> **审计基线**：仓库 `/data/dsh/home/workspace/projects/linguaflow`（2026-11-11 工作区快照）
> **审计方式**：只读审计，未修改任何业务代码。前端 UI 结构由并行子代理逐行盘点，数据层/联动/管线由人工直读核实。
> **证据规则**：全部结论精确到 `文件:行号`；严格区分「已实现 / 部分实现 / 仅占位或缺失」，不把建议包装成现状。

---

## 目录

1. [当前项目模块功能清单](#1)
2. [每项功能的真实用途评估](#2)
3. [与工作台 / 任务中心 / AI 配置的重复关系](#3)
4. [五类处置建议（A 保留 / B 简化 / C 合并 / D 可选 / E 移除）](#4)
5. [建议的新项目模块结构](#5)
6. [工作台与项目的联动方案](#6)
7. [数据模型是否需要调整](#7)
8. [数据迁移与兼容性影响](#8)
9. [涉及文件清单（仅清单，Phase 0 未改动）](#9)
10. [分阶段实施计划](#10)

---

## 1. 当前项目模块功能清单

### 1.1 总体定位（源码事实）

项目模块当前是一个**完整的文档翻译工作流系统**，而不是术语知识库：

- 项目 = 语言方向 + 术语开关 + 存储空间绑定的容器（`backend/internal/ent/schema/project.go:12-35`：`storage_space_id` / `storage_generation` / `output_generation` / `config` / `glossary_enabled` / `source_lang` / `target_lang`）。
- 核心闭环：**资源上传 → 解析分段 → 翻译任务（多轮执行计划）→ 段落人工审校 → QA 重检 → 译文下载/同步**。
- 术语表（glossary）只是项目内的一个 Tab + 翻译约束/同步机制，不是产品中心。
- 前端**不存在**任何「客户/产品术语知识库」的话术、路由、组件或占位（`docs/zh` 与 `locales/zh-Hans.ts` 中 projects 命名空间均为翻译工作流导向）。

### 1.2 功能清单（全部为已实现 A 级，除非另行标注）

#### 项目生命周期

| 功能 | 入口 | API | 状态 |
|---|---|---|---|
| 项目列表 / 搜索 / 筛选（全部·术语启用·停用）/ 组织范围 | `ProjectsListPanel.vue:137-178` | `GET /projects`（`api/projects.ts:123`） | A |
| 新建项目（抽屉：名称、语言对、术语开关、存储空间必选） | `ProjectFormDrawer.vue`（293 行） | `POST /projects` | A |
| 编辑项目 | 列表卡片/详情页铅笔 → 同一抽屉编辑模式（`ProjectFormDrawer.vue:74`） | `PUT /projects/{id}` | A |
| 删除项目（级联清理存储路径，含确认弹窗） | `ProjectsListPanel.vue:243-281`；后端 `service/project.go:210-258`（`cascadeDeleteProject`） | `DELETE /projects/{id}` | A |
| 最近打开记录（浏览器本地偏好） | 详情页加载成功 → `preferences.recordVisit`（`[projectId].vue:236-238`） | 本地 | A |
| 「最近与动态」Tab（最近项目 + 三栏任务恢复卡片，复用 `OperationRecoveryList`） | `ProjectsRecentPanel.vue` | 本地 + `GET /operations/summary` | A（部分依赖浏览器本地数据） |

#### 项目详情页 = 文档翻译工作台（`pages/projects/[projectId].vue`，883 行）

浏览态 Tab 外壳 + `?edit=<resourceId>` 深链进入沉浸式编辑视图（`:69-80`）；旧 `?tab=segments` 链接兼容回退（`:422-424`）。

| Tab/区块 | 组件 | 能力 | 状态 |
|---|---|---|---|
| 资源 | `ResourceExplorer` + `UploadPanel` + `UploadPrecheckPanel` | 上传/预检/冲突策略/进度/源文件更新队列/译文下载（含 409 缺陷明细 `ResourceExplorer.vue:210-238`） | A |
| 段落 | `SegmentPanel`（+ `SegmentDataTable`、`SegmentFindReplacePanel` 998 行、章节侧栏 `SegmentChapterSidebar`） | 编辑/批注/筛选/搜索替换/撤销/EPUB 章节级导航 | A |
| 单段预览 | `SegmentTranslationPreviewDrawer`、`SegmentRevisionPreviewDrawer` | 单段翻译/修订预览与应用 | A |
| 任务 | `JobPanel` + `JobCreateDrawer` + `globalJobTracker` | 任务创建（3 入口 + 执行计划预览 + 段落筛选）/轮询/取消/重试/暂停/恢复/删除/时间线 | A |
| QA | `QaRecheckDrawer`（450 行，4 入口 × 4 范围） | 质检重检与结果卡 | A |
| 术语 | `GlossaryPanel` + `GlossaryDrawer` + `GlossaryImportModal` + `GlossarySyncDrawer`（556 行）+ `GlossaryPruneDrawer`（605 行） | CRUD/CSV 导入导出/术语智能精简（诊断面板）/术语同步（影响分析→执行→结果，队列化可取消） | A |
| 统计 | `WorkspaceMetricsBar` | 资源数/分段数/已译/已批准/运行中任务 + 底部进度色条（props 传入，无独立统计 API） | A |
| 存储 | `ProjectStoragePanel` | 存储空间绑定/迁移/生成冲突/维护/恢复 | A |

#### 任务与执行引擎（项目强依赖）

- 任务（`ent/schema/job.go`）：`project_id` 必填、`execution_plan_id` 必填、`execution_config` JSON 快照、进度计数、暂停/重试 epoch。
- 轮次模式：`translate | extract | adjudicate | semantic_qa | revise | correct`（`api/types.d.ts:4420`）。
- 资源解析器支持：docx / epub / html / jsonp / markdown / 字幕 / 纯文本（`backend/internal/parser/`）。
- 段落人工审校：`service/review.go`（approve/reject/batch/approveAll/retranslateRejected/issueDisposition，`review.go:57-378`）。

#### 术语管线（当前实现方式）

- **提取（extract round）**：作为任务的一种轮次模式在项目任务中执行；`pipeline/extract_handler.go:167-307`（collectExisting → LLM → parse → `glossary.Add`）。
- **关键事实**：extract 轮的落库目标是 `service/runtime_glossary.go:83` 的 `DatabaseGlossary.Add` —— **直接写入项目术语表**（`createGlossaryEntry`），冲突/重复时 Skip（`SkipReasonExists`），**没有「候选 → 人工审核 → 入库」队列**。仓库中的 `work_candidate` 表与术语无关（是翻译对齐/提交状态，`ent/schema/work_candidate.go`）。
- **精简（prune）**：`service/glossary_prune.go`（Preview/Apply，需 backend + prune 提示词模板），前端 `GlossaryPruneDrawer` 605 行。
- **同步（sync）**：`service/glossary_sync.go`（AnalyzeSyncImpact → findAffectedSegments → 队列执行 → 可取消），前端 `GlossarySyncDrawer`。
- **CSV 导入导出**：`service/glossary.go:176-268`（`ImportCSV`/`ExportCSV`）。

#### AI 配置与提示词（已在前几轮整合）

- 「AI 配置」页 = 模型服务 + 提示词模板（translation/bootstrap/prune 三类）+ 用量统计（`pages/backends.vue`）。
- 提示词模板模型**与 AI 服务商解耦**（`ent/schema/translation_prompt_template.go`：仅 name/description/scope(user|org|system)/system_prompt_content，无 backend 绑定字段）✅ 符合红线。
- quick-translate 默认后端回退链已存在：内置翻译提示词 + 内置执行 profile + 默认后端候选（`service/quick_translate_fallback.go:56-208`）。

### 1.3 部分实现 / 缺失清单（严格区分）

| 项 | 状态 | 证据 |
|---|---|---|
| 「客户/产品术语知识库」重定位 | **C 缺失** | 无文案/路由/组件/占位；术语字段备注预设为小说/本地化导向（人名/角色名/作品名，zh-Hans 术语备注预设），未做外贸客户定制 |
| 工作台→项目沉淀术语（候选→审核→入库） | **C 缺失** | 全仓无 candidate 审核队列；extract 直接 `glossary.Add` 落库（见 §1.2 术语管线） |
| 术语「待审核数量」 | **C 缺失** | glossary_entries 表无 review/pending 字段（`ent/schema/glossary_entry.go:21-28`：source_key/source/target/case_sensitive/forbidden/mandatory/notes/project_id） |
| 项目级翻译规则/提示词 | **C 缺失** | 提示词模板为 user/org/system 三级全局资源；执行计划全局（execution_plan_template 无 project 字段）；项目仅 `config` JSON 自由字段 |
| 工作台向导/强制项目选择 | 不存在（符合红线） | `WorkbenchMailAssistant.vue:82` `projectId = ref(null)` 可不选项目直接翻译 |
| `switchToJobsTab` | 空函数（有意设计） | `[projectId].vue:168-170`，创建任务后留在当前页 |

---

## 2. 每项功能的真实用途评估

| 功能 | 用户实际解决什么 | 是否外贸即时翻译的真实需求 | 备注 |
|---|---|---|---|
| 项目 CRUD | 为客户/产品建立知识容器 | **部分**——容器本身有价值，但当前话术（「翻译项目」）与语言对+存储绑定使其看起来像文档翻译工程 | 保留但重定位 |
| 资源上传/下载/解析 | 大文档翻译 | **D**——偶发大文档场景有用，非即时邮件场景必需 | 保留为可选能力 |
| 段落编辑/审校/QA | 长文翻译质量控制 | **D**——与即时场景无关 | 保留为可选能力 |
| 任务系统 | 长时间批量翻译 | **D**——即时翻译不产生任务 | 与任务中心重复的部分归并 |
| 术语 CRUD/启停/强制/禁译 | 保证型号/认证/称谓翻译一致 | **A 核心需求** | 是新定位的中心 |
| 术语导入导出 | 从客户资料批量建档 | **A** | 保留 |
| 术语提取（extract） | 从资料自动建档 | **A**（但需要补审核环节） | 现状直接入库，有污染风险 |
| 术语精简/同步 | 控制提示词长度、改译后同步历史 | **B**——有真实价值但复杂 | 简化保留 |
| 项目统计/度量条 | 文档翻译进度 | **E**（对术语库定位无用） | 应让位于「术语数/待审核数」 |
| 存储 Tab | 存储运维 | **E/D**——运维深度功能，不应占一级 Tab | 降级到设置 |
| 「最近与动态」 | 续接上次工作 | **B**——即时场景价值有限 | 建议取消 Tab（见 §5） |
| EPUB 工具（tools/epub-rotate） | 电子书排版 | **D** | 保留为工具 |

---

## 3. 与工作台 / 任务中心 / AI 配置的重复关系

| 重叠点 | 项目模块 | 其他模块 | 结论 |
|---|---|---|---|
| 任务监控 | 详情页 `JobPanel`（轮询/取消/重试/暂停/删除/时间线） | 任务中心 `/operations`（`OperationList`/`OperationCounts` 七宫格/全局 `globalJobTracker`/详情抽屉） | **功能重复**：两处都能看/操作同一批任务。项目详情的任务 Tab 应降级为「本项目任务」的轻量列表或入口，全量监控归任务中心 |
| 快翻/单段翻译 | 单段翻译预览（SegmentTranslationPreviewDrawer） | 工作台即时翻译 | 定位不同（工作流内嵌 vs 即时），保留 |
| 术语注入 | 项目术语经 `project_id` 链路生效（`quick_translate.go:222-235`：requireProjectAccess + `GlossaryEnabled` + `NewDatabaseGlossary` 包 `OverlayGlossary`） | 工作台内联临时术语（`payload.glossary`，`WorkbenchMailAssistant.vue:464-470`） | **不重复、互补**：项目术语走后端 DB，内联术语走请求体；工作台已明确「不重复注入」（`:295` 注释） |
| 提示词模板 | 项目侧无提示词管理 | AI 配置已有三类模板 | 无重复（项目从未有提示词入口）✅ |
| AI 后端配置 | 项目侧无 | AI 配置 | 无重复 ✅ |
| 任务详情抽屉 | 触发 `globalJobTracker` 的全局抽屉 | 任务中心同一抽屉 | 同一组件，天然去重 |

---

## 4. 五类处置建议

### A. 核心保留（服务新定位「客户/产品术语知识库」）

1. 项目 CRUD（保留，话术重定位）。
2. 术语库 CRUD / 启停 / 强制 / 禁译 / 备注 / 适用范围（`glossary_entry` 字段已够用）。
3. 术语 CSV 导入 / 导出（`glossary.go:176-268`，完整可用）。
4. 术语提取（extract 轮 / 后端 `bootstrap` 能力）——**需加审核环节**（见 §6.5）。
5. 项目 `config` JSON（存客户/产品背景信息，字段自由，无需迁移）。
6. 工作台的「关联项目术语表」选择器（已实现：`WorkbenchMailAssistant.vue:82,264-296,1113-1119`）。

### B. 简化保留

1. **术语同步**：功能完整但交互重（556 行抽屉）。建议保留能力、简化为「改译 → 确认受影响段落 → 后台执行」一步式。
2. **术语精简**：保留，但入口从一级按钮降为高级操作（当前 605 行抽屉对轻量用户过重）。
3. **最近打开**：保留数据（本地偏好），但不再独占 Tab（并入列表页顶部「最近使用」横排或排序）。
4. **项目统计**：从「文档进度」改为「术语资产统计」（术语总数/强制数/最近更新），`WorkspaceMetricsBar` 对术语库场景无意义。

### C. 合并到其他模块（只合并入口/职责，不动数据模型）

1. **任务监控 → 任务中心**：项目详情的任务 Tab 保留「本项目任务」视图（按 project 过滤），全局能力以任务中心为准（两处现已共用 `globalJobTracker` 与详情抽屉，重复度可控但导航定位要收敛）。
2. **提示词模板 → AI 配置**：已完成 ✅（无残留动作）。
3. **通用模型配置 → AI 配置**：已完成 ✅。
4. 项目侧不新增任何提示词/后端管理入口（红线）。

### D. 可选能力（保留但降级）

1. 文档上传/解析/批量翻译工作流（resource/segment/job 全链路）——保留为项目内「文档翻译」高级模式或独立入口，**不再作为项目详情页的默认主形态**。
2. EPUB 章节翻译、字幕解析等格式能力——保留。
3. QA 重检、单段修订——保留在工作流内。

### E. 建议移除/降级（需先确认无隐藏依赖）

1. **项目详情默认形态的「文档翻译工作台」包装**：浏览态 Tab 首页从「资源/段落/任务」改为「术语库 + 项目信息」；文档工作流入口后移。
2. **「最近与动态」独立 Tab**：`?tab=recent` 保留兼容重定向，内容并入列表页轻量横排。
3. **WorkspaceMetricsBar（文档进度条）**：术语库定位下无价值，改为术语统计。
4. **存储 Tab 一级入口**：降为项目设置抽屉内的高级项（`ProjectStoragePanel` 能力保留）。
5. （不做）删除任何后端能力——resource/segment/job/QA 管线全部保留，仅前端入口重排。

---

## 5. 建议的新项目模块结构

### 5.1 命名建议

**推荐：「术语库」或「业务知识库」（路由不变 `/projects`，或未来改 `/knowledge` 时加兼容重定向）。**

理由（基于源码事实而非偏好）：
- 现名「翻译项目」（`zh-Hans projects.title='翻译项目'`，subtitle「管理项目的资源、段落、任务与术语表，跟踪整体翻译进度」）把用户预期导向「先建项目才能翻译」，与红线「创建项目不是翻译前置条件」直接冲突；
- 「客户与产品」表达关系但不含「术语」这一核心资产；
- 「术语库 / 业务知识库」准确表达「可选知识资源」定位，且术语库是模块中唯一 A 级高频需求。
- 侧边栏 `nav.projects` 文案建议由「项目」改为「术语库」（导航项保留 1 个）。

### 5.2 页面结构（Phase 1 目标）

```
/ (工作台)  —— 不选项目 = 独立即时模式（现状已满足）
/projects (列表，默认) 
  ├─ 术语资产统计条（术语总数/强制条数/待审核数/最近更新）  ← 新增
  ├─ 「最近使用」横排（从 recent Tab 收编，3~5 个项目 chip）
  ├─ 项目卡片网格：名称 / 语言对 / 术语数+待审核数 / 更新时间  ← 替换任务进度
  └─ 空状态：「去工作台开始翻译」+「创建术语库」双入口  ← 新增
/projects/[projectId] (默认 Tab=术语库)
  ├─ Tab1 术语库（默认）：CRUD/导入导出/筛选/提取任务入口/待审核队列
  ├─ Tab2 提取与审核：候选术语审核 → 入库（新增，见 §6.5）
  ├─ Tab3 项目信息：基本信息/语言对/客户背景(config)/存储(降级)
  └─ Tab4 文档翻译(可选折叠)：现有 Resource/Segment/Job/QA 全量能力原样迁入
/?tab=recent → 301 到 /projects（顶部横排承载）
```

---

## 6. 工作台与项目的联动方案

### 6.1 现状盘点（源码证据）

| 联动点 | 位置 | 行为 |
|---|---|---|
| 项目选择器 | `WorkbenchMailAssistant.vue:1113-1119`（高级选项内 NSelect） | 可不选（默认 null）✅ |
| 术语预览 | `:264-296` watch projectId → `fetchGlossaryEntries(id)`，仅预览强制术语数量 | 不重复注入 |
| 请求携带 | `:464-466` `payload.project_id`（仅选择时） | 后端链路生效 |
| 后端语义 | `quick_translate.go:222-235` | 校验访问权 + `GlossaryEnabled` + 项目 DB 术语包 `OverlayGlossary` |
| 语言方向 | 项目 `source_lang/target_lang` 存在但**工作台未读取** | 现状缺口 |
| 术语更新刷新 | watch projectId 才触发；术语变更无 revision 感知 | 现状缺口 |
| 向项目沉淀术语 | **无** | 缺失 |

### 6.2 方案（分四级）

1. **保持独立可用**（现状已满足，验收项 ✅）：不选项目时 payload 不带 `project_id`，走默认后端回退链（`quick_translate_fallback.go:56-208` 已验证存在）。
2. **提升项目上下文为轻量一级选择**：从「高级选项」上移到工具栏/头部（一个紧凑选择器），选择后明确显示当前项目名 + 一键解除；写入 `preferences`（现有 `quickTranslatePlanId` 同款持久化模式，`stores/preferences.ts:14-91`），**刷新后按现有产品设计恢复**（存最近选择，但项目不存在/无权限时静默清空 + 提示——复用 `requireProjectAccess` 的 404/403 语义）。
3. **上下文注入补齐**：选择项目后
   - 术语：现状已有（后端链路）；
   - **语言方向**（新增，前端读 `project.source_lang/target_lang` 作为源/目标下拉默认值，用户可改，不回写项目）；
   - **客户背景**（新增可选）：`project.config` 中的背景说明注入 instructions（`payload.instructions` 通道已存在，`WorkbenchMailAssistant.vue:468-470`）。
   - 缓存失效：项目术语更新后——用现有 `session generation` / revision watch 模式（参考 `WorkbenchUsagePanel` 的 `stats.revision` watch）重拉 glossary。
4. **沉淀术语（新增）**：
   - 入口：结果区右键/工具条「存为术语」→ 候选行（原文片段+建议译文）→ 选择目标项目 → 冲突检查（`findCachedGlossaryEntry` 语义前移：已有同源术语则提示覆盖/跳过）→ 写入 `POST /projects/{id}/glossary`（现有端点，`service/glossary.go:87`）。
   - **未经用户确认不写入**；批量提取（文档 extract 轮）建议增加 `pending_review` 字段（见 §7）。
   - 切换项目时清空待提交候选，避免串项目（红线：不得将旧项目术语带入新项目）。

### 6.3 术语注入规则（与红线逐条对应）

- 只用启用术语：后端 `DatabaseGlossary` 读取即 `glossary_enabled` 门控（`quick_translate.go:235`）✅；
- 语言方向过滤：现状后端按 project 语言对加载（QuickTranslate 快照），工作台侧无需重复过滤；
- 同义词/冲突：`OverlayGlossary` 已处理（extract 添加时 SkipReasonExists）；
- 不重复注入提示词已有术语：前端仅预览、由后端链路生效（`:295` 注释）✅；
- 大术语库：现状全量加载进 snapshot——**列表页与工作台预览建议加数量上限/虚拟滚动**（Phase 1 评估项，不阻塞）；
- 显示加载状态与数量：已实现（`projectGlossaryLoading`/`mandatoryGlossaryCount`，`:273-298`）。

---

## 7. 数据模型是否需要调整

**结论：Phase 1 零迁移即可落地重定位；仅新增能力需要一次小迁移。**

| 需求 | 现状 | 是否需要改 |
|---|---|---|
| 项目=客户/产品容器 | `project.config` 自由 JSON（`ent/schema/project.go:29`） | ❌ 不需要：背景信息存 config 即可 |
| 术语字段 | source/target/case_sensitive/forbidden/mandatory/notes | ❌ 不需要 |
| 术语适用范围/类别 | 无 category/range 字段（goal §5 提到「类别、适用范围」） | ⚠️ 可选增强：加 `category` string（可空），Phase 2 再议 |
| 候选术语审核队列 | 无 | ✅ 需要新增：`glossary_entry` 加 `review_status`（`approved` 默认 / `pending`），或独立 `glossary_candidate` 表；**推荐前者**（少一张表，`Add` 时默认 approved，extract/工作台提交走 pending） |
| 提取入口审核 | extract 轮直接 `Add`（`runtime_glossary.go:83-109`） | ✅ 上述字段落地后，extract 轮写入 `pending`，列表加「待审核」筛选与批量通过/拒绝 |
| 项目改名 | name 仅显示 | ❌ 不需要 |
| 语言方向默认值 | 工作台未读 | ❌ 前端改动，无迁移 |

兼容性红线核对：prompt 模板与后端解耦 ✅；execution plan 与 project 解耦（无 project 字段）✅；quick-translate payload schema 不需要变更（现有字段已覆盖联动需求）✅。

---

## 8. 数据迁移与兼容性

1. **无破坏性迁移**：`review_status` 新增列使用 ent 自动迁移 + 默认值 `'approved'`（存量术语全部视为已审核，行为不变）；`category` 可空。
2. **旧数据语义**：存量 extract 直接入库的术语视为 approved（与现状一致）；不回溯审核。
3. **本地（IndexedDB）模式**：`gateway/local/repositories/glossary`（routes 侧 `routes/glossary.ts`）需同步 `review_status` 字段（本地 schema 升级版本号 +1，走既有 `infrastructure/indexeddb` 升级管线）。
4. **路由兼容**：`/projects?tab=recent` 保留重定向（复用 `legacy-redirects.ts` 既有模式）；`/projects/[id]` 子路径不变。
5. **回滚**：新列可空/带默认值，前端不发 `review_status` 时后端默认 approved，无回滚风险。

---

## 9. 涉及文件清单（Phase 1~2 预计触碰；**本 Phase 0 未改动任何文件**）

前端：
- `src/pages/projects.vue`、`src/pages/projects/[projectId].vue`（Tab 重排）
- `src/components/projects/ProjectsListPanel.vue`、`ProjectsRecentPanel.vue`（收编）、`ProjectFormDrawer.vue`（话术）
- `src/components/dashboard/WorkbenchMailAssistant.vue`（项目选择器上移、语言方向默认、存术语入口、缓存刷新）
- `src/stores/glossary.ts`、`src/stores/preferences.ts`（quickTranslateProjectId 持久化）
- `src/components/workspace/GlossaryPanel.vue`（待审核筛选/批量操作）、`GlossarySyncDrawer.vue`/`GlossaryPruneDrawer.vue`（入口降级）
- `src/locales/zh-Hans.ts`（projects.* 命名与话术）、`src/router/legacy-redirects.ts`（recent 重定向）
- 本地网关：`src/gateway/local/routes/glossary.ts`、`src/gateway/local/repositories/glossary.ts`（schema 版本）

后端：
- `backend/internal/ent/schema/glossary_entry.go`（review_status/category）
- `backend/internal/service/glossary.go`（Create 输入默认 approved；批量 review 端点）
- `backend/internal/pipeline/extract_handler.go` + `service/runtime_glossary.go`（Add 支持 pending）
- `backend/internal/api/handler_glossary.go`（review 端点）；OpenAPI schema 同步（`api/`）

测试：
- `frontend/tests/unit/*`（store/composable 新断言）、`frontend/tests/e2e/projects*.spec.ts`（Tab 重排后路径更新）、后端 golden（extract 落 pending 的行为变更）。

---

## 10. 分阶段实施计划

| 阶段 | 内容 | 交付判据 |
|---|---|---|
| **Phase 1a（纯前端重排，零迁移）** | 详情页默认 Tab=术语库；文档工作流收进「文档翻译(高级)」Tab；recent 并入列表横排 + 兼容重定向；统计条换术语统计；空态双入口；话术改「术语库」 | type-check/ESLint/Vitest/构建通过；e2e 路径断言更新 |
| **Phase 1b（工作台联动补齐）** | 项目选择器上移 + 持久化 + 失效处理；语言方向默认值注入；config 背景注入 instructions；术语 revision 刷新 | 手动场景：选项目→术语生效/解除→独立模式；刷新恢复 |
| **Phase 2（术语审核队列，唯一数据迁移）** | `review_status` 列 + extract 轮落 pending + 列表待审核筛选 + 批量通过/拒绝 + 工作台「存为术语」候选提交流程 | golden 测试 + 手动审核闭环 |
| **Phase 3（可选）** | 术语 category/适用范围字段、同步/精简交互简化 | 按使用反馈决定 |

每阶段独立可发布；Phase 2 之前不做任何数据迁移。

---

## 附 A：执行方式说明

- 前端 UI/组件/导航/文案：并行子代理逐行盘点（引用行号见 §1）。
- 数据层/API 面/API Store/本地网关/后端模型：并行子代理逐行盘点 + 人工复核（见附录 B）。
- quick-translate 链路、提取/同步/精简服务、ent schema、文档解析器：人工直读核实（引用行号见 §1/§3/§6/§7）。
- 与既有 `plans/browser-first-phase-0-audit.md` 的架构迁移工作流无重叠，本次是**产品功能定位**审计。

---

## 附 B：数据层补充审计（并行子代理 B 报告要点，已交叉核实）

### B1. 前端 API 面与 Store 全景

- `api/projects.ts`（119-937 行）覆盖项目 CRUD + 资源/段落/预览/搜索替换/QA 重检/组织项目全套；`api/glossary.ts` 覆盖术语 CRUD、CSV 导入导出、同步（impact/execute/status/cancel）与精简（prune preview/apply）；`api/jobs.ts` 任务列表/创建/控制/事件；`api/storage.ts`（663 行）存储连接/空间/绑定/导出 artifact 全套；`api/task-history.ts` 处理翻译与术语同步两类历史删除（kind ∈ translation | glossary_sync）与保留策略；`api/operations.ts` 聚合 translation/glossary_sync/storage 三类任务。
- Store 侧：`stores/projects.ts` 带术语开关过滤与**存储代际校验的删除**（删除前要求 `storage_state==='active'` 且 generation 一致，`:59-90`）；`stores/glossary.ts` 含完整同步状态机（syncStep: impact|executing|result|cancelled|error）与批量同步队列，经 `operations.subscribeTask` 共享调度器轮询；`stores/operations.ts`（967 行）是跨项目任务中心；`stores/projectWorkspace.ts` 是 project/resource/segment/job 四 store 的纯门面；`stores/preferences.ts` 纯本地（recentProjects 上限 20 条，`:74`）。

### B2. 本地（浏览器本地 / IndexedDB）模式与服务器模式的差异 ⚠️

本地网关路由表 `gateway/local/routes/index.ts:49-66` 已实现：项目 CRUD（软删+级联）、术语 6 端点（复刻后端条件唯一约束、CSV 与后端逐字节一致）、段落列表/分组/PATCH/批量审核/搜索替换、任务只读+控制（cancel/pause/resume/retry 简化为直接 setJobStatus）、qa-recheck、operations、activity、stats、模板五族、credentials/backends/users、存储仅 1 个端点。

**本地缺失/降级（重定位方案必须知道的差异）**：
- `LocalGateway.upload()` 返回 null（`gateway/local/index.ts:123-125`，注释「Phase 2 接入 OPFS 后再接管」），上传回落原生 XHR；
- SSE `openEventStream` 返回 null（`:127-129`），本地任务进度走轮询；
- 本地缺失端点：翻译/修订预览及其 apply、单段 review、retranslate-rejected、**任务创建 POST /projects/{id}/jobs**、存储域其余端点；
- 本地 `GET /projects/{id}/jobs` 返回裸数组，与 OpenAPI `{items}` 包装不一致（`routes/jobs.ts:51`）——是实现偏差；
- IndexedDB v1 schema 已预建 jobs/job_rounds/work_* 等表（`infrastructure/indexeddb/db.ts:186-193`），属 schema 先行占位，本地无任务执行写入。

### B3. 运行时术语两套实现（对 §6/§7 有直接影响）

- 任务/qa/quick-translate 路径：`DatabaseGlossary` **直写** `glossary_entries`（`service/runtime_glossary.go:83-121`）；
- 单段预览路径：`OverlayGlossary` **只在内存**（`internal/preview/glossary_overlay.go:8-25`），apply 后重跑确定性 QA 时才读 DatabaseGlossary（`segment_translation_preview.go:451`）。
- 含义：术语「直改库」在文档任务与快翻链路立即生效；单段预览里的术语添加不落库——若未来做「从预览沉淀术语」，需要显式走 API 写入。

### B4. projects.config 零消费（佐证 §7）

`project.config` 自由 JSON 是唯一可承载「项目级翻译规则/客户背景」的字段，但后端当前**没有任何键级消费**（无 config[key] 读取；`service/job.go:2074-2084` 的 defaultProjectConfig 只取 source_lang/target_lang）。给工作台注入客户背景时新增一个约定键（如 `config.background`）不会与现有逻辑冲突。

### B5. 数据模型确认（无手写 SQL）

ent schema 自动迁移（`internal/database/migration.go`，WithMigrationLock），`backend/internal/migration/` 是 JSON 数据升级器（v013/v015），非建表 SQL——§8 的「新增列走 ent 自动迁移」结论成立。`glossary_entries` 条件唯一约束：非禁译 `(project_id, source_key)` 唯一、禁译 `(project_id, source_key, target)` 唯一（`glossary_entry.go:34-44`）。
