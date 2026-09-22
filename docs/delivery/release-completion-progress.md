# R00–R12 交付进度台账

基线：`main@dbc0a04` · 工作分支：`v1/release-completion` · 创建：2026-09-21

| 编号 | 代码状态 | 发布状态 | 本轮动作 | 变更文件 | 测试 | 证据/限制 |
|---|---|---|---|---|---|---|
| R00 契约 | DONE | — | 新增 ChunkManifest/Capability/ReleaseDecision/GoalProposal/Memory/Diagnosis 契约 + 6 张表迁移（修复干净库重放） | packages/contracts/src/{chunking,capability,release}.ts, prisma schema+migration, contracts/test/r00.test.ts | 189/189 contracts | Python 端已同步（R03 随 chunk wire 一并生成） |
| R01 多文件diff | DONE | NOT_RUN | Python compare_files（同路径配对→唯一哈希重命名→增删/不确定→片段比较→对账→稳定排序）+ 契约 + 可复现目录夹具 | source_changes/multi_file.py, contracts source-changes.ts, fixtures/multi-file-diff/ | Python 13/13 新增，contracts 199/199（新增 6） | 重命名只认同字节唯一哈希；名称相似不当证据；改名字节变→诚实增删 |
| R02 多文件影响 | BACKEND_DONE | NOT_RUN | SnapshotChange 表+作业+API：服务端装载冻结（浏览器只传版本清单）、/v1/snapshots/compare 真实 Python 比较、逐文件复核（modified 挂接单文件复核/removed+uncertain 必须理由/renamed 确认不改 oldVersionId）、新基线合并（删除独占规则下线+新增已批准资产纳入+旧基线保留）、幂等+防篡改 | prisma SnapshotChange, worker snapshot-diff-job.ts, routes-snapshot-changes.ts, Python app.py | worker 集成 5/5（真实 DB/HTTP/Python），全 worker 85/85，Python 305/305 | 剩余：复核 UI（R10）、SIGKILL 恢复专项（复用既有 durable 机制，随 R12 回归） |
| R03 长文档 | DONE | NOT_RUN | 确定性分块器（chunk-v1）+ 跨语言共享测试向量 + /v1/documents/chunk；持久化块处理（DocumentChunk 表：清单/块行幂等落库、租约 CAS、完成块不重复调用、租约过期显式恢复）+ 覆盖对账（部分完成只可审阅，合并完成门）+ 分层有界合并（签名去重来源并集/同 statement 不同条件双向 conflictsWith/确定性重编号） | chunking.py, chunk-jobs.ts, routes-chunks.ts, chunk-merge.ts, prisma DocumentChunk | 集成 5/5（真实 Python 分块+夹具提取），合并单测 8/8，api 68/68，worker 94+6s | 真实模型长文档试点随 R11 |
| R04 可安装 | DONE | PARTIAL | 生产 Dockerfile×4 + 独立 compose（migrate/seed 单次容器、健康检查、无默认凭据、demo 独立 profile、worker 镜像不含评测答案）；空库安装→登录→业务→备份→恢复→升级路径全部真实执行；worker 生产镜像（playwright noble）构建并 healthy（见 docs/delivery/r04-install-verification.md） | apps/*/Dockerfile*, deploy/compose.production.yaml | 实际构建+运行验证通过（6 容器 healthy） | 待跑门：registry 推送、生产 worker 真实浏览器执行冒烟与带 Run 数据的升级复核（R12） |
| R05 工程检查 | ADAPTERS_DONE | NOT_RUN | runner 适配器注册表：NODE_TEST/VITEST/JEST/PLAYWRIGHT/LINT/TYPECHECK/BUILD/PYTHON_TEST（固定命令数组、锁文件固定工具不用 npx、冲突/缺锁/缺工具显式拒绝、exit code 与 JUnit 矛盾拒绝、零测试显式 FAIL、Playwright 需操作员预置浏览器镜像） | tools/self-hosted-runner/runner.py + tests | 19/19（含真实容器：vitest/jest/eslint/tsc 真锁文件 npm ci）+ 真实 Playwright 浏览器调用通过 | 剩余：Node HTTP 单服务+独立 PostgreSQL 部署模板（受支持配置核验/就绪超时/清理追踪） |
| R06 GitHub CI | TODO | NOT_RUN | 待实现 | — | — | 需 GitHub App 配置 |
| R07 组合框架 | API_DONE | NOT_RUN | 能力目录/模板 CRUD+DAG 校验+发布 API（悬空/环/重复/64上限/并行≤2 拒绝） | apps/api/src/routes-release.ts | release-routes.test 10/10 | 模板真实运行编排待接 worker |
| R08 规划/探索 | API+AGENT_DONE | NOT_RUN | GoalProposal（未知工具拒绝+CAS 审核）/Memory（项目隔离+失效 CAS）/Diagnosis（跨项目引用拒绝）API；Python 目标规划 agent（目录外工具拒绝/无资料必须 MISSING_DATA blocker/环境缺失禁用需环境能力/空目录拒绝/promptVersion 固定）+ /v1/goals/propose wire | routes-release.ts, agents/goal.py, contracts | release-routes 10/10，Python 311/311（新增 6） | 剩余：TS propose 端点把 agent 输出落 GoalProposal 行（接 worker job）、有界只读探索执行 |
| R09 报告/决策 | API_DONE | NOT_RUN | ReleaseDecision（不改 Run verdict+快照如实记录 FAIL）/JSON+Markdown 导出（RESTRICTED_RAW 不内嵌地址）/全量统计 | apps/api/src/routes-release.ts | release-routes.test 10/10 | 证据保留策略任务待实现 |
| R10 前端 | IN_PROGRESS | — | 随各 R 包同步 | — | — | 现有 SSR 页面可复用 |
| R11 试点 | EXTERNAL_PENDING | EXTERNAL_PENDING | 代码可做，发布门缺外部条件 | — | — | 缺完整 PRD、第二项目、账号 |
| R12 复核/交付 | TODO | NOT_RUN | 最后执行 | — | — | 依赖全部代码包 |

## 基线核验（2026-09-21）

- `pnpm typecheck`：0 错误
- TS 测试：387 通过、6 跳过（跳过项为需要外部 GitHub/联网的仓库测试）
- Python 测试：由 CI 覆盖，本轮未在本地重跑
- 已有资产：22 个 contracts 源文件、14 个 API 路由模块、21 个 worker 处理文件、12 个 web 页面文件、Python intelligence 服务

## 本轮核验（2026-09-21 晚）

- `pnpm typecheck`：0 错误（含新路由）
- contracts：189/189（新增 r00.test.ts 8 项）
- api：60/60（新增 release-routes.test.ts 10 项）
- 迁移修复：R00 迁移剥离 ChangeReview 残留语句后，全链在全新库 `prisma migrate deploy` 重放通过

## 外部阻塞条件（单列）

1. 完整业务 PRD（需用户审核确认）
2. 第二实际项目（未提供）
3. 独立角色账号矩阵
4. GitHub App 配置
5. 真实模型 API 配额（Kimi 已有但需确认额度）

## 2026-09-22 Codex 接手：契约合流与 R02/R03 纠错

已保存 GLM 未提交 R07 工作为 `587f4eb`，合入 main 的 B 契约为 `a3da664`。这两个提交仅代表保存和合流，不代表 R07 执行验收完成。

本轮已修复并验证：
- 快照比较 HTTP/worker 统一调用 B 的 `compare_snapshots` + TS `validateSnapshotDiff`，移除第二套 `compare_files` 算法；兼容名称只转发正式清单，拒绝旧 caller file-list 协议。原有算法场景由双端共享 52 向量继续覆盖。
- 仓库发现记录服务端候选扫描清单；比较请求只接受项目内 old/new snapshotId。核对原字节、存储大小、解析片段及排队期间的输入漂移。旧快照无扫描证明时要求重新发现；旧对比记录只读。
- 长文档按码点切片实际发送局部正文，独立复核身份、正文、预算和全量覆盖；保留重叠上下文。修复 Python 换行预算少算。
- 块提交加入作业所有权、块 attempt/owner/有效期联合 CAS；失败只释放自己的租约，取消/失联不能复活。模型调用记录与模式持久化。
- 合并校验清单/块输出哈希，未知/重复/额外块不再误报完整；保留业务字段、质量、禁止行为与原冲突/澄清引用。条件不同不会自动臆断为冲突。
- 全部完成后 `/chunks/drafts` 使用现有 RULE_EXTRACTION 持久化入口生成 DRAFT 规则，幂等、模式核对与来源联合校验继续生效；尚未批准。

实际验证：contracts 257；Python intelligence 366（5 个已有警告）；真实 PostgreSQL/HTTP/Python 快照与分块 17；平台合并测试 11；全仓 typecheck 通过。测试模型为协议夹具，未调用付费 Kimi。测试使用临时库，新增迁移仅在隔离库验证。

仍需推进：R03 累计费用/显式总预算、跨表头完整语义、跨块新冲突识别评测及 UI；R07 当前接手骨架还未达到可组合模板验收；R05 生产部署模板、R06 GitHub App、R08 规划落库与任务接线、R09 保留任务、R10 新页面及 R12 最终发布验证继续开放。不能沿用原表中的“R03 DONE”作为完整 PRD 已验收结论。
