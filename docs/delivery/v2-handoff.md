# v2.0 会话交接（v2-handoff）

更新：2026-09-23（W00–W03 完成后）。给下一次会话的精确续做说明。

## 当前状态

- **分支**：`v2/autonomous-qa`（已推送 origin；基线 `main@5adb49c`）
- **当前 HEAD**：见 `git log -1`（R0 修复轮后持续前移）；W03 执行代码 `a6bdf3d`，交接文档提交 `2c240fa`，其后为 R0 修复系列提交（代码与文档 SHA 分别记录，不用文档提交冒充执行代码），无未提交修改，无运行中进程
- **工作包**：W00 VERIFIED · W01 CODE_READY（向量/迁移 VERIFIED，待 W02+ 消费全部表）
  · W02 Alpha 切片 VERIFIED（SDK 注册/执行 + 组合内核；子流程/回放/MCP 未做）
  · W03 核心 VERIFIED（Oracle + 检索基线 + ContextManifest）；W04–W10 NOT_STARTED
- **进度/矩阵/ADR**：`docs/delivery/v2-progress.md`、`v2-requirement-matrix.md`（57 项）、`v2-decisions.md`（A2-01～06）

## 本会话验证快照（全部实际运行）

- `pnpm typecheck` 0 错误；contracts 305/305；api 97/97；worker 144+7skip（其中 v2 新增 20/20）
- Python 387/387（含 W01 双端向量 shape 层 20/20）
- 迁移 `20260923100000_v2_w01_contracts`：干净库全链重放 + dev 旧库追加升级均通过
- 基础设施：ai-qa-postgres-1 / ai-qa-redis-1（colima，healthy）；Docker Hub 直连仍被墙，用 daocloud 镜像

## 下一条具体任务：W04 持久化自主循环（Alpha 核心）

按任务书 W04 + ROADMAP 最小闭环。入口与素材：

1. **表已备**：V2ExecutionSession/V2StepAttempt/V2ActionIntent/V2Invocation/V2Observation
   （契约见 `packages/contracts/src/v2/session.ts`，状态迁移表 `EXECUTION_SESSION_TRANSITIONS`/
   `INVOCATION_TRANSITIONS` 已冻结并有测试）。
2. **循环引擎**：新建 `apps/worker/src/v2/session-loop.ts`——逐轮 observe→plan→act→verify→adapt：
   - observe：用 v1 observation.ts 采页面（demo-app），落 V2Observation；
   - plan：调 Python（A2-04：走 intelligence-client；可先做确定性脚本规划器并显式标注 mock 专用，
     real 模式走 `/v1/plans/propose` 同款双层校验）；
   - act：经 `invokeCapability`（W02）+ intent 先行登记（V2ActionIntent + fencingToken）；
   - verify：对照 OracleSpec 断言（W03 `routes-v2-oracle` 产物）；
   - adapt：定位失败重新观察（不改 oracleHash）；三次等价无进展 → 换策略/暂停。
3. **最小业务闭环**（必须真实跑通）：demo-app 草稿系统，Oracle="创建草稿→改名→刷新仍保留名称"；
   运行中改按钮定位（demo-app 缺陷模式 B 类可注入）；写后回执前 SIGKILL 真实 worker →
   恢复核对资源不重复创建；缺陷构建（不保存名称）必须报 FAIL 不自修复。
   参考素材：`apps/demo-app`（B1–B4）、`tools/pilot-acceptance`（三构建对照）、
   v1 故障注入测试 `apps/worker/test/p0-acceptance.test.ts` 的 harness 模式。
4. **故障矩阵**（任务书 W04 列全）：动作前退出/写后回执前退出/回执后提交前退出；重复队列、
   双 worker、过期租约；排队/模型等待/写后取消；SSE 断线；证据丢失；旧观察；撤权；无进展；预算耗尽。

完成条件（Alpha 门）：两个独立 SDK 适配器（W02 已有 example.http-read + example.data-reconcile）
＋完整反馈循环＋标准不变＋恢复正确＋v1 兼容。

## 已知坑（本会话踩过）

- Python 适配器/服务启动探针用 `Uvicorn running on http://127.0.0.1:(\d+)`——`log_level=warning`
  会吞掉这行，必须 info。
- 正则跨语言：TS/PCRE 接受的 `[` 未转义在 Python 端 Rust regex 解析失败——共享向量的 shape 层
  就是防这个的（A2-05）。
- 测试构造 DocumentVersion 时 checksum 要用真实源文本字节 sha256（bundle JSON 内嵌版本 ID 会让
  同文本不同版本"字节不同"，破坏 rename/检索语义）。
- ArtifactStore 目录必须显式注入测试的 env.artifactDir（默认 data/artifacts 会找不到 bundle）。
- pnpm/全局环境：runner 测试别把夹具 package.json 写进仓库根（事故已发生过一次，见 ADR/提交历史）。

## 授权/预算状态

- 无真实模型调用（本轮全部 mock/确定性管线）；moonshot 凭据在 .env，W04 real 模式规划如需
  真实调用，先在台账登记预算再消费。
- GitHub App / 三个试点项目 / Jev 协议资料：仍缺（外部依赖清单见 v2-progress.md）。
- 未推送风险：无（分支已推送）；main 未动。

## 复现命令

```sh
pnpm typecheck
pnpm test:contracts
services/intelligence/.venv/bin/python -m pytest services/intelligence/tests -q
cd apps/api && pnpm vitest run
cd apps/worker && pnpm vitest run   # v2: test/v2-capability-sdk.test.ts test/v2-graph-executor.test.ts
services/intelligence/.venv/bin/python services/intelligence/scripts/generate_models.py --check
```
