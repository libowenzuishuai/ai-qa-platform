# 阶段二 A：资料、解析作业与审阅工作台

日期：2026-09-18｜负责人：李博闻

## 交付范围

已实现上传 → 文档版本登记 → DOCUMENT_PARSE 作业 → Python 解析 → 来源片段及解析文件落库；澄清回答 → 规则批准/驳回 → 用例草稿生成接线；最小资料、规则、用例和作业页面。

真实 Python 文档解析已联调。规则/用例正式算法仍由李琦双开发；本次用严格登记、只允许 mock 的测试替身验证这两个接口的协议和平台落库，不冒充正式算法效果。

## 页面与 API

从项目运行页面进入“资料与测试审阅工作台”：`/projects/:id/review`。

| 接口 | 权限与用途 |
|---|---|
| POST /api/projects/:id/documents | LEAD，multipart 上传；202 返回 jobId，同参数重复返回原 jobId |
| GET /api/projects/:id/documents | VIEWER，资料及版本、解析状态、覆盖统计、警告 |
| GET /api/document-versions/:id | VIEWER，校验后读取原文片段，跨项目禁止访问 |
| GET /api/projects/:id/review | VIEWER，规则、澄清、用例与最近作业 |
| POST /api/clarifications/:id/resolve | LEAD，answer + answerSource，记录回答人和时间 |
| POST /api/rule-versions/:id/approve | LEAD，须已解决澄清并完成冲突取舍 |
| POST /api/rule-versions/:id/reject | LEAD，驳回尚未批准的草稿 |
| POST /api/projects/:id/rule-extractions | LEAD，只接已解析的项目内文档版本 |
| POST /api/projects/:id/case-generations | LEAD，只接已批准规则，禁止混入未确认澄清 |
| GET /api/jobs/:id | VIEWER，包含明确 mode、状态、结果和失败原因 |
| POST /api/jobs/:id/retry | LEAD，显式重试失败作业 |

上传包含一个 `file` 和 `metadata` JSON 字符串；也支持同名普通表单字段。元数据包括 title、declaredFormat、fileSizeBytes、mode；可选 documentId 用于追加版本。省略 mode 按契约为 mock；工作台默认选择真实解析。真实文字解析不调用模型，图片视觉按所选模式调用共享网关。

## 数据与恢复

- 实际文件大小校验，20 MB 上限，服务端计算 SHA-256；上传文件名不作为存储路径。
- 先保存唯一源文件，再事务登记文档、版本、作业和审计；失败时清理可确认未登记的文件。进程在登记前崩溃可能留下不可见孤儿文件，尚未建设全局垃圾回收。
- DOCUMENT_PARSE 沿用作业补投、心跳、失联失败和显式重试。失联时文档也进入 FAILED；重试重置为 PENDING。
- 解析输出再次校验版本、格式、引用、唯一 ID、图片路径与覆盖统计。
- 每个租约写独立 `bundles/<documentVersionId>/bundle-<uuid>.json`。数据库中的 bundleStorageKey/checksum 是权威发布指针；不再覆盖固定 bundle.json，避免旧执行覆盖新产物。
- 来源片段、文档状态、解析文件引用和作业成功在同一事务提交。数据库回滚不得留下可用假成功；提交结果不确定时优先保留文件，防止误删已提交资产。
- 旧种子/参考数据暂兼容固定 bundle.json；新上传产物必须有登记指针和校验和。
- NEEDS_OCR 对应作业 SUCCEEDED、文档 NEEDS_OCR，下游提取拒绝。坏文件对应作业和文档 FAILED。

## 审阅规则

- 回答必须有正文及来源；同一回答重复提交幂等，已确认回答不能覆盖。语义变更通过新文档/规则版本处理。
- 审阅操作按项目事务锁串行；未解决澄清不能批准，冲突双方不能同时批准，批准和审计共同提交。
- 用例生成只传选定规则相关、已确认的澄清；来源中规则 ID 缩小到实际选定集合。无已确认业务角色时失败，不默认虚构 applicant。
- 新规则/用例登记 generationMode；迁移仅从已有成功作业回填可信模式。无法核验的历史模型产物保留未知，不能进入真实用例生成。
- 新上传文档记录 mode；历史文档默认 unknown。模拟或模式未知的图片转录不能用于真实规则提取。
- 用例仍是 DRAFT。该页面没有绕过绑定和 acceptanceHash 的直接批准/运行入口。

## 启动与升级

先更新依赖并生成 Prisma 客户端，再对目标开发数据库执行新增迁移 `20260918160000_document_parse_assets`。本轮只在独立临时数据库验证迁移，没有重置或迁移日常开发库。

```sh
pnpm install --frozen-lockfile
pnpm --filter @ai-qa/api db:generate
pnpm db:migrate
```

API、worker、Python 必须读取同一个证据根目录。本机启动时使用绝对路径：

```sh
export AIQA_ARTIFACT_DIR="$PWD/data/artifacts"
export AIQA_INTELLIGENCE_URL="http://127.0.0.1:7500"
export AIQA_INTELLIGENCE_TOKEN="自行配置的内部服务令牌"
```

数据库、Redis、会话与真实模型凭据沿用本机私有配置，不写入仓库。分别启动 API、worker、web 和 `pnpm dev:intelligence`。

文档解析始终调用 Python，不受兼容模式 reference 影响。正式规则/用例管线默认 `AIQA_INTELLIGENCE_BACKEND=python`，当前使用 `agents-v2` 提示词。reference 保留为显式兼容模式；Python 不可用或输出无效时不会回退。A 已将平台联调中的 C 模块替身替换为正式管线，只有模型响应 mock；真实 Kimi 小样独立验收，见 [合并记录](reviews/python-agents-2026-09-20.md)。

## 验收与限制

隔离集成测试：`pnpm --filter @ai-qa/worker exec vitest run test/platform-flow.test.ts`。

该测试创建临时 PostgreSQL 数据库、独立 Redis 容器、动态本机端口和临时证据目录，运行真实 API、BullMQ Worker、Python HTTP 服务、web 与 Chromium，结束后清理。C 的测试替身位于 `services/intelligence/tests/platform_fixture.py`，不进入生产服务。

覆盖上传权限/大小/跨项目、并发幂等、追加版本、来源落库、澄清批准、模拟隔离、真实页面上传与转义、扫描页、失联旧租约、产物篡改、数据库回滚及重试。

仍未完成：C 正式算法及真实 Kimi 端到端质量验收；业务用例到执行计划的现场绑定；完整用例编辑/批准流程；生产规模分页、孤儿文件回收、容器运行验证。这些不计入本次 A 接线验收。

### 本轮实际验证结果

- API：48/48；worker：30/30，其中新增平台全链路 12 项。
- 公共契约：131/131；Python：64/64。合计 273 项通过。
- 类型检查、工作区构建、TS JSON Schema 与 Python 类型生成物漂移检查均通过。
- 新迁移经空白临时库 migrate deploy 验证；事务回滚、旧租约拒绝发布、Redis 入队失败补投均真实复现。
- 浏览器实际上传文件、查看审阅页/来源与作业状态；新增用户文字均转义。
- 修复原作业查询接口直接用 Date 对象校验 ISO 字符串而导致进度页面报错的问题。
- 没有调用付费模型；没有对日常开发库执行迁移或重置。Python 测试工具存在弃用提示，未影响通过结果。
