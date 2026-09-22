# R00–R12 当前交付台账

2026-09-22。1.0 代码候选版完成，合入 main；代码与外部发布门分开。详细测试、固定代码提交和证据见 [完成评审](v1-code-completion-20260922.md)。

| 包 | 代码状态 | 已交付与验证 | 发布条件 |
|---|---|---|---|
| R00 契约 | CODE_VERIFIED | 正式多文件/分块/目标/任务/决策契约，TS/Python 共享向量；空库和旧库迁移 | 本地 PASS |
| R01 多文件 diff | CODE_VERIFIED | B 算法统一、52 个共享向量、完整性与 uncertain、不完整扫描不判删除 | 真实第二项目规模待验 |
| R02 变更闭环 | CODE_VERIFIED | 服务端原字节快照、逐文件复核、新资料/新基线、API/worker/UI；固定旧版本 | 真实完整资料试点待验 |
| R03 长文档 | CODE_VERIFIED | 码点分块、覆盖核对、持久化租约、批处理、累计预算、表格上下文/降级、合并 DRAFT 与恢复 | 新增真实模型语义评测待验 |
| R04 安装 | CODE_VERIFIED | 最终四类镜像、六服务健康；新空库/旧版升级/数据库与证据恢复/实际 Chromium | ARM64 本地 PASS；未发布 registry |
| R05 工程检查 | CODE_VERIFIED | 八类适配、LCOV 双重校验、Node HTTP + 独立 PostgreSQL、健康/取消/清理；34 项 + GitHub CLI 6 项 | 支持范围本地 PASS；任意多服务部署不在范围 |
| R06 GitHub CI | CODE_VERIFIED | App 授权、私库代理、签名/去重/fork、固定 SHA、Checks outbox/对账/撤销；HTTP/DB 模拟对端 | 真实 GitHub App EXTERNAL_PENDING |
| R07 组合框架 | CODE_VERIFIED | 能力目录、DAG 编辑/冻结/发布、Schema 与角色闸；三个实际模板、人工门、SIGKILL 恢复 | 本地组件 PASS；真实提供商单列 |
| R08 智能任务 | CODE_VERIFIED | Python 规划到持久化批准任务；限定只读探索；来源/TTL 记忆；报告事实诊断 | 新增规划真实模型质量 EXTERNAL_PENDING |
| R09 结果与决策 | CODE_VERIFIED | 缺陷分级/负责人/复测，幂等发布决定及旧快照，全量统计，JSON/MD，证据保留/降级 | 本地 PASS |
| R10 前端 | CODE_VERIFIED | 核心旅程真实表单、分页、错误恢复、只读权限、防重复、1440/390 | 本地浏览器 PASS |
| R11 试点工具 | CODE_VERIFIED | 清单/资料导入、审批/六维度/哈希、三构建原标准复测评估、ground truth 隔离、首败保留；7 项 | 两个真实项目 EXTERNAL_PENDING |
| R12 复核 | CODE_VERIFIED | 第二轮自查、561 TS + 374 Python + 34 runner + 6 公开 GitHub；类型/构建/契约/最终镜像；文档与远端核对 | 不是第三方审计，完整发布受外部门约束 |

## 下一步只剩需真实输入的验收

- 安全配置真实 GitHub App 并完成私库/Checks 提供商验收。
- 提供经业务批准的完整 PRD、第二项目与操作范围、独立角色凭据引用、健康/缺陷/修复构建。
- 在上述真实资料上运行新增长文档/规划的真实模型评测并复核首败，不用合成数据顶替。

历史“未接 API”“仅骨架”“继续实现 UI”等叙述已移至 [历史记录](release-completion-history-20260922.md)，不再代表 main 当前功能。
