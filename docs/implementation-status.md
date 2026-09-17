# 实施状态

更新日期：2026-09-17 · 当前阶段：**阶段 1.1 修复完成（评审 R1–R9 + 验收纠正，62 项隔离验收全通过，待人工复核）**

> 本文档描述当前代码的真实状态；历史阶段的演进记录在文末附录，不再逐段追加。

## 当前能力（以代码与验证为准）

**固定用例的真实浏览器测试执行平台**：登录 → 选择环境/基线/固定用例 →
Redis/BullMQ 调度 worker → Playwright 真实浏览器执行（七动作、每角色独立
上下文、命名空间数据隔离、连接层网络策略）→ 持久化步骤/断言/截图/trace →
SSE 实时进度（数据库原子序号）→ 报告（FR-10 严格验收、证据完整性复核）。

**未实现**（后续阶段）：AI 自动生成测试（资料解析/模型规划/现场绑定，阶段 2+）、
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
（密码 + db3，验证 URL 解析实际生效）+ 独立端口 7310/7211/7110 + 临时证据
目录，finally 全清理）；Redis URL 解析完整（username/password/db/TLS）；
buildDeclared 与 buildVerified 区分（声明 ≠ 已验证，核验未实现前恒 false）；
种子观察使用唯一命名空间并在失败时也清理；本文档整体改写消除阶段矛盾。

## 阶段 1.1 验收（隔离 harness，62/62）

`pnpm test:phase1`（tools/phase1-acceptance/run.mjs）：健康×3（严格验收
PASS、PNG/trace 证据、SSE 有序续传）、版本未验证、B1/B3/B4、AUTH、幂等
（串行 + 并发 + 真实重复投递）、篡改、越界登记、证据缺失/越权/受限、权限、
取消（运行中 + 排队 + 失联）、WRITE 中断、隔离、真实页面、**排队期计划 v2、
预算耗尽（11s）**——全部通过（详情见 verification.md §16）。

## 回归

契约 81 + API 30（13 策略 + 17 边界[新增]）+ evaluation 14 + artifact-store 4
+ runtime 20（新增 R1/R6 10 项）+ 黄金验收 10 + 隔离 harness 62 + typecheck 0。
原有 185 项全部保持通过（API 包 13→30、runtime 10→20 为新增反例，无删除）。

---

## 附录：历史阶段

- **阶段 0（2026-09-16）**：工程基线、契约、demo-app、黄金验收。
- **阶段 0.1/0.2**：两轮独立评审修复（operator 保留、origin 精确比较、锁文件、
  acceptanceHash 服务端提取、同源校验、数据库外键与冻结触发器）。
- **阶段 1（2026-09-17 a08df8d）**：固定用例真实浏览器闭环（队列、七动作执行器、
  证据、报告、页面、53 项验收）——独立验收发现 R1–R9 边界缺陷，即本阶段 1.1
  修复对象；主流程（健康/B1/B3/B4/角色隔离/页面）保留未重做。
