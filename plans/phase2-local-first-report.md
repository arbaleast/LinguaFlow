# LinguaFlow 浏览器优先架构迁移 — Phase 2 交付报告

> 范围：**Local-first 本地存储层**（IndexedDB / Dexie + OPFS + AES-GCM 凭据保险库）+
> **LocalGateway CRUD / 查询闭环** + **全量备份导出与恢复**。
> 上游：Phase 1（`plans/phase1-domain-port-report.md`）已完成 `frontend/src/domain/` 纯 TS 领域层
> 与 `frontend/src/gateway/` 双轨接缝。

---

## 一、架构总览

```
frontend/src/api/*.ts              ← 调用形状完全不变（Store / 组件零改动）
        │
        ▼
frontend/src/api/client-core.ts    ← apiClient 代理：先问网关，未接管即回落 openapi-fetch
        │
        ▼
frontend/src/gateway/index.ts      ← setGatewayMode('browser-local' | 'local' | 'server')
        │
        ├─ remote/  → 既有 openapi-fetch / raw XHR / EventSource（零回归）
        └─ local/   → LocalGateway
                      ├─ /ping、/mode、/auth/capabilities  ← 直接应答
                      └─ 81 条本地路由 → Repository → Infrastructure
                                             ├─ infrastructure/indexeddb/  (Dexie，32 张表)
                                             ├─ infrastructure/opfs/       (OPFS + raw_blobs 降级)
                                             └─ infrastructure/crypto/      (AES-GCM-256 保险库)
```

**关键不变式**：既有 30+ Pinia Store 与 Vue 组件**一行未改**；
所有新能力都通过 `src/api/` 层的网关分发接入。

---

## 二、IndexedDB 表定义（32 张，Dexie `version(1)`）

文件：`frontend/src/infrastructure/indexeddb/db.ts:154`

```ts
this.version(1).stores({
  // 核心业务域
  projects:            'id, localId, name, updatedAt, deletedAt, storage_space_id',
  resources:           'id, localId, project_id, [project_id+path], format, updatedAt, deletedAt',
  source_revisions:    'id, localId, resource_id, [resource_id+current], updatedAt, deletedAt',
  segments:            'id, localId, resource_id, project_id, [resource_id+segment_index], status, content_version, group_key, updatedAt, deletedAt',
  segment_revisions:   'id, segment_id, resource_id, project_id, operation_id, kind, updatedAt',
  glossary_entries:    'id, localId, project_id, [project_id+source_key], source, target, forbidden, updatedAt, deletedAt',
  tm_entries:          'id, localId, project_id, [project_id+source_hash], source_hash, usage_count, updatedAt, deletedAt',

  // 配置与凭据域
  translation_prompt_templates: 'id, localId, name, scope, owner_user_id, builtin_id, updatedAt, deletedAt',
  bootstrap_prompt_templates:   'id, localId, name, scope, owner_user_id, builtin_id, updatedAt, deletedAt',
  prune_prompt_templates:       'id, localId, name, scope, owner_user_id, builtin_id, updatedAt, deletedAt',
  execution_plan_templates:     'id, localId, name, scope, owner_user_id, builtin_id, profile_id, updatedAt, deletedAt',
  execution_profiles:           'id, localId, name, scope, owner_user_id, builtin_id, updatedAt, deletedAt',
  backends:                     'id, localId, name, backend_type, credential_id, enabled, updatedAt, deletedAt',
  credential_vault:             'id, localId, name, provider, revoked, updatedAt, deletedAt',

  // 任务与状态域
  jobs:              'id, localId, project_id, status, updatedAt, deletedAt',
  job_resources:     'id, job_id, resource_id, status, updatedAt',
  job_rounds:        'id, [job_id+resource_id+round_index], job_id, resource_id, status',
  job_round_segments:'id, [job_round_id+segment_id], job_round_id, segment_id, commit_id',
  work_items:        'id, job_id, state, next_attempt_at, updatedAt',
  work_candidates:   'id, identity, work_item_id, state, updatedAt',
  work_requests:     'id, identity, state, updatedAt',
  job_events:        'id, [job_id+seq], job_id, seq, created_at',

  // 存储与统计域
  storage_tasks:   'id, project_id, kind, status, idempotency_key, updatedAt',
  export_artifacts:'id, resource_id, project_id, status, updatedAt',
  blobs:           'id, localId, project_id, purpose, status, sha256, updatedAt, deletedAt',
  usage_records:   'id, project_id, createdAt, updatedAt',
  activity_logs:   'id, createdAt, action, resource_type, updatedAt',

  // 基础设施表
  kv_meta:     'key',
  preferences: '[scope+key]',
  raw_blobs:   'key',
  sequences:   'name',
})
```

### 2.0 表覆盖核对

任务书要求的 **28 张核心表全部落库**（`projects` / `resources` / `source_revisions` /
`segments` / `segment_revisions` / `glossary_entries` / `tm_entries` /
`translation_prompt_templates` / `bootstrap_prompt_templates` / `prune_prompt_templates` /
`execution_plan_templates` / `execution_profiles` / `backends` / `credential_vault` /
`jobs` / `job_resources` / `job_rounds` / `job_round_segments` / `work_items` /
`work_candidates` / `work_requests` / `job_events` / `storage_tasks` / `export_artifacts` /
`blobs` / `usage_records` / `activity_logs` / `kv_meta`），
另有 4 张基础设施表（`preferences` / `raw_blobs` / `sequences`），合计 **32 张**。

### 2.1 统一元字段

所有业务行继承 `BaseRow extends SyncMeta`
（`frontend/src/infrastructure/indexeddb/types.ts:22`）：

| 字段 | 含义 |
|---|---|
| `id` | UUID 主键 |
| `localId` | 对外暴露的数字 ID（复刻后端自增 ID 语义） |
| `createdAt` / `updatedAt` | ISO8601 时间 |
| `revision` | 单调递增版本号（每次写入 +1，替代 `ent.ContentVersion` 的 CAS 语义） |
| `deletedAt` | 软删墓碑（非空表示待云同步确认） |
| `deviceId` | 最后写入设备标识（多端冲突裁决用） |
| `dirty` | 是否存在待推送的本地变更（outbox 标记） |

| 索引 | 用途 |
|---|---|
| `[resource_id+segment_index]` | 段落窗口分页的主路径：按资源 + 序号有序扫描，**支持 `cursor` / `desc` / `anchor`** |
| `[project_id+source_key]` | 术语表非禁译项唯一约束（`[projectId+sourceKey]`） |
| `[project_id+source_hash]` | 翻译记忆精确匹配（`fullHash(trim(src))`） |
| `[project_id+path]` | 资源树按路径查找 |
| `[job_id+seq]` | 任务事件按序号分页（与后端 `before_seq/after_seq` 一致） |
| `[job_id+resource_id+round_index]` | 任务轮次定位 |
| `[job_round_id+segment_id]` | 轮次内段落关联 |
| `[scope+key]` / `key` / `name` | 偏好 / KV / 序列 |

### 2.2 元数据与大文件二进制严格分离

- **IndexedDB**：只存结构化元数据、配置与分段文本（`segments`）。
  业务表行内**不存在** `ArrayBuffer` / `Blob` 字段。
- **OPFS**（`frontend/src/infrastructure/opfs/opfs.ts`）：复刻后端
  `objects/<spaceIdentity>/<projectId>/<uuid>` 与 `tmp/<writeId>/` 布局，
  candidate → live **原子落位**（先写 `tmp/`，再 rename 到 `objects/`）。
- **降级**：不支持 OPFS 时回退到独立的 `raw_blobs` 表（与元数据表物理隔离，按 key 懒加载），
  见 `frontend/src/infrastructure/opfs/idb.ts` 与 `memory.ts`（测试用内存实现）。

### 2.3 配额与持久化

`frontend/src/infrastructure/indexeddb/quota.ts`：

- `navigator.storage.persist()` 申请持久化存储权限；
- `navigator.storage.estimate()` 封装为配额查询；
- 沿用既有预算常量：**单文件 80MB / 单条目 16MB / 总解压 120MB / 8000 条目**；
- `QuotaExceededError` → 结构化前端错误（`RepositoryValidationError` 家族）。

---

## 三、`segments` 窗口分页实现说明

文件：`frontend/src/gateway/local/repositories/segments.ts:1`（1,451 行）

后端对齐目标：`frontend/src/stores/segment.ts:206-416` + `frontend/src/api/projects.ts:519`。

| 参数 | 语义 |
|---|---|
| `cursor` | 上一次响应的 `next_cursor`（**段落 index**，字符串形态） |
| `direction=desc` | 向下滚动窗口（取 `index < cursor` 的紧邻一页） |
| `anchor` | 锚点开窗：`index >= anchorIndex`，**锚点本身不要求满足过滤条件** |
| `include_total` | 独立计数（不受窗口影响） |
| `group_key` | EPUB 章节分组过滤 |
| `status` / `qualityIssues` / `qualitySeverity` / `qualityCode` | 三维 AND 过滤，`dismissed` 问题不计入「有问题」 |
| `search` | 复用 `frontend/src/domain/search/`（`re2js`，**不写任何 JS 原生正则**） |

实现要点：

1. **统一扫描**：取资源内全部未删除段落 → 按 `(segment_index, localId)` 升序
   （等价 SQL `ORDER BY segment_index, id`）→ 用完整过滤条件 F 过滤 → 在**匹配序列**上取窗口。
   与 Go 的 SQL 路径 / 扫描路径等价。
2. **limit+1 边界重复检测**：升序取 `limit+1` 条，若第 `limit+1` 行与页尾同 index →
   `DuplicateSegmentIndexError`（409 `duplicate_segment_index`，消息逐字照 Go）；
   降序窗口同理（丢弃行与页首行比较）。**绝不静默返回不完整页**。
3. **desc 窗口**：不真倒序，取 `below.slice(-(limit+1)).slice(-limit)`，结果天然升序，
   等价 Go「DESC limit+1 → 截断 → reverse」，响应 items 恒升序。
4. **邻接游标存在性判断**：用完整 F 在全量匹配序列上判断，缺失为 `null`。
5. **CAS**：`Segment.content_version` 单调递增；`PATCH` 支持 `expected_content_version`，
   不匹配 → 409 `ConflictError` 且**整个事务回滚**；每写事务同时推进
   `Resource.translation_generation` 与 `Project.output_generation`。
6. **search-replace 三段式**：`preview`（只读统计）→ `apply`（单事务替换 + 写 `segment_revisions`）
   → `undo`（按 `operationId` **逐字节还原**并写反向历史，可再撤销）。
   apply/undo 各自一个 Dexie 事务。

---

## 四、LocalGateway 路由（81 条）

| 分组 | 文件 | 端点数 |
|---|---|---|
| 项目 | `routes/projects.ts` | 5 |
| 项目存储快照 | `routes/storage.ts` | 1 |
| 资源 | `routes/resources.ts` | 6（含 2 条下载） |
| 段落 | `routes/segments.ts` | 9 |
| 术语表 | `routes/glossary.ts` | 5（含 CSV 导入） |
| QA 重检 | `routes/qa_recheck.ts` | 1 |
| 提示词模板 / 执行配置 | `routes/templates.ts` | 13 |
| 凭据 / AI 后端 | `routes/credentials.ts` | 6 |
| 任务 / 统计 / 活动 | `routes/jobs.ts` | 12 |
| 操作投影 | `routes/operations.ts` | 3 |
| 用户 | `routes/users.ts` | 4 |
| **合计** | `routes/index.ts` | **81** |

未接管（回落远端）的端点共 **3 类**（`/ping`、`/mode`、`/auth/capabilities` 由网关直接应答）：

- **上传事件流**与**任务计算执行**（LLM 调用）——浏览器本地不提供；
- `/admin/*`、`/orgs/*`——单用户本地模式无多租户；
- Provider / 模型发现（`POST /backends/models`）——需外网。

**本地默认存储空间自动就绪**：`GET /projects/{projectId}/storage` 返回
`deployment_enabled=true`、`maintenance=false`、`storage_state=active`、
`binding.scope='user'`，因此 `stores/projectWorkspace.ts` 的 `prepareStorageWrite`
在本地模式下顺畅通过（不再返回 409 `storage_unavailable`）。

---

## 五、凭据保险库（Web Crypto AES-GCM-256）

文件：`frontend/src/infrastructure/crypto/vault.ts:1`

- API Key **绝不以明文落 IndexedDB**，也**永不回读 UI**（write-only）；
- 派生密钥：PBKDF2-HMAC-SHA-256（salt 16B，迭代 210,000 次）；
- 加密：AES-GCM-256（IV 12B，AAD 绑定凭据 id / provider）；
- `credential_vault` 表只存密文、salt、iv、算法标识与版本号；
- 吊销（`revoke`）只改 `revoked` 标志，密文仍在（不做静默销毁）。

---

## 六、全量备份导出与恢复

目录：`frontend/src/application/backup/`（生产 779 行 + 测试 297 行）

| 文件 | 行数 | 说明 |
|---|---|---|
| `types.ts` | 143 | `BackupManifest` / `BackupBundle` / `BackupError`（`invalid_format`、`unsupported_format_version`、`schema_version_mismatch`、`missing_passphrase`、`invalid_passphrase`、`corrupt_payload`、`unsupported_operation`） |
| `zip.ts` | 263 | **零依赖** ZIP 读写：CRC-32、STORE 与 raw DEFLATE（`CompressionStream`）、跳过目录项、不支持 ZIP64 / 加密包 |
| `export.ts` | 204 | `exportBackup` / `exportBackupZip`；凭据单独加密（PBKDF2 → AES-GCM-256） |
| `import.ts` | 161 | `importBackup` / `importBackupZip` / `clearLocalData` |
| `index.ts` | 8 | 聚合出口 |

语义：

- **默认导出**包含全部业务表行，但**排除** `credential_vault` 与 `raw_blobs`，
  manifest 记 `credentialVault: 'skipped'` / `blobs: 'skipped'`；
- `includeSecrets: true` **必须**提供口令；凭据行单独加密，manifest 记 `credentialVault: 'encrypted'`；
- `includeBlobs: true` 才会内联 `raw_blobs`；
- ZIP 布局：`manifest.json` + `data/<table>.json` +（可选）`credential_vault.json`；
- **恢复**：格式标识 / 备份版本 / `schemaVersion` 三重校验；
  凭据解密在事务外完成；写入在**单个** `db.transaction('rw', db.tables, …)` 中，
  任一表失败即**整库回滚**；`replace` 默认 `true`（整库替换），`false` 为按主键合并；
  不含凭据的备份保留目标库既有 `credential_vault` 并在结果中报告跳过。

---

## 七、黄金测试向量（Phase 1 机制延续）

新增 `search`（`backend/internal/service/segmatch`）与 `fold-table`（`backend/cmd/foldtable`）。

| 黄金向量文件 | 用例数 | Op 数 |
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
| `search.json` | 482 | 4 |
| **合计** | **1,836** | **157** |

一键重新生成：

```bash
bash scripts/gen-golden-vectors.sh          # 13 个包 + SimpleFold 折叠环表
bash scripts/gen-golden-vectors.sh prompt   # 单包
```

> `search` 的 482 条向量锁定 Go `segmatch` 的**字节 → 码点偏移换算**、
> `unicode.SimpleFold` 折叠环（K/kelvin、S/ſ、ß/ẞ、µ/Μ/μ、Ω/ω、Σ/σ/ς 等）、
> RE2 的空匹配与整词语义、以及 `$1` 展开规则。

---

## 八、新增 / 修改文件清单与行数统计

### 8.1 新增：基础设施 `frontend/src/infrastructure/`（生产 2,033 / 测试 577）

| 文件 | 行数 |
|---|---|
| `indexeddb/db.ts` | 238 |
| `indexeddb/types.ts` | 461 |
| `indexeddb/seed.ts` | 209 |
| `indexeddb/repo.ts` | 167 |
| `indexeddb/quota.ts` | 118 |
| `indexeddb/index.ts` | 8 |
| `opfs/opfs.ts` | 211 |
| `opfs/idb.ts` | 112 |
| `opfs/memory.ts` | 125 |
| `opfs/types.ts` | 86 |
| `opfs/index.ts` | 52 |
| `crypto/vault.ts` | 246 |
| `indexeddb/__tests__/indexeddb.test.ts` | 279 |
| `opfs/__tests__/opfs.test.ts` | 158 |
| `crypto/__tests__/vault.test.ts` | 140 |

### 8.2 新增：备份 `frontend/src/application/backup/`（生产 779 / 测试 297）

见 §六。

### 8.3 新增：本地网关 `frontend/src/gateway/local/`（生产 6,512 / 测试 3,593）

Repository 14 个文件（`projects` / `resources` / `segments` / `glossary` / `tm` /
`templates` / `credentials` / `backends` / `jobs` / `operations` / `qa_recheck` /
`storage` / `errors` / `order`）、Route 12 个文件、Router / responses / errors 基础件，
以及 9 个测试文件（`projects` 9 / `resources` 9 / `segments` 37 / `glossary` 16 /
`tm` 10 / `credentials` 16 / `operations` 11 / `qa_recheck` 8 / `storage` 4 /
`routes` 8）。

### 8.4 新增：领域层补充 `frontend/src/domain/search/`（1,215）

| 文件 | 行数 | 说明 |
|---|---|---|
| `matcher.ts` | 855 | `createSearchMatcher` / `literalPrefix` / `replaceAll`（Go `segmatch` 1:1） |
| `fold-table.ts` | 285 | `unicode.SimpleFold` 折叠环代表元表（**由 `backend/cmd/foldtable` 生成**） |
| `types.ts` | 69 | `SearchOptions` / `SearchMatcher` / `SearchMatch` |
| `index.ts` | 6 | 聚合出口 |

### 8.5 修改的既有文件（**仅 6 个既有前端文件 + 2 个既有测试文件**）

| 文件 | 改动 |
|---|---|
| `frontend/src/api/client-core.ts` | `apiClient` 代理增加网关分发 |
| `frontend/src/api/bootstrap-service.ts` | `ServiceMode` 含 `'browser-local'`；能力探测与模式切换 |
| `frontend/src/api/system.ts` | `fetchMode` 成功后同步网关模式 |
| `frontend/src/api/projects.ts` | 上传通道增加网关分发 |
| `frontend/src/api/auth-contract.ts` | `isAuthCapabilities` 接受 `'browser-local'` |
| `frontend/src/composables/sseShared.ts` | 网关不支持事件流时 `resolveStreamUrl` 返回 `null` |
| `frontend/src/api/__tests__/gateway-seam.test.ts` | 回落到远端的样例端点由 `/activity` 改为 `/storage/capabilities`（`/activity` 在 Phase 2 已被本地接管） |
| `frontend/src/gateway/local/__tests__/routes.test.ts` | 路由聚合期望列表同步到 81 条 |

> **Pinia Store 与 Vue 组件：0 处改动。**

### 8.6 后端

| 文件 | 行数 | 说明 |
|---|---|---|
| `backend/internal/service/segmatch/golden_vectors_test.go` | 526 | `search` 黄金向量导出器 |
| `backend/cmd/foldtable/main.go` | 105 | `SimpleFold` 折叠环表生成器 |

后端**生产代码 0 处改动**。

---

## 九、验证证据

### 9.0 Vitest 新增本地存储测试用例清单

| 测试文件 | 用例数 | 覆盖点 |
|---|---|---|
| `infrastructure/indexeddb/__tests__/indexeddb.test.ts` | 9 | **内置种子初始化**（首次写入 3 模板 + 1 策略、`scope='system'`、`builtin_id=-1`、内容含「你是 LinguaFlow」、重复初始化幂等 `unchanged=4`、策略配置完整）、revision CAS、冲突错误 |
| `infrastructure/opfs/__tests__/opfs.test.ts` | 6 | `objects/<spaceIdentity>/<projectId>/<uuid>` 与 `tmp/<writeId>/` 布局、candidate → live 原子落位、降级到 `raw_blobs` |
| `infrastructure/crypto/__tests__/vault.test.ts` | 12 | **凭据 WebCrypto 加密落盘**：表内只有密文、base64 往返、解密还原、随机 nonce、主密钥不可导出与持久化复用、版本推进、吊销拒解密、密文篡改失败、`crypto.subtle` 缺失时绝不退回明文 |
| `application/backup/__tests__/backup.test.ts` | 14 | **数据导出与恢复**：导出计数、默认排除凭据与 blob、口令必填、凭据密文载荷、整库替换、按主键合并、往返还原、schema / 格式版本拒绝、凭据保留、口令正确 / 错误 / 缺失、ZIP 往返与布局、损坏 ZIP 处理 |
| `gateway/local/__tests__/segments.test.ts` | 37 | **段落 cursor / anchor 双向分页**（升序首页、cursor 续页、desc 窗口、desc 无游标回落、anchor 开窗、anchor 章节不匹配 / 不存在、limit+1 重复 409、desc 重复 409、同页重复不报错、空页与 limit 非法回落、状态与质量三维过滤、搜索大小写 / 整词 / regex / search_field、group_key + 邻接游标、章节分组）、CAS 与代际、批量审校、QA disposition、**search-replace + undo 事务** |
| `gateway/local/__tests__/glossary.test.ts` | 16 | **术语条件唯一约束**（非禁译 `[projectId+sourceKey]`、禁译 `[projectId+sourceKey+target]`、大小写 / 空白归一、并发创建只有一个成功）、CSV 导出 |
| `gateway/local/__tests__/tm.test.ts` | 10 | TM 精确匹配、`source_hash`、usage 计数排序 |
| `gateway/local/__tests__/projects.test.ts` | 9 | 项目 CRUD、默认值、代际递增、软删墓碑、DTO 逐字段对齐 |
| `gateway/local/__tests__/resources.test.ts` | 9 | 资源树、按路径查找、代际递增 |
| `gateway/local/__tests__/credentials.test.ts` | 16 | 后端 CRUD、凭据密文写入 / 版本 / 吊销 |
| `gateway/local/__tests__/operations.test.ts` | 11 | `/operations` 投影、`/operations/summary` 四类计数、batch-delete 结果、术语 CSV 导入 |
| `gateway/local/__tests__/qa_recheck.test.ts` | 8 | QA 重检：profile 缺失 / 禁用 / 非法、段落过滤、空译文跳过、新增 / 清除问题、继承 `dismissed` 裁决 |
| `gateway/local/__tests__/storage.test.ts` | 4 | **本地默认 Storage Space 自动就绪**（`deployment_enabled=true`、`maintenance=false`、退休两阶段不可用、binding 指向本地空间）、404 / 400 |
| `gateway/local/__tests__/routes.test.ts` | 8 | **81 条路由聚合表**与 schema path 逐字一致 |
| `gateway/__tests__/gateway.test.ts` | 10 | 网关模式切换、`/ping` / `/mode` / `/auth/capabilities` 本地应答、未接管端点回落、事件流能力位 |

**合计：115 个测试文件 / 1641 个用例全部通过。**

### 9.1 前端全量 Vitest（115 个测试文件 / 1641 个用例）

```
$ cd frontend && TMPDIR=…/.tooling/tmp/node npx vitest run
 Test Files  115 passed (115)
      Tests  1641 passed (1641)
   Duration  7.09s
```

### 9.2 类型检查

```
$ cd frontend && TMPDIR=…/.tooling/tmp/node npx vue-tsc --build
（无输出，exit 0）
```

### 9.3 后端全量测试

```
$ cd backend && source ../.tooling/goenv.sh && go test ./...
（61 个包全部 ok，0 FAIL，exit 0）
```

### 9.4 黄金向量重新生成

```
$ bash scripts/gen-golden-vectors.sh
==> 导出黄金向量: internal/hash           … 17 条
==> 导出黄金向量: internal/protect        … 81 条
==> 导出黄金向量: internal/pipeline       … 69 条
==> 导出黄金向量: internal/repair         … 179 条
==> 导出黄金向量: internal/ruby          … 133 条
==> 导出黄金向量: internal/markup         … 76 条
==> 导出黄金向量: internal/correct        … 74 条
==> 导出黄金向量: internal/glossary       … 114 条
==> 导出黄金向量: internal/tm             … 40 条
==> 导出黄金向量: internal/script         … 98 条
==> 导出黄金向量: internal/qa             … 424 条
==> 导出黄金向量: internal/prompt         … 49 条
==> 导出黄金向量: internal/service/segmatch … 482 条
==> 导出 SimpleFold 折叠环表
折叠环表已导出 → …/frontend/src/domain/search/fold-table.ts（2994 个码点）
```

### 9.5 证据日志

| 文件 | 内容 |
|---|---|
| `plans/phase2-verification/vitest-full.log` | 前端全量 Vitest（115 files / 1641 tests） |
| `plans/phase2-verification/type-check.log` | `vue-tsc --build`（0 字节 = 无 diagnostics，exit 0） |
| `plans/phase2-verification/pnpm-type-check.log` | `pnpm type-check`（权威命令，exit 0） |
| `plans/phase2-verification/go-full-tests.log` | 后端 `go test ./...`（61 包 ok，0 FAIL） |
| `plans/phase2-verification/golden-regen.log` | 13 个包的黄金向量重新生成 |

> **环境提示**：宿主 `/tmp` 是已满的 256M tmpfs。
> 前端命令必须带 `TMPDIR=<repo>/.tooling/tmp/node`，
> 后端命令必须先 `source .tooling/goenv.sh`（其中已导出 `TMPDIR` 与 `GOTMPDIR`）。

---

## 十、遗留与下一阶段

| 项 | 说明 |
|---|---|
| 上传与事件流 | `LocalGateway.upload()` / `openEventStream()` 仍回落远端（OPFS 写入与 BroadcastChannel 事件总线属 Phase 3） |
| 任务计算执行 | 浏览器本地不执行翻译任务（需 LLM），`jobs` 仅做查询投影 |
| `/operations` 投影 | 本地以 `jobs` → `translation`、`storage_tasks` → `storage` 投影；`glossary_sync` / `storage_retirement` 本地无实体，返回 `not_found` |
| `batch-delete` 幂等 | 尚未拒绝重复 `(kind,id,project_id)` 引用；单条目异常未降级为 `failed` |
| 术语 CSV 导入行号 | 跳过条目报告的是**解析后条目序号**，非原始 CSV 行号 |
| 译文字段下载 | 译文下载沿用 `${opfs_path}.translated` 约定，尚未与导出器逐字对齐 |
| 后端并发测试偶发失败 | `TestOrganizationTransactionRetriesRespectContext` 在全量并行跑时偶发 `SQLSTATE 55P03`（Postgres 锁超时），单独重跑通过；与本阶段改动无关（未触碰 `internal/service`） |
