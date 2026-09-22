# 实施状态

2026-09-22 增量：B 多文件 diff 已评审修复并冻结正式模块契约，见 [多文件契约与接线要求](delivery/b-multi-file-review-and-contract.md)。仅纯模块/共享校验已交付，多文件 API/worker/UI 仍需按正式契约接线；GLM 开发分支不能当作 main 的已支持功能。

2026-09-21 文档更新：新增 [完整 PRD r3](product/v1.0/PRD.md)、[GLM 全部剩余开发任务书](product/v1.0/GLM-COMPLETE-IMPLEMENTATION.md)、[发布矩阵](product/v1.0/release/ACCEPTANCE.md)。本次仅更新规格与交接，未实现 R00–R12 的剩余代码，当前运行能力仍以以下交付记录为准。

当前 main 增量：账号准备、数据插件、持久化工作流、B/C 模块及 B3 评测、P0-4 变更复核闭环。完整验证与仍缺功能见 [最新交付和 PRD 差距](delivery/p04-completion-and-prd-review.md)。尚未达到通用商业版 1.0 的全部发布条件。

更新日期：2026-09-21。当前新增交付：**前四步受支持路径已接通**。完整能力、验证记录、启动方式与明确限制统一见 [前四步实施与验收](delivery/v1-implementation.md)。

后续增量：`v1/pilot-platform` 已补接入向导、完整用例编辑、准备检查与真实 Git 运行器整链，见 [试点平台进展](delivery/pilot-platform-progress.md)。本轮继续升级真实前端外观；代码收尾、可组合智能体与 GLM 任务见 [开发路线](product/v1.1/CODE-ROADMAP.md)、[GLM 开发任务书](product/v1.1/GLM-DEVELOPMENT-PROMPT.md) 和 [前端设计](product/v1.1/FRONTEND-DESIGN.md)。相关代码已合入 main；受支持范围与未验证条件以最新交付文档为准。

Python 正式解析/规则/用例管线已合入；本次新增通用浏览器计划、GitHub 上下文、七个产品页面、任务/缺陷/复测、HTTP API 与自有运行器。小样本真实模型验证不代表任意项目都能自动完成验收。

## 历史验收记录

以下记录保留各阶段当时的范围和限制；涉及“未实现”或“恒为 false”的历史描述，以以上最新交付记录为准。

## 阶段 1.1 修复（评审 R1–R9 + §三）

依据《阶段1验收报告-a08df8d.md》，先以反例复现、后修复、再加回归：

| 编号 | 修复 | 位置 | 验证 |
|---|---|---|---|
| R1 | 连接层网络策略：本地策略代理（HTTP 正向 + CONNECT 隧道），执行器与观察流程全部 context 经代理；越界目标在建立连接前 403（302/307/308/多级跳转/CONNECT 均覆盖）；夹具客户端白名单校验 + 不跟随重定向 + 超时（令牌不得外发） | packages/test-runtime/src/policy-proxy.ts、executor.ts、apps/worker/src/seed-processor.ts、fixtures.ts | test-runtime/test/network-and-semantics.test.ts（真实第二接收站：B 收到 0 请求、0 凭据） |
| R2 | CAS 状态迁移（比较数据库当前值）；排队取消有归宿（认领失败→完成取消）；取消后失联由对账器完成；心跳受租约约束（非活跃即停止）；终态不可回退；shouldContinue 仅 PREPARING/RUNNING 可继续 | packages/run-events、apps/worker/src/run-processor.ts、server.ts | boundaries.test.ts R2 组 + harness 排队取消/取消后失联 |
| R3 | 创建时固定 planVersionId/acceptanceHash（Run.casePlanPins，迁移 005）；worker 只按固定版本读取并核验哈希 | apps/api/src/runs-service.ts、worker/run-processor.ts | boundaries R3 + harness"排队期发布 v2 仍执行 v1" |
| R4 | 数据库事实核验：规则存在/同项目/APPROVED、来源 Span 与文档归属、基线成员、观察 Artifact 存在/同项目/OBSERVATION/文件真实存在 | apps/api/src/runs-service.ts（创建）、worker（执行前复核规则状态） | boundaries R4 组（伪造证据/跨项目证据/DRAFT 规则 → 422） |
| R5 | 共享报告构建器 packages/reporting：对照固定计划核验必需断言记录完整性、证据非空、归属本次 attempt/项目、文件存在且 sha256 一致；worker 终态与 API 报告同一口径 | packages/reporting/src/index.ts | boundaries R5 组（空证据/缺记录/丢文件/损坏/错归属 → REVIEW；口径一致） |
| R6 | exists/notExists 与 visible/hidden 正确语义：有效页面内业务缺失 = FAIL（登录态优先 AUTH）；notExists 目标仍在 = FAIL；visible 基于 isVisible（display:none 不算）；hidden 含 display:none | executor.ts | network-and-semantics.test.ts R6 组 |
| R7 | 事件序号数据库原子分配（Run.eventSeq UPDATE…RETURNING，迁移 005）；移除全部固定大数序号（9000/9998/9999）与吞冲突逻辑 | packages/run-events/src/index.ts | boundaries R7（并发 20 取号严格递增无空洞）+ harness SSE |
| R8 | 唯一约束冲突后重读 + 规范指纹比对（预算按可设键归一）：同体返回原 run、异体 409，绝不 500 | apps/api/src/runs-service.ts | boundaries R8（真实并发插入）+ harness 并发 HTTP/真实重复投递 |
| R9 | 调用者预算解析/校验/保存（范围外 422）；run 级截止时间约束 attempt 与 waitFor 轮询；夹具请求 AbortSignal 超时；不依赖心跳 | runs-service、run-processor、executor、fixtures | boundaries R9 + harness 预算耗尽（11s 结束） |

**验收与文档纠正（§三）**：harness 完全独立资源（临时库 + 独立 Redis 容器
（密码 + db3，验证 URL 解析实际生效）+ 动态分配端口 + 临时证据
目录，finally 全清理）；Redis URL 解析完整（username/password/db/TLS）；
buildDeclared 与 buildVerified 区分（声明 ≠ 已验证，核验未实现前恒 false）；
种子观察使用唯一命名空间并在失败时也清理；本文档整体改写消除阶段矛盾。

## 阶段 1.1 验收（隔离 harness，62/62）

`pnpm test:phase1`（tools/phase1-acceptance/run.mjs）：健康×3（严格验收
PASS、PNG/trace 证据、SSE 有序续传）、版本未验证、B1/B3/B4、AUTH、幂等
（串行 + 并发 + 真实重复投递）、篡改、越界登记、证据缺失/越权/受限、权限、
取消（运行中 + 排队 + 失联）、WRITE 中断、隔离、真实页面、**排队期计划 v2、
预算耗尽（11s）**——全部通过（详情见 verification.md §16）。

## 阶段 1.1 历史回归

契约 81 + API 45 + evaluation 14 + artifact-store 4 + runtime 23 + Redis 3，
共 170 项回归；黄金浏览器验收 10 项。类型检查、应用构建、冻结锁文件离线安装通过。
原有测试保留，本次新增 21 项回归。平台验收结果见 verification.md §22。

独立复查发现的剩余缺陷与修复依据见 [补充修复报告](review-2026-09-17.md)。

---

## 附录：历史阶段

- **阶段 0（2026-09-16）**：工程基线、契约、demo-app、黄金验收。
- **阶段 0.1/0.2**：两轮独立评审修复（operator 保留、origin 精确比较、锁文件、
  acceptanceHash 服务端提取、同源校验、数据库外键与冻结触发器）。
- **阶段 1（2026-09-17 a08df8d）**：固定用例真实浏览器闭环（队列、七动作执行器、
  证据、报告、页面、53 项验收）——独立验收发现 R1–R9 边界缺陷，即本阶段 1.1
  修复对象；主流程（健康/B1/B3/B4/角色隔离/页面）保留未重做。
