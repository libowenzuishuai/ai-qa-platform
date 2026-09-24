# v2.0 会话交接（v2-handoff）

更新：2026-09-24（GLM-CONTINUE-W04 R0～R3 完成后）。给下一次会话的精确续做说明。

## 当前状态

- **分支**：`v2/autonomous-qa`（已推送；不合 main）。执行代码 HEAD `4b52144`（含其前 `005d301`/`fe28e16`/`a6bdf3d` 系列）；文档提交随各批包含。
- **工作树干净**；无运行中进程；评审探针 7/7 期望值达成（`docs/delivery/evidence/v2-w03-review-probe.mts`，其 Prisma 替身已随加固接口维护）。
- **轮次**：W00 VERIFIED · W01 CODE_READY · W02 修复后核心 VERIFIED（子流程/回放/MCP 未做）· W03 修复后核心 VERIFIED · **R0（V2-R01～08）全部修复+反例回归** · **R1 readiness VERIFIED** · **R2 W04 script 切片 VERIFIED（含真实 SIGKILL 恢复）** · **R3 最小旅程 API+SSR VERIFIED**。

## 本轮验证快照（全部实际运行）

- typecheck 0；contracts 305/305；api 105/105；worker 157+7skip（v2 相关 33/33：SDK 18+图 8+循环 5+会话 API 2）；web 1/1（新增 vitest）；python 390/390。
- 迁移：`20260924010000_v2_readiness`（干净库重放通过）。
- 评审探针（真实源函数+真实本机 HTTP）：retryFalse=1call+首败保留、repeat=1call、map=2/2、expired=0call、pattern 自检拒+运行时受控、重定向 B=0、`items` 路径通过。

## 下一轮入口（按 GLM-CONTINUE-W04 R4 及其后续）

1. **R4 遗项**：
   - 浏览器 1440/390 真实截图与交互验收（`/space/:id/autonomous`、`/v2/sessions/:id`）——页面逻辑已由 web 1/1 测试覆盖，但截图与键盘/焦点检查未做；
   - 故障矩阵扩展：双 worker 并发、重复队列投递、过期租约、排队中/模型等待中/写后取消、SSE 断线重连（v2 事件目前无 SSE，列表页轮询即可先交付）、过期观察、证据丢失、运行中撤权；
   - `python-real` 规划器接线（A2-04：intelligence-client + promptVersion 固定 + 双层校验；先做 wire 契约 LoopPlannerInput/Output）。
2. **Alpha 门判定**（按 PRD）：两个独立 SDK 适配器 ✓（http-read + data-reconcile，且新增 draft-ops）＋完整反馈循环 ✓（script 切片）＋标准不变 ✓（oracleHash 全程未变+测试）＋恢复正确 ✓（SIGKILL+幂等对账）＋v1 兼容 ✓（回归全绿）。**但 Alpha 宣称要求"确定性/脚本驱动内核验证"与"真实模型驱动效果"分开报告**——后者未验（无真实模型调用），故只能说"script 内核 Alpha 达成、真实模型语义未验"。
3. **W05～W10** 按原 ROADMAP；W02 剩余（子流程运行时、回放、MCP、画布）不阻塞 W05。

## 本轮已知坑（新增）

- 探针/替身需随调用器加固维护：`$transaction`/`$queryRaw` 透传 + `computeManifestHash` 真实值（否则清单校验路径不生效，探针结果失真）。
- 子进程跑循环：脚本必须放仓库内（模块解析），tsx 用 `apps/worker/node_modules/.bin/tsx`；SIGKILL 用 marker 文件同步，不猜时序。
- web 的 `api.ts` 原在模块加载时冻结 API_BASE——已改为每次调用读取；测试可指向 in-process 实例。
- 合成系统 `__danger_stats` 早期版本把幂等记录也计入资源数——已按"真实草稿键"过滤。

## 授权/预算

- 本轮零真实模型调用、零外部网络（合成系统全部 127.0.0.1）；moonshot 凭据仍在 .env，python-real 接线时先登记预算。
- GitHub App / 三试点项目 / Jev 资料：仍缺（外部清单见 v2-progress）。

## 复现命令

```sh
pnpm typecheck
pnpm test:contracts
apps/worker/node_modules/.bin/tsx docs/delivery/evidence/v2-w03-review-probe.mts "$PWD"
cd apps/api && ./node_modules/.bin/vitest run
cd apps/worker && ./node_modules/.bin/vitest run   # v2: capability-sdk/graph-executor/session-loop/session-api
cd apps/web && ./node_modules/.bin/vitest run
services/intelligence/.venv/bin/python -m pytest services/intelligence/tests -q
```
