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

## A2-05 W01 契约冻结与跨语言向量分层（2026-09-23）

- **背景**：任务书要求"Python与TS对同一向量接受/拒绝一致"，同时禁止两套业务判定规则。
- **决定**：向量分两层。layer=shape（19 例：结构/类型/枚举/模式）双端必须同判——
  由此发现并修复了真实差异：graph.ts 绑定路径正则的未转义 `[` 在 Python 端 Rust regex
  下解析失败（JS-PCRE 接受），统一改为 `\\[\\]` 转义。layer=semantic（6 例：
  闭包/预算关系/证据规则等 superRefine）为 TS 服务端权威层，Python 不镜像——
  Python 只做算法/规划，授权与判定提交权在 TS（架构原则）。
- **依据**：HARNESS-SPEC §3"不让某一侧的默认强制类型转换悄悄接受另一侧拒绝的值"；
  ARCHITECTURE §1 语言边界。
- **影响**：新增语义约束只改 TS superRefine；跨语言新增必须同时加 shape 向量。

## A2-06 v2 迁移与默认关闭（2026-09-23）

- **决定**：迁移 `20260923100000_v2_w01_contracts` 纯新增 16 张 V2* 表；
  全部以 projectId 外键 RESTRICT 关联 Project，不触碰 v1 表结构。
  v2 功能未接线前所有 V2 表为空置持久层（"只创建不消费的表"按规则 11 计未完成——
  W02 起逐表接线消费，W01 状态为 CODE_READY 而非 VERIFIED）。
  干净库全链重放 + 旧库（dev）追加升级均实际执行通过。
- **依据**：任务书"不改已应用迁移；新增迁移同时验证干净库和旧库升级"。
- **影响**：v1 契约回归 305/305 不受影响；回滚 v2 仅需停用相关代码路径，无需降库。
