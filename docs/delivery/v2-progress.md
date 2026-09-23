# v2.0 交付进度台账

创建：2026-09-23 · 分支：`v2/autonomous-qa`（基线 `main@5adb49c`，执行代码基线 `214b89c`）

状态取值：NOT_STARTED / IN_PROGRESS / CODE_READY / VERIFIED / EXTERNAL_BLOCKED。
历史 975 项平台检查是 1.0 记录，不作为 2.0 现状；本轮基线以本文件记录的实际运行为准。

| 工作包 | 状态 | 依赖 | 说明 |
|---|---|---|---|
| W00 基线与台账 | VERIFIED | 无 | 本文件 + 需求矩阵 + ADR；基线命令逐项实际运行 |
| W01 共享契约与迁移 | CODE_READY | W00 | 15 类实体定稿（Oracle/Harness/Graph/Session/Context/Finding 六模块，v2/ 目录）；25 例共享向量（19 shape 双端同判 + 6 semantic TS 权威）；16 张 V2* 表迁移（干净库+旧库重放通过）；contracts 305/305、python 向量 20/20、typecheck 0。VERIFIED 待 W02 起逐表消费（规则 11：只建不消费不算完成） |
| W02 能力 SDK 与组合内核 | IN_PROGRESS（Alpha 注册/执行切片 VERIFIED） | W01 | adapter-sdk 包（CapabilityAdapter 协议 + Schema 子集校验器 + 自检）；TS 样例 example.http-read（本地 SDK，白名单/取消/超时）；Python 样例 example.data-reconcile（remote-http 独立进程，describe/execute/cancel）；worker 注册表+调用器（授权/撤权/跨项目/Schema 前后校验/版本哈希匹配）；API 安装/授权/撤销/列表（安装≠授权；清单不可变；撤销后重装=新行）。集成 12/12（真实 DB+真实 HTTP+本地 HTTP 目标）。组合执行内核 VERIFIED（graph-executor：依赖拓扑序+失败/跳过/人工传播、typed binding 三源解析、三值条件 onUnknown 分支、有界 map 并发≤2 逐项对账、repeat 上限、retry 限错误分类保留首败、同能力多实例输出隔离、取消传播；集成 8/8 真实 DB+HTTP）。剩余：子流程运行时、回放/dry-run、MCP 桥、HAR-05 画布 |
| W03 真实上下文与 OracleSpec | CODE_READY→核心 VERIFIED | W01 | OracleSpec API（批准规则→确定性断言冻结→oracleHash→批准不可变→同内容幂等→supersede 链→读取哈希复验）；Python keyword-structural-v1 检索基线（bigram 关键词×结构权重×规则来源权威路径，selected/rejected+分数+原因）+ /v2/context/retrieve；ContextManifest API（服务端装载→真实检索→预算估算→截断 omitted 对账→inputHash 落库）；集成 5/5（真实 DB+真实 Python）。剩余：OpenAPI/设计图线索（CTX-05）、跨块关系审计（CTX-06）、六维覆盖运行时接线（DES-01 与 W04 联动） |
| W04 持久化自主循环（Alpha 核心） | NOT_STARTED | W02+W03 | Observe→Plan→Act→Verify→Adapt；草稿三构建最小闭环 + 故障矩阵 |
| W05 浏览器/API/数据 | NOT_STARTED | W04 | DOM+视觉联合观察；复杂交互；交叉核验；Stagehand 对照 ADR |
| W06 工作台与组合设计器 | NOT_STARTED | W04 | 实时控制台/缺陷卡/画布+表单同 AST/三个真实预设 |
| W07 调查/记忆/有效代码测试 | NOT_STARTED | W05 | 假设反证/记忆消费闭环/候选测试补丁/变异对照 |
| W08 模型路由与可选 Jev | NOT_STARTED | W04 | 三协议路由；确定性基线；Jev 官方协议适配（不伪造） |
| W09 安装/运行器/CI | NOT_STARTED | W02+W05+W06 | 支持矩阵；干净库/旧库升级/备份恢复全链；GitHub App 实测单列 |
| W10 独立评审与业务评测 | NOT_STARTED | W05–W09+外部 | 3 授权项目/120 流程/30 缺陷/两周试点；实现者自审不算独立评审 |

## W00 基线核验（2026-09-23 实际运行）

| 命令 | 结果 | 备注 |
|---|---|---|
| `pnpm typecheck` | 通过（exit 0） | 全仓 TS 无错误 |
| `pnpm test:contracts` | 见本文件下方"基线数字" | 契约层 |
| `generate_models.py --check` | 见下方 | Python 生成类型一致性 |
| 基础设施 | ai-qa-postgres-1 / ai-qa-redis-1 healthy（colima） | 本机 Docker 运行中 |

完整回归（api/worker/web/python/runner）在对应工作包触碰时运行；W00 只需确认基线可用，
不重复 1.0 已记录的 975 项。

## 可复用资产盘点（代码入口核实）

- 生命周期/证据/来源/审批：Run/CaseAttempt/Artifact/RuleVersion/Baseline 全链（v1 已验收）。
- 能力目录与模板：`CapabilityCatalog`/`WorkflowTemplate`（版本/发布/DAG 校验）+ 模板化 WorkflowRun
  （`WorkflowRun.templateId`/`WorkflowNode.capabilityKey`，R07 已接）。**新增能力仍走核心 switch 分支——W02 要替换为注册式 SDK。**
- 目标/探索/记忆/诊断：`goal-service`/`exploration-job`/`memory-service`/`diagnosis-service` 已有 API+worker；
  记忆有 TTL/来源/失效，但无 retrieved/used/outcome 消费闭环（W07）。
- 工程检查：`tools/self-hosted-runner`（8 类适配器 + 部署模板）、`github-ci.ts`、LCOV 复核（W09 复用；CODE-02/04 候选测试生成是缺口）。
- 模型：moonshot 正式通道 + mock 确定性协议 + 调用记录（W08 拆三协议；Jev 缺）。
- 长文档：分块/租约/预算/合并（R03）——W03 检索基线的底座。
- 多文件快照：字节哈希判据/联合校验/复核闭环（R01/R02）——CTX-01 底座。

## 外部依赖登记（不阻塞内核开发）

1. 三个授权试点项目 + 完整 PRD + 角色/数据授权（W10）。
2. GitHub App 真实配置（W09 对应门）。
3. 真实模型预算（W08 A/B、W10 效果评测）。
4. Jev 官方协议资料/密钥（W08；仅按官方文档适配）。
5. 人工基线参与者与两周试点窗口（W10）。
