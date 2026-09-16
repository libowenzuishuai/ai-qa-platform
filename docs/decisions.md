# 技术决策记录（ADR 摘要）

日期：2026-09-16 · 阶段 0

## D01 契约先行，Zod 运行时校验

PRD 阶段 0 要求“使用运行时 schema 校验，不只 TypeScript 类型”。所有领域
契约（状态机、TestPlan v1、ApiError、RuleVersion、TestCaseVersion）集中在
`packages/contracts`，以 Zod 定义并配 superRefine 跨字段校验（空断言、
非法动作、断裂引用、变量先定义后引用、观察绑定闭环）。任何 API/执行器
入库前必须通过契约 parse，类型仅是 parse 的副产品。

## D02 TestPlan 的目标是 targetRef 而非内联 selector

PRD §7.1 允许 observed targetRef 或明确 locator 类型。实现取更严格的一种：
动作只引用 targetRef，实际定位（testId/role/label/text）与观察证据（URL、
时间、evidenceId）全部登记在 bindings 中。这样“未观察到的按钮不能凭空
创建 selector”成为 schema 级约束，而非流程约定。

## D03 demo-app 使用 node:sqlite，平台使用 PostgreSQL

待测系统与平台刻意不同栈：demo-app 用 Node 内置 SQLite（零原生依赖、
独立数据文件、演示专用账号），强调它是被测的外部系统；平台按 PRD 用
PostgreSQL + Prisma。两者不共享数据库与地址。

## D04 缺陷模式只经环境变量注入，且不出现在任何响应中

`DEMO_BUG_MODES` 在服务端读取（config.ts），页面/API/前端代码均不含缺陷
语义。黄金验收（apps/demo-app/tests-golden）是唯一知道 B1–B4 语义的评测
器；运行时智能体与平台无读取途径。

## D05 B1 定义为边界包含错误（> 写成 >=）

阈值缺陷选用“恰好 500000 分被错误送入审批”：与 PRD FR-03 的边界验收
（“超过 5,000 元可确定 >5000 规则”）同构，直接考察边界测试能力，而不是
随意偏移常量。黄金测试用恰好 5000.00 元/5000.01 元两侧验证。

## D06 会话落库而非内存（平台）

平台会话存 Session 表（可重启恢复、可审计），demo-app 会话存内存（演示
系统，重启即失效，隔离越简单越好）。两者都是刻意选择。

## D07 平台端口固定：api 7300 / worker 7200 / demo 7400 / pg 5435 / redis 6380

宿主机 5433/5434 已被其它项目占用（colima 转发）；全部服务只绑定
127.0.0.1。compose 与本地开发使用同一套端口。

## D08 compose 应用容器：编译后运行纯 JS

本环境容器无法访问 npm registry（宿主代理不透传 colima），且 Prisma/
esbuild 含平台原生二进制。方案：宿主侧 `pnpm --filter @ai-qa/demo-app build`
产出纯 JS，容器 `node dist/server.js` + 挂载 node_modules（fastify 纯 JS）。
api/worker 容器化留待有 registry 的构建环境（未伪造“已容器化”状态）。

## D09 项目权限：服务端成员表鉴权，平台 ADMIN 只读兜底

所有项目读写经 `requireProjectAccess`（ProjectMembership 表）；平台
ADMIN 对任意项目仅 VIEWER 级兜底访问，写操作仍须成员身份。未登录一律
401，权限不足 403，均带 requestId（PRD §8 错误契约）。

## D10 环境登记即校验生产禁令与域名白名单

`POST /environments` 拒绝 isProduction 目标（首版禁止业务测试打生产），
并要求 baseUrl ∈ allowedOrigins，越界 URL 在登记时被 422 拒绝，而非等到
执行时才失败。

## 阶段 0.1（评审修复）

## D11 白名单按规范化 origin 精确比较（R2）

环境登记与执行期导航共用 url-policy：`new URL` 解析后比较
protocol/hostname/port（默认端口归一化），拒绝 userinfo 与非 http(s)；
不再使用 startsWith 前缀匹配。路径前缀规则与 origin 白名单分开。

## D12 数据库层引用与不可变保护（R6）

- Run→Baseline/Environment、CaseAttempt→Run/TestCaseVersion 使用复合外键
  （id + projectId），TestCaseVersion/CaseAttempt 反规范化 projectId；
  跨项目与悬空引用由数据库直接拒绝。
- RuleVersion/TestCaseVersion 的已批准语义字段由 BEFORE UPDATE 触发器保护
  （IMMUTABLE_SEMANTIC_FIELDS）；工作流字段（reviewStatus/approvalStatus、
  审核人/时间）可变更。修订 = 追加新版本 + supersedesId。
- 数组/JSON 引用（ruleVersionIds、sources 等）在写入层校验（阶段 1 repository）。

## D13 acceptanceHash 由服务端统一提取（R4）

`extractAcceptanceProtectedFields({testCase, plan})` 是唯一受保护字段来源：
断言（含 operator）、角色、步骤角色映射、数据策略（fixtureId/params/note）、
计划动作值引用（literal 值 / dataRef / credential / captured 变量名）、
副作用类别、visualAction 指令、业务时限。定位（bindings）与等待参数不纳入
——自动维护只允许调整定位与等待。禁止调用方手工拼摘要。

## D14 契约收紧（R1/R5/三.1–三.3）

- 断言语义（operator/expected/unit）在用例层与计划层共享同一 schema 与
  校验；用例层缺失 operator 直接拒绝，APPROVED 额外要求 approvalHash。
- 绑定阶段用 `validatePlanAgainstApprovedCase` 逐项比对，改 operator/
  expected/unit/required/ruleVersionId 或增删断言均拒绝。
- goto path 拒绝 `//host` 与反斜杠；执行器仍必须二次校验解析后 origin。
- ui.*/data.value 断言与元素类 waitFor 必须有 targetRef；断言 kind 与
  检查动作类型一一对应；v1 禁止条件捕获（captureValue+onlyIf）。

## D15 worker 容器不挂载仓库（三.5）

运行时智能体所在容器只挂载自身编译产物（dist）与 node_modules（只读），
不含 demo 源码与 tests-golden。隔离口径同时修正：当前"证据真实性校验
（evidenceId 存在/归属/观察会话）"未实现，schema 只强制引用存在，阶段 1
执行器落地时补齐，不宣称已证明实际观察。

## 阶段 0.2（复核修复）

## D16 批准即永久冻结（F1）

不可变性不再依赖"当前状态=APPROVED"：`semanticFrozen` 位在批准时置位
（INSERT 或 UPDATE 均触发），只增不减；冻结后语义字段在任何路径
（退回 DRAFT、SUPERSEDED 后、同次变状态+改语义、重新批准前）都不可改。
工作流元数据（状态、审核人/时间）独立可更新。迁移含回填：存量
APPROVED/SUPERSEDED 视为曾批准。

## D17 受保护语义按动作类型穷举（F2）

提取器逐类型枚举：goto.path、waitFor 的条件 kind+业务值（超时/轮询不
纳入）、检查动作 assertionId、downloadCheck.expectedFilename、计划断言
完整字段（含 targetRef/kind/stepId）。区分"同一业务目标换定位"（bindings
定位方式可维护，哈希不变）与"换业务目标/路径"（哈希必变）。换业务路径
如需维护，必须走显式可审核的新版本，不允许静默等价。

## D18 统一可信入口 verifyStoredPlan（F3）

对存储计划的信任必须经 `verifyStoredPlan`：schema 校验 → 用例 APPROVED
且带 approvalHash → caseVersionId/规则/角色/断言类别逐项一致 → 重算
acceptanceHash 并与存储值比对。阶段 1 的 repository 与执行器只允许经该
入口信任计划与哈希；不一致直接拒绝。

## D19 版本-父用例同项目复合外键（F4）

TestCase 增加 (id,projectId) 唯一键，TestCaseVersion 以 (caseId,projectId)
关联父用例：版本的 projectId 不能与父用例不一致，堵住"伪填 projectId 绕过
attempt 同项目约束"。应用写入时必须从父用例派生 projectId，不信任传入值。
非空旧库升级：脏数据令迁移单事务失败回滚，回填对齐后可应用（探针验证）。

## D20 goto 同源双保险（F5）

schema 层两道防线：正则拒绝控制字符（URL 解析器会去除 TAB/CR/LF 导致
归一化跳站）+ 计划级 superRefine 用哨兵 origin 做 URL 解析复核。执行器
接入后仍必须在导航与每次重定向后用 url-policy 校验最终 origin——正则
校验不是完整导航隔离。
