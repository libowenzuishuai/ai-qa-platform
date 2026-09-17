# 实施状态

更新日期：2026-09-17 · 当前阶段：**阶段 1 完成（固定用例真实浏览器执行闭环，53 项集成验收全通过）**

按 docs/ai-qa/03-GLM开发提示词.md 的分阶段任务推进。本文件只记录有真实
运行证据的完成项；未执行的项目明确标注。

## 阶段 1：固定用例真实浏览器执行闭环 ✅

用户登录平台 → 选择环境/基线/固定用例 → 开始测试 → Redis/BullMQ 调度 worker →
Playwright 真实浏览器执行（七动作、角色隔离、命名空间数据隔离）→ 持久化步骤/
断言/截图/trace → SSE 实时进度 → 报告（FR-10 严格验收）与证据下载。

### 实现清单

| 模块 | 内容 |
|---|---|
| packages/test-runtime | 受限执行器：goto/fill/click/select/switchRole/captureValue/waitFor/assert；导航/子资源/弹窗发出前 origin 拦截；凭据仅执行时注入；WRITE 后不稳定 → UNCERTAIN_SIDE_EFFECT 不重试；预算/取消可中断；断言机器判定（金额最小单位） |
| packages/evaluation | 确定性聚合（§5.2/FR-10）：FAIL 优先保留、BLOCKED 带原因码、REVIEW（证据缺失/空断言）、NOT_RUN、严格验收、分母零 N/A |
| packages/artifact-store | 证据落盘：受控目录、sha256、防目录穿越；NORMAL/RESTRICTED_RAW |
| apps/worker | BullMQ 消费（runs + seed）；运行处理（认领幂等、attempt 唯一约束、命名空间预/后清理、心跳）；固定资产种子（真实浏览器观察 → 证据 → 绑定/规则/用例/基线，项目前缀 ID 幂等）；对账（QUEUED 重投、租约超时 → ERROR） |
| apps/api | POST /api/runs（repository 校验：同项目引用闭合、APPROVED+计划+verifyStoredPlan、幂等键 200/409、快照固化）；GET 运行详情/列表；SSE（Last-Event-ID 重放，RunEvent 持久化）；幂等取消；报告（证据存在性复核降级、trace 用例级暴露、N/A 指标）；证据下载（项目鉴权、RESTRICTED_RAW 需 LEAD、404 不伪造）；资产查询/种子入队 |
| apps/web | 最小运行页面（SSR 零依赖）：登录、启动表单、运行详情（SSE 实时事件 + 取消 + 刷新恢复）、报告（断言表、截图预览、trace 下载）；证据/SSE 同源代理 |
| apps/demo-app | 评测扩展：namespace 夹具（ns/reset、ns/state）、demo_ns Cookie 数据隔离、orders/payments 计数元素、DEMO_FAULTS=submit-commit-hang 故障注入、种子账号密码可覆盖（错误密码场景） |
| tools/phase1-acceptance | 集成验收 harness（评测器专用）：起 6 个 demo 实例 + 平台三服务，经 API/队列/真实页面驱动 53 项场景 |

### 阶段 1 验收矩阵（53/53 通过，run16 = stamp mu55k3us）

健康三用例 PASS + 严格验收 PASS + 证据 PNG 下载 + trace 受限 + buildVerified；
无 buildId 运行 INCOMPLETE（版本未验证）；B1/B3/B4 正确 FAIL（含实际值与证据）；
错误密码 BLOCKED/AUTH 且断言全 NOT_EVALUATED；幂等（同键同请求原 run、异体 409、
业务峰值 1 单）；篡改计划执行前 422；越界登记 422；证据缺失降级 REVIEW + 下载 404 +
跨项目 403 + VIEWER 对 trace 403；VIEWER 不能启动（403）；空运行 422；取消幂等 +
终态 CANCELLED + 不误报通过；WRITE 提交挂起 → BLOCKED/UNCERTAIN_SIDE_EFFECT 且无
重复订单；命名空间隔离；SSE 有序无重复 + Last-Event-ID 续传；真实页面登录→启动→
SSE→刷新恢复→报告截图加载（docs/evidence/phase1-ui-report.png）。

### 回归

契约 81（含 pathTemplate 新增 6 项）+ API 13 + 执行器 10（真实 Chromium）+
evaluation 14 + artifact-store 4 + 黄金验收 10（demo 扩展未破坏既有语义）+
typecheck 0 错误 + 干净快照冻结安装（R3 口径沿用）。

## 阶段 0.2：复核修复 ✅

| 编号 | 修复 | 证据 |
|---|---|---|
| F1 | `semanticFrozen` 批准即冻结、只增不减：同次变状态+改语义、先变状态后改语义、退回 DRAFT 再改、显式解冻全部被数据库拒绝；工作流元数据仍可更新；INSERT 即 APPROVED 自动冻结 | verify-db-invariants F1-0～F1-6 |
| F2 | 受保护语义补齐：计划断言 targetRef/kind/stepId、goto.path、waitFor 业务条件值、检查动作 assertionId；waitFor 超时/轮询参数仍可维护；仅换定位方式哈希不变 | test-plan.test.ts F2 组 5 用例 |
| F3 | `validatePlanAgainstApprovedCase` 增加身份/状态/类别/角色/规则范围校验；新增 `verifyStoredPlan` 统一可信入口（schema→批准状态→一致性→哈希复核），repository/执行器必须复用 | F3 组 8 用例 |
| F4 | TestCase 增加 (id,projectId) 唯一键，TestCaseVersion→TestCase 复合外键；版本 projectId 必须与父用例一致 | F4-1/F4-2 |
| F5 | goto path 拒绝控制字符（TAB/CR/LF/NUL/DEL），计划级 superRefine 用 URL 解析哨兵复核同源 | F5 组 7 用例 |
| 升级路径 | 非空旧库升级探针：脏数据（跨项目版本）使迁移 3 单事务失败并回滚；回填对齐后成功；旧 APPROVED 版本回填冻结且升级后篡改被拒 | verification.md §12.2 |

迁移 `20260916110000_semantic_freeze_and_case_fk` 已在开发库（非空）直接追加应用，未重置数据库。

## Kimi（Moonshot）配置状态

- 根 `.env`（0600、git 忽略）已含 provider=moonshot、baseUrl、model=kimi-k2.6
  与文本/视觉 API key；密钥不出现在代码、文档、报告或 Git。
- 复核会话已完成两次小规模连通性调用（文本/视觉各一次，HTTP 200）。
- **配置完成 ≠ 已接入产品**：model-adapters 仍为阶段 2 占位；阶段 2 需实现
  moonshot 适配器（OpenAI 兼容协议 + 结构化输出 + 工具调用往返 + 超时/用量/
  requestId/错误标准化）、服务端环境加载与 worker 凭据注入（compose worker
  环境尚未注入模型变量），敏感配置不进入前端/计划 JSON/运行快照/日志；
  real 缺配置直接报错，禁止自动回退 mock。

## 阶段 0.1：评审修复 ✅

阶段 0.1 依据《阶段0代码评审-46e7e3f.md》、阶段 0.2 依据《阶段0.1复核与
Kimi配置-f48c3b4.md》逐项修复，全部带"修改前可复现、修改后被拒绝"的回归测试：

| 编号 | 修复 | 证据 |
|---|---|---|
| R1 | 用例断言增加 operator/unit（共享断言语义 schema）；APPROVED 必须携带 approvalHash 且断言语义完整；新增 `validatePlanAgainstApprovedCase` 绑定一致性校验 | domain.test.ts 5 个 R1 用例 + 计划一致性 4 用例 |
| R2 | 环境白名单按规范化 origin（protocol/hostname/port）精确比较，拒绝 userinfo/非 http(s)/协议相对 URL | apps/api/test/url-policy.test.ts 13 用例（含评审四个攻击行） |
| R3 | 重新生成 pnpm-lock.yaml（纳入 worker 依赖）；全仓 typecheck 0 错误；干净快照冻结安装见 verification.md §9 | `pnpm --filter @ai-qa/worker typecheck` 通过 |
| R4 | acceptanceHash 改为服务端统一提取（`extractAcceptanceProtectedFields`）：数据策略/fixture/参数、步骤角色映射、计划值引用语义（literal/dataRef/credential/captured）、业务时限全部纳入；定位与等待参数不纳入 | test-plan.test.ts R4 组 7 用例 |
| R5 | goto path 拒绝协议相对路径（//host）与反斜杠；执行器仍须二次校验最终 origin（已注明） | R5 2 用例（含 new URL 语义确认） |
| R6 | Run→Baseline/Environment、Attempt→Run/TestCaseVersion 建复合外键（含同项目约束，反规范化 projectId）；RuleVersion/TestCaseVersion 已批准语义字段触发器禁止原地改写 | scripts/verify-db-invariants.ts 7/7 通过（临时库） |
| 三.1 | ui.*/data.value 断言必须有 targetRef；断言 kind 与检查动作类型（assert/visualAssert/downloadCheck/apiCheck）一致 | 2 用例 |
| 三.2 | waitFor visible/hidden/text/value 必须有 targetRef（urlContains 除外） | 2 用例 |
| 三.3 | v1 禁止条件捕获（captureValue + onlyIf） | 1 用例 |
| 三.4 | 文档口径修正：schema 仅强制绑定携带 evidenceId 引用，**证据存在性/归属/观察会话校验在阶段 1 执行器落地时实现**，不宣称"已证明实际观察" | 本文件与 decisions.md 表述 |
| 三.5 | compose worker 不再挂载仓库：仅挂载自身 dist 与 node_modules（只读）；容器内确认无法访问 demo 源码与 tests-golden | verification.md §8.2 |

阶段 0.2 后测试规模：契约 75（0.1 时 55，原 34）+ API 13 + 数据库不变量 16 + 黄金验收 10。

## 阶段 0：工程基线、契约与独立待测系统 ✅

| 任务 | 状态 | 证据 |
|---|---|---|
| pnpm workspace + .env.example + compose.yaml + README | 完成 | `pnpm install`、`docker compose up -d postgres redis demo-app worker` 均实际执行 |
| contracts：Run 生命周期/verdict/reasonCode/AssertionResult/RuleVersion/TestCaseVersion/TestPlan v1/ApiError | 完成 | `pnpm test:contracts` 通过（含拒绝空断言、非法动作、断裂引用） |
| 数据库迁移（版本追加、attempt 唯一键、幂等键、审计、模型用量） | 完成 | 两个迁移；全新空库 `migrate deploy` 复验通过 |
| 最小平台登录与项目权限 | 完成 | 会话落库；401/403/422 实测（见 verification.md） |
| demo-app：申请人/主管、采购单、审批、付款待办、SQLite 持久化、金额用分 | 完成 | curl 冒烟 + 真实浏览器黄金验收 |
| demo-app：数据初始化/清理 + B1–B4 缺陷模式（仅评测配置控制） | 完成 | `pnpm test:golden` → healthy/B1/B2/B3/B4 全 PASS |
| demo-app 与平台隔离 | 完成（口径修正） | 独立应用/地址 7400/独立 SQLite，缺陷开关仅在服务端环境变量。**运行时智能体经浏览器访问目标，无文件读取途径；worker 容器不挂载仓库与评测答案（见 0.1 三.5）。本仓库同一目录存放源码属于开发期形态，不据此宣称运行时"源码不可读"已验证** |

### 已验证的验收条件（阶段 0）

1. 迁移可在干净数据库执行 —— 空库 `migrate deploy` 成功（两个迁移，含触发器）。
2. demo 健康业务能在真实浏览器走通 —— Playwright chromium 双角色完整流程。
3. 缺陷模式能通过独立黄金验收测试确认确实存在 —— B1/B2/B3/B4 各自的
   存在性断言均通过（同时确认健康版本不触发）。
4. contracts 拒绝空断言、非法动作和断裂引用 —— 反例用例全部按预期拒绝。
5. 安装和启动说明可复现 —— README 快速开始步骤即实际执行的命令序列；
   干净提交快照冻结安装验证见 verification.md §9。

## 未完成 / 未执行（边界声明）

- **未宣称具备 AI 自动生成测试能力**（阶段 2 起接入真实模型）。
- **观察证据真实性校验未实现**（阶段 1 执行器）：schema 只保证绑定携带
  evidenceId 引用与观察元数据，尚未校验 Artifact 存在、归属项目与观察会话。
- apps/web、packages/{model-adapters,doc-ingestion,test-runtime,evaluation}
  为占位说明，无代码 —— 阶段 1/2 按计划实现。
- 阶段 2 模型接入按 Moonshot/Kimi 适配器开发（provider=moonshot，
  OpenAI 兼容协议），不再假设 zhipu 单供应商；含服务端配置加载、worker
  凭据注入与用量记录。
- apps/worker 为健康检查骨架（`status: stub`），无队列消费；容器已验证启动。
- compose 中 api 未容器化（Prisma 原生引擎 + 本环境容器无法访问
  npm registry）；本地以 `pnpm dev:api` 运行。postgres/redis/demo-app/worker
  已容器化验证。
- 真实 GLM API 连通性未验证（无凭据；阶段 2 配置后执行）。
- 数组/JSON 引用（如 ruleVersionIds、selectedCaseVersionIds、sources）的
  存在性/归属校验仍在应用写入层 —— 计划阶段 1 的 repository 层实现。

## 下一阶段入口

阶段 1：固定用例到真实浏览器的纵向闭环 ——
1. 固定规则/用例/基线/计划版本的创建与查询（手工种子，origin=manual；
   写入走 repository，校验数组引用的存在性与同项目归属）；
2. 异步 run/attempt/step 作业与事件流（Redis/BullMQ 已就绪）；
3. TestPlan 执行器（goto/fill/click/switchRole/captureValue/waitFor/assert；
   导航与重定向用 url-policy 二次校验最终 origin）；
4. 每角色独立 BrowserContext、每 attempt 独立 namespace 与夹具清理；
5. expected/actual、截图、trace 写入 Artifact（含绑定 evidenceId 的
   存在性校验）；FR-10 聚合与最小运行页面。

## 已知限制

- demo-app 会话存内存（重启需重新登录）；业务数据持久化不受影响。
- 平台会话无续期机制；SESSION_TTL 默认 12 小时。
- demo-app 金额上限 2^53 分内（parseYuanToCents 的安全整数校验）。
- 黄金验收依赖本机已安装 playwright chromium（首次需 `playwright install chromium`）。
- compose 应用容器运行宿主编译产物（dist），修改源码后需重新 build。

