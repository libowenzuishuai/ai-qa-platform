# 实施状态

更新日期：2026-09-18 · 当前阶段：**阶段 2 A 上传/解析/审阅平台接线、B 首版 Python 解析已实现；C 正式算法与真实生成闭环待完成**

> 本文档描述当前代码的真实状态；历史阶段的演进记录在文末附录，不再逐段追加。

## 当前能力（以代码与验证为准）

**固定用例的真实浏览器测试执行平台**：登录 → 选择环境/基线/固定用例 →
Redis/BullMQ 调度 worker → Playwright 真实浏览器执行（七动作、每角色独立
上下文、命名空间数据隔离、连接层网络策略）→ 持久化步骤/断言/截图/trace →
SSE 实时进度（数据库原子序号）→ 报告（FR-10 严格验收、证据完整性复核）。

**跨语言基建已实现**：Python 智能服务骨架、生成契约/类型、模型与只读文件接口、TS worker 调用及共同反例校验已落地。B 首版 Python 文档解析已就绪；C 的正式 agents 未实现，调用明确返回未就绪。规则/用例迁移期间默认 reference。分工与后续任务见 [开工清单](stage2-python-handoff.md)。

**阶段 2 已实现**：契约与三套样例、Moonshot 文本/视觉与 mock 适配器、规则提取/用例生成作业 API 与参考管线。新作业具备可靠落库、补投、心跳、失联失败与显式重试；资产和成功状态在事务中提交。用例仍为 DRAFT，不代表已经可自动执行。

**阶段 2 评审**：A 通道七项修复与验证见 [修复记录](reviews/stage2-a-fixes-2026-09-18.md)。B 通道 `phase2/doc-ingestion` 至 `6ed386f` 已按 Python 架构迁移并修复合入，首版范围与未实现能力见 [最新解析库评审](reviews/doc-ingestion-6ed386f.md)；[初版评审](reviews/doc-ingestion-f07f928.md) 仅作为历史记录。C 的正式 Python agents 实现尚未合入。本次 B 增量已真实调用 Kimi 2.6：文本连通及两页合成 PDF 视觉识别通过；正式规则/用例生成的真实模型闭环仍未验收，详见 [PDF 视觉验收](reviews/pdf-kimi-vision-2026-09-18.md)。

**A 新增交付**：文档上传/版本登记与解析作业、解析产物校验和与来源落库、澄清回答/规则批准约束、资料/用例审阅和失败重试页面。真实浏览器与 Python 解析联调通过，C 使用测试专用协议替身。详见 [平台工作台](stage2-platform-workbench.md)。

**未实现**（后续阶段）：完整 AI 自动生成测试闭环（正式生成管线、完整用例编辑批准与现场绑定，阶段 2+）、
Midscene 视觉步骤、apiCheck/downloadCheck 执行、attemptNo>1 重试（unstable）、
目标构建身份核验（buildVerified 恒为 false，见 §构建声明与验证）、web/worker
的容器化启动验证（本地进程路径已验证）。

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
