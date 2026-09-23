# v2.0 架构决定记录（ADR）

随实现追加；每条含背景/决定/依据/影响。编号 A2-x 避免与 v1 决策（docs/decisions.md）混淆。

## A2-01 分支与工作包策略（2026-09-23）

- **背景**：任务书要求从最新 main 创建 `v2/autonomous-qa`，小步纵向切片合并。
- **决定**：W00–W04 在该分支顺序推进；每个工作包至少一个独立 commit；契约/迁移先行。
- **依据**：ROADMAP 依赖图（W01→W02/W03→W04）；避免巨型分支。
- **影响**：main 保持 1.0 稳定；v2 功能默认关闭（项目级开关在 W01 契约冻结后定义）。

## A2-02 v1 实体优先扩展，不建平行状态（2026-09-23）

- **背景**：PRD 新增 Task/ExecutionSession/OracleSpec 等 15 类实体；ARCHITECTURE 明确"复核现有
  Run/Workflow 能否扩展，避免同一事实两套状态"。
- **决定**：W01 逐实体核对——WorkflowRun 可扩展为 ExecutionSession 宿主（已含 templateId/budget/租约）；
  RuleVersion→OracleSpec 采用"派生冻结"而非重录（OracleSpec 引用 RuleVersion 集合 + 哈希）；
  CapabilityCatalog 升级为 CapabilityManifest 的持久层（加协议/入口/Schema 字段），不新建并行目录表。
- **依据**：v1 迁移不可改；语义复用降低双轨漂移。
- **影响**：迁移全部为 ADD COLUMN/新表；v1 读写路径不回改。

## A2-03 检索基线先关键词+结构关联（2026-09-23，CTX-04）

- **背景**：PRD/ARCHITECTURE 要求"先可度量基线，向量检索以评测增益为依据，不直接堆依赖"。
- **决定**：W03 实现关键词/结构/来源关联检索（无新基础设施），保存 selected/rejected 与分数；
  向量化列为 W10 评测驱动的候选，不在 Alpha 引入。
- **依据**：首轮无对比数据时无法证明向量增益；pg 无需新组件。
- **影响**：ContextManifest 中的检索记录结构须兼容未来替换检索实现。

## A2-04 循环规划器走既有 Python 通道（2026-09-23，LOOP-01）

- **背景**：任务书 W04"规划来自可替换 Python 服务，不能把所有规划写成测试专用分支"。
- **决定**：复用 intelligence-client + wire 契约机制新增 planner 端点；脚本规划器仅作为
  mock/夹具用途并显式标注，不进入 real 模式判定链。
- **依据**：v1 mock 确定性协议与调用记录已验证（INT-07 基础）。
- **影响**：Python 端新增循环规划 agent 时沿用 promptVersion 固定 + 输出双层校验模式。
