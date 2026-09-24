# v2.0 需求对照矩阵（PRD 57 项）

基线：`main@5adb49c`（2026-09-23）。每项：现状（1.0 已有，注明代码入口）/ 2.0 缺口 / 状态。
状态：SATISFIED（2.0 语义已满足）/ PARTIAL（有基础需扩展）/ GAP（2.0 新增）/ UNKNOWN（无法核实）。
"实现提交/测试/证据"在对应工作包完成后回填；本表先冻结现状与缺口。

## CTX 接入与业务上下文（W01/W03）

| ID | P | 现状（1.0） | 2.0 缺口 | 状态 |
|---|---|---|---|---|
| CTX-01 | P0 | 上传/仓库（github-app.ts 固定 SHA）、多文件快照冻结（routes-snapshot-changes） | 三入口合并为一个接入任务；仓库内 PRD 直接提议纳入不重复上传；扫描失败≠删除 | PARTIAL |
| CTX-02 | P0 | 规划输入仅 goal+能力目录+hasDocuments 布尔（goal-service） | 规划调用必须携带实际片段/批准规则/线索/缺口并记录输入哈希与引用 | GAP |
| CTX-03 | P0 | 来源质量 GOOD/LOW/UNPARSED、冲突 conflictsWith、快照 uncertain 均入库 | 汇总为覆盖地图进入规划与展示；冲突不靠模型调和 | PARTIAL |
| CTX-04 | P0 | 无按任务检索 | 可度量检索基线（关键词/结构/来源关联）+ selected/rejected 记录；无命中不等于无要求 | GAP |
| CTX-05 | P1 | 文档解析含接口/图片线索（doc-ingestion） | API 契约（OpenAPI）、设计图、代码线索作为有来源上下文；候选视觉预期不升硬标准 | GAP |
| CTX-06 | P1 | 分块有预算与跨块合并（chunk-*） | 上下文预算/摘要引用审计；否定/条件/单位不被摘要改写 | PARTIAL |

## DES 测试策略与判定依据（W01/W03）

| ID | P | 现状 | 缺口 | 状态 |
|---|---|---|---|---|
| DES-01 | P0 | 规则→用例→断言关联（RuleVersion/TestCaseVersion） | 六维覆盖（正常/边界/权限/多角色/状态/持久化）逐规则对账；缺权限矩阵记 BLOCKED | GAP |
| DES-02 | P0 | 规则↔用例双向引用、基线覆盖统计（reporting） | 风险层、未覆盖/不适用理由由有权人员确认；重复用例不提高分母 | PARTIAL |
| DES-03 | P0 | v1 TestPlan+acceptanceHash 冻结语义（不可变） | OracleSpec 独立实体（标准与操作分离）；oracleHash 下可改定位/等待 | PARTIAL |
| DES-04 | P0 | 断言含 kind/operator/expected（确定性） | 确定性/Schema/视觉语义分层；视觉低置信→REVIEW | PARTIAL |
| DES-05 | P1 | 无 | 决策表/边界等价类/状态转移/性质建议，须有来源或批准 | GAP |
| DES-06 | P1 | 快照影响分析（change-review impact） | 变化影响→测试优先级；排序不删低分用例 | GAP |

## LOOP 自主执行循环（W04）

| ID | P | 现状 | 缺口 | 状态 |
|---|---|---|---|---|
| LOOP-01 | P0 | 固定计划一次执行（run-processor）；模板 DAG（workflow-orchestrator） | 持久化逐轮 Observe→Plan→Act→Verify→Adapt；观察改变下一动作 | GAP |
| LOOP-02 | P0 | 执行前校验项目/角色/环境/预算/取消（v1 已验） | 增加能力授权、实时撤权、当前构建与观察新鲜度校验 | PARTIAL |
| LOOP-03 | P0 | 定位失败报 FAIL/AUTH（不可自修复） | 操作层自修复（重新观察选新动作）+ oracleHash 不可变 + 变更审计 | GAP |
| LOOP-04 | P0 | 无 | 防空转/等价重复/振荡检测（三次无进展换策略）；明确结束条件 | GAP |
| LOOP-05 | P0 | 未知副作用 UNKNOWN 状态 + 恢复对账（v1 WRITE 中断恢复已验） | intent→receipt→提交全链 CAS + reconcile 协议化；恢复者先查外部事实 | PARTIAL |
| LOOP-06 | P0 | 人工门 WAITING_HUMAN、取消、租约（v1 已验） | 活动预算与等待时间分离；认证接管；取消后模型结果只存档 | PARTIAL |
| LOOP-07 | P1 | 计划固定可复跑（casePlanPins） | 循环产物保存为回归资产（数据策略+有效绑定），新命名空间复跑 | PARTIAL |
| LOOP-08 | P1 | 多角色执行上下文隔离（v1 已验） | 多角色会话编排进循环；并发冲突/异步时间线保留 | PARTIAL |

## HAR 可组装 Harness（W01/W02/W06）

| ID | P | 现状 | 缺口 | 状态 |
|---|---|---|---|---|
| HAR-01 | P0 | CapabilityCatalog 注册 + 模板引用（routes-release） | 安装即注册的 SDK（TS 本地+Python 远程）；新工具不改核心 switch | GAP |
| HAR-02 | P0 | DAG 无环/并行≤2（模板校验） | 同能力多实例、typed binding、三值条件、子流程、有界 retry/repeat/map | GAP |
| HAR-03 | P0 | 模板版本发布固定（PUBLISHED 不可变） | HarnessProfile（工具/模型/策略/判定/记忆）版本化组装；实时撤权生效 | PARTIAL |
| HAR-04 | P0 | 无 | dry-run/记录回放/故障注入/单节点调试；回放零外部副作用 | GAP |
| HAR-05 | P1 | 模板表单编辑（web） | 画布+表单同 AST；键盘可操作 | GAP |
| HAR-06 | P1 | 无 | MCP 桥：管理员选中工具映射权限/效果分类；描述不授权 | GAP |
| HAR-07 | P1 | 能力/模板版本并存（unique key+version） | 安装禁用/升级/回滚与兼容矩阵；运行 pin 旧版本不受影响 | PARTIAL |

## EXE 浏览器/API/数据（W05）

| ID | P | 现状 | 缺口 | 状态 |
|---|---|---|---|---|
| EXE-01 | P0 | DOM 定位（testId/label/text）+ 截图证据（test-runtime executor） | DOM/可访问性树+当前截图联合观察；版本化元素引用；歧义不取第一个 | PARTIAL |
| EXE-02 | P0 | 同源策略代理（policy-proxy 连接层拦截）、上传/下载证据 | JS/弹窗/多标签/iframe（授权跨源）；下载内容与归属核验 | PARTIAL |
| EXE-03 | P0 | 无视觉操作 | 视觉候选定位+回退；动作后读实际效果；视觉不改业务结论 | GAP |
| EXE-04 | P0 | HTTP API 模板断言（api.request）、UI/API 分开断言 | UI/API 交叉核验（UI 成功而未持久化必检出）；OpenAPI 导入 | PARTIAL |
| EXE-05 | P0 | 角色独立浏览器上下文（v1 已验）；登录准备 9 状态 | MFA 人工接管交接；会话/角色隔离复核 | PARTIAL |
| EXE-06 | P0 | 数据插件 prepare/cleanup/台账（data-plugin-job） | verify/reconcile 协议；并发互不删；残留 CLEANUP_REQUIRED | PARTIAL |
| EXE-07 | P1 | 登录检查按环境版本 | 准备状态按版本/角色/环境失效；只读数据库核验适配器 | GAP |
| EXE-08 | P1 | buildDeclared/buildVerified 分离 + 前后证据 | 运行中漂移检测（部署替换后停止统一结论） | PARTIAL |

## CODE 工程测试与调查（W07/W09）

| ID | P | 现状 | 缺口 | 状态 |
|---|---|---|---|---|
| CODE-01 | P0 | runner 固定 SHA、锁文件检测、未知栈拒绝（self-hosted-runner） | 服务选择/启动方式/支持矩阵统一登记；2.0 接入任务复用 | PARTIAL |
| CODE-02 | P1 | 无生成 | 从批准 PRD/接口/性质生成 Node/Python 候选测试补丁（隔离工作区） | GAP |
| CODE-03 | P1 | JUnit 解析、零测试拒绝、矛盾拒绝（runner） | 候选测试同口径校验；代码覆盖单列 | PARTIAL |
| CODE-04 | P1 | 无 | 变异/已知缺陷对照、断言强度、过拟合检查 | GAP |
| CODE-05 | P1 | Node HTTP + 独立 PostgreSQL 部署检查（已验） | Python ASGI 模板；不支持栈快速失败清单化 | PARTIAL |
| CODE-06 | P1 | 报告/补丁证据链（v1） | 测试补丁下载/PR 草稿建议 + 来源/限制说明 | GAP |

## INT 诊断/记忆/模型（W04/W07/W08）

| ID | P | 现状 | 缺口 | 状态 |
|---|---|---|---|---|
| INT-01 | P0 | Defect 含 expected/actual/occurrence/复测（syncRunDefects + verify） | 候选含构建/角色/最小复现/证据分栏；单次定位失败≠产品缺陷 | PARTIAL |
| INT-02 | P1 | DiagnosisEntry facts/hypotheses/suggestions | 关联网络/控制台/授权日志/diff；支持与反对证据；UNKNOWN 允许 | PARTIAL |
| INT-03 | P1 | defect fingerprint 去重、REOPENED | 有界最小化复现；相似文案不合并不同缺陷；严重度依据 | PARTIAL |
| INT-04 | P1 | MemoryRecord TTL/失效触发/项目隔离 | 自动检索 + used/rejected/outcome 记录；过期不覆盖当前预期 | PARTIAL |
| INT-05 | P0 | 单一文本通道（moonshot）+ 视觉 OCR 通道 | 生成/视觉/决策三协议独立路由；提供商可替换 | PARTIAL |
| INT-06 | P1 | 无 | 可选 Jev（官方协议）分类/路由/排序；低置信回退；不裁决 PASS | GAP |
| INT-07 | P0 | InvocationRecord 用量/首败/mock 确定性协议（已验） | 费用未知不写零；截断/拒绝保留原文；调用方 maxOutput 透传 | PARTIAL |

## UX/OPS 产品与运营（W06/W09）

| ID | P | 现状 | 缺口 | 状态 |
|---|---|---|---|---|
| UX-01 | P0 | 接入/准备/设计/运行分页面（web SSR） | 单一入口接目标+资产；统一准备缺口视图；不填内部 ID/JSON | PARTIAL |
| UX-02 | P0 | SSE 实时事件 + 证据面板 | 实时控制台（当前动作/依据/截图/预算/时间线/待办）；进度来自真实事件 | PARTIAL |
| UX-03 | P0 | 人工待办（WAITING_HUMAN + 确认端点，幂等已验） | 待办保留上下文/负责人/恢复入口；VIEWER API 拒绝复核 | PARTIAL |
| UX-04 | P1 | 报告分母/统计/导出、发布决定独立（R09 已验） | BLOCKED/REVIEW/未测在分母展示；接受风险不改判复核 | PARTIAL |
| UX-05 | P1 | 模板/能力/模型配置页 | 画布/列表双视图、兼容与变更预览；未配置不伪装已连接 | GAP |
| OPS-01 | P0 | 持久事件/租约/预算/取消/恢复/证据完整性（v1 已验） | 2.0 循环会话级租约与检查点；故障注入矩阵扩展 | PARTIAL |
| OPS-02 | P1 | GitHub App 代码 + outbox/幂等/撤销（真实回传未验） | 真实 GitHub App 实测（外部配置） | EXTERNAL_BLOCKED |
| OPS-03 | P0 | 生产镜像/迁移/备份恢复/升级全链已验（r04 记录） | 2.0 新实体纳入同链验证 | PARTIAL |
| OPS-04 | P1 | 证据保留/失效降级（evidence-retention） | 审计/配额/用量统计；受限数据不形成永久公开链接 | PARTIAL |

## 汇总（R0.8 修正：程序化统计 57 行）

- SATISFIED：0（2.0 尚无一项以 2.0 语义完整验收）
- PARTIAL：35（有 1.0 基础，按 2.0 语义扩展并补验收）
- GAP：21（2.0 新增能力）
- EXTERNAL_BLOCKED：1（OPS-02 真实回传）
- 合计 57 = PRD 全部 ID（此前误记 33+19+1=53，已按行重数修正）

## R0 修复回填（2026-09-24，定向评审 V2-R01～08）

| 评审项 | 修复提交 | 验证 |
|---|---|---|
| V2-R01 授权/安装/秘密 | `fix(R0.1)`（锁内复核/范围交集/清单重哈希/本地劫持拒绝/秘密声明边界/授权指纹） | worker sdk 18/18（真实 DB 反例：范围无交集、篡改哈希、劫持、撤销竞态、同异体授权） |
| V2-R02 重定向边界 | `fix(R0.2/3/4/7)`（redirect:error 全通道+32MiB 上限） | 真实 A→B 接收站：B 0 请求 0 载荷（探针+套件 13/13） |
| V2-R03 重试/首败/截止/未知 | 同上（nodeDeadline/零派发/UNKNOWN 语义/首败保留） | 探针 6 项全转正；graph-executor 8/8 |
| V2-R04 循环/记账/身份 | 同上（repeat 先出果再判退/map 全批记账/executionKey 幂等键/subflow 显式拒绝） | 探针+套件 |
| V2-R05 Oracle 映射 | `fix(R0.5)`（结构化映射必填/未映射→待澄清/六维批准门/supersede 原子） | api 5/5（真实 DB：无映射 422、缺维 422、数值类型反例、supersede 链） |
| V2-R06 上下文复合键 | `fix(R0.6)`（(dv,spanId) 复合键/对账/保守预算/sessionId 校验） | python 3/3 + api 6/6（双文档同名 span 反例） |
| V2-R07 Schema 自检 | `fix(R0.2/3/4/7)`（pattern 编译/深度/闭包/区间/绑定路径类转义） | adapter-sdk 9/9；探针 invalidPattern ok:false、bindingShape items:true |
| V2-R08 台账精度 | 本提交（57 行重数/状态拆分/SHA 区分） | 本文件 + v2-progress |
| R1 准备检查 | `feat(R1)`（依赖分面/指纹绑定/TTL/幂等） | api readiness 7/7（真实 DB） |
| R2 W04 循环 | `feat(R2/W04)`（循环核心+SIGKILL）+`fix` 探针残留 | worker loop 5/5 + session-api 2/2（真实进程/DB/HTTP） |
| W04 python-real 规划器 | `feat(W04)` loop-planner | python agent 4/4 + worker 通道 2/2（真实 Python 进程；mock 无回放受控失败、零业务副作用） |
| W08 决策基线 | `feat(W08)` 契约+基线 | 4/4（命中选择/无命中回退/平局不猜/归一分值） |
| W07 记忆闭环 | `feat(W07)` memory-usages | 3/3（跨项目拒/过期不能 used/used+outcome 账本） |
| R3 最小旅程 | `feat(R2/R3)` + `test(R3)` 浏览器旅程 | web 1/1（SSR）；browser journey 1/1（真实 Chromium：1440 空态/表单键盘提交/COMPLETED/详情、390 详情、无横向溢出；截图 ×4 已入库 docs/evidence/v2-ui/） |
| R2 故障矩阵扩展 | `test(R2)` 三构建+矩阵 | loop 9/9（三构建同 oracleHash 连续对照；动作前退出资源 0→1；重复投递幂等资源仍 1；运行中撤权循环 FAILED） |


## 兼容矩阵与样本清单（W00 冻结起点）

**支持面（1.0 已验，2.0 继承）**：Chromium（Playwright 固定版本）；同源 + 授权跨源（连接层策略代理）；
HTTP API 模板断言；Markdown/DOCX/PDF(文字+内嵌图 OCR)/图片解析；Node(npm 锁) + Python(requirements)
工程检查 + Vitest/Jest/Playwright/ESLint/tsc/build/pytest 适配；Node HTTP + 独立 PostgreSQL 部署检查；
Docker 28+ ARM64 自托管镜像链。

**隔离评测目录布局（约定）**：
- 公开合成：`packages/contracts/fixtures/**`（可入库、可分享）。
- 受限真实：`docs/evidence/**` + 本地不入库目录（真值/缺陷开关/修复标签只放此处；
  产品智能体运行时不可读，见规则 9）。目录清单在 W10 冻结评测集时补齐条目。

**固定样本清单（起点）**：
- 合成业务系统：`apps/demo-app`（B1–B4 缺陷模式）+ `tools/pilot-acceptance`（三构建对照）。
- 共享向量：`packages/contracts/fixtures/{chunking,multi-file-diff,intelligence-conformance,source-impact-conformance}`。
- 真实项目样本：缺（登记为外部依赖 #1）。
