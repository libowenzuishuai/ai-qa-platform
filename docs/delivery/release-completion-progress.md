# R00–R12 交付进度台账

基线：`main@dbc0a04` · 工作分支：`v1/release-completion` · 创建：2026-09-21

| 编号 | 代码状态 | 发布状态 | 本轮动作 | 变更文件 | 测试 | 证据/限制 |
|---|---|---|---|---|---|---|
| R00 契约 | DONE | — | 新增 ChunkManifest/Capability/ReleaseDecision/GoalProposal/Memory/Diagnosis 契约 + 6 张表迁移（修复干净库重放） | packages/contracts/src/{chunking,capability,release}.ts, prisma schema+migration, contracts/test/r00.test.ts | 189/189 contracts | Python 端已同步（R03 随 chunk wire 一并生成） |
| R01 多文件diff | DONE | NOT_RUN | Python compare_files（同路径配对→唯一哈希重命名→增删/不确定→片段比较→对账→稳定排序）+ 契约 + 可复现目录夹具 | source_changes/multi_file.py, contracts source-changes.ts, fixtures/multi-file-diff/ | Python 13/13 新增，contracts 199/199（新增 6） | 重命名只认同字节唯一哈希；名称相似不当证据；改名字节变→诚实增删 |
| R02 多文件影响 | BACKEND_DONE | NOT_RUN | SnapshotChange 表+作业+API：服务端装载冻结（浏览器只传版本清单）、/v1/snapshots/compare 真实 Python 比较、逐文件复核（modified 挂接单文件复核/removed+uncertain 必须理由/renamed 确认不改 oldVersionId）、新基线合并（删除独占规则下线+新增已批准资产纳入+旧基线保留）、幂等+防篡改 | prisma SnapshotChange, worker snapshot-diff-job.ts, routes-snapshot-changes.ts, Python app.py | worker 集成 5/5（真实 DB/HTTP/Python），全 worker 85/85，Python 305/305 | 剩余：复核 UI（R10）、SIGKILL 恢复专项（复用既有 durable 机制，随 R12 回归） |
| R03 长文档 | IN_PROGRESS | NOT_RUN | 确定性分块器（chunk-v1）+ 跨语言共享测试向量 + /v1/documents/chunk wire 端点（零模型调用） | services/intelligence/doc_ingestion/chunking.py, contracts chunking wire, fixtures/chunking/shared-vector.json | Python 292/292（新增 11），contracts 193/193（新增 4） | 剩余：chunk 状态持久化/租约/幂等 + 分层合并 + worker 接线 |
| R04 可安装 | CORE_DONE | PARTIAL | 生产 Dockerfile×4 + 独立 compose（migrate/seed 单次容器、健康检查、无默认凭据、demo 独立 profile、worker 镜像不含评测答案）；空库安装→登录→业务→备份→恢复→升级路径全部真实执行（见 docs/delivery/r04-install-verification.md） | apps/*/Dockerfile*, deploy/compose.production.yaml | 实际构建+运行验证通过（5 容器 healthy） | 待跑门：worker 镜像（playwright 基础镜像拉取中）、registry 推送、带真实 Run 的升级复核（R12） |
| R05 工程检查 | TODO | NOT_RUN | 待实现 | — | — | 已有 runner 基础 |
| R06 GitHub CI | TODO | NOT_RUN | 待实现 | — | — | 需 GitHub App 配置 |
| R07 组合框架 | API_DONE | NOT_RUN | 能力目录/模板 CRUD+DAG 校验+发布 API（悬空/环/重复/64上限/并行≤2 拒绝） | apps/api/src/routes-release.ts | release-routes.test 10/10 | 模板真实运行编排待接 worker |
| R08 规划/探索 | API_DONE | NOT_RUN | GoalProposal（未知工具拒绝+CAS 审核）/Memory（项目隔离+失效 CAS）/Diagnosis（跨项目引用拒绝）API | apps/api/src/routes-release.ts | release-routes.test 10/10 | Python 端生成器与探索执行待接 |
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
