# 1.0 发布验收矩阵

2026-09-22｜PRD r3｜最终代码 214b89c｜配套 [PRD](../PRD.md)、[GLM 任务书](../GLM-COMPLETE-IMPLEMENTATION.md)。

**代码验收完成，正式发布尚有外部门。** 本次新增功能以最终回归和真实组件记录为依据；模拟提供商与实际提供商分列。见 [完整评审](../../../delivery/v1-code-completion-20260922.md) 与 [可公开机器记录](../../../delivery/evidence/v1-local-release-20260922.json)。

## 1. 状态与证据口径

代码状态：TODO / IN_PROGRESS / CODE_VERIFIED。发布门：NOT_RUN / PASS / FAIL / EXTERNAL_PENDING。每门独立记录，不将 EXTERNAL_PENDING、跳过、模拟检查计为真实发布 PASS。

每条通过记录最少含：commit、实际日期、测试入口/命令、执行环境、样本/数量、证据文件/校验和、组件真实性、剩余限制。复用历史证据必须标出其 commit 和未变化的适用范围；无依据不能打勾。

## 2. 当前工作包状态

| 包 | 代码状态 | 当前验收 | 未满足的发布条件 |
|---|---|---|---|
| R00 | CODE_VERIFIED | 269 契约、双端生成检查、追加式迁移通过 | 无独立代码缺口 |
| R01 | CODE_VERIFIED | 52 共享多文件反例和 B 算法合流 | 第二真实项目规模评测 |
| R02 | CODE_VERIFIED | DB/HTTP/Python/UI 快照→复核→新基线 | 完整批准资料试点 |
| R03 | CODE_VERIFIED | 真实 DB 持久化、故障恢复、累计预算、表头/覆盖/冲突反例 | 真实模型长文语义评测 |
| R04 | CODE_VERIFIED | 最终镜像空库、升级、旧 Run/证据恢复、新浏览器运行 | registry 未发布；其他架构未测 |
| R05 | CODE_VERIFIED | 34 运行器测试 + 6 公开 GitHub CLI；LCOV/Node HTTP/数据库/清理 | 任意多服务不属首版支持范围 |
| R06 | CODE_VERIFIED | 真实 HTTP/DB 模拟提供商，签名/去重/撤销/未知写入 | 真实 GitHub App EXTERNAL_PENDING |
| R07 | CODE_VERIFIED | 三模板实际能力、冻结 Schema、人工门/SIGKILL、页面组合/发布 | 无独立代码缺口 |
| R08 | CODE_VERIFIED | 目标批准到任务、浏览器只读探索、记忆/诊断反例 | 真实规划模型质量 EXTERNAL_PENDING |
| R09 | CODE_VERIFIED | 不改原 verdict、并发决策、全量分页、报告同源、证据保留 | 无独立代码缺口 |
| R10 | CODE_VERIFIED | 32 项 P0 与产品浏览器旅程，1440/390 查看，权限/错误/空状态 | 无独立代码缺口 |
| R11 | CODE_VERIFIED（工具） | 7 项导入/三构建评估工具检查；合成明确标注 | 两个完整真实项目 EXTERNAL_PENDING |
| R12 | CODE_VERIFIED | 实现者第二轮复核、全仓回归、最终镜像与远端核对 | 非第三方审计；外部门不得豁免 |

## 3. 横向门

| 门 | 当前状态 | 依据与界限 |
|---|---|---|
| G01 真实性 | PASS（本地组件） | 真实 Chromium/DB/Redis/HTTP/Docker；模型与 GitHub 模拟器不计提供商通过 |
| G02 独立依据 | PASS（代码/合成反例） | 来源/批准/版本冻结和两侧语义校验；真实业务批准另验 |
| G03 故障恢复 | PASS（本地组件） | 取消、租约、预算、入队失败、SIGKILL；未知副作用不盲重放 |
| G04 权限隔离 | PASS（本地组件） | 跨项目、受限证据、角色变化、网络第二接收站反例 |
| G05 完整性 | PASS（支持范围） | 多文件/分块覆盖，205 条分页反例，报告原文/哈希/分母；模型语义穷尽性不作保证 |
| G06 部署 | PASS（ARM64） | 最终四镜像、六服务、空库/升级/恢复/真实新运行；非全架构/规模证明 |
| G07 真实试点 | EXTERNAL_PENDING | 完整 PRD、第二项目、角色与三构建尚缺 |
| G08 模型评测 | EXTERNAL_PENDING | 未对新增规划/长文运行付费真实模型；历史 B3 不能覆盖本轮 |
| G09 可用性 | PASS（核心旅程） | 实际表单、权限、错误恢复、发布导出、两宽度截图 |
| G10 发布一致性 | PASS（源码/本地镜像） | 固定代码与证据、追加迁移、生成一致、main 正常合并推送；registry 单列 |

提供商额外门：真实 GitHub App 安装、私库及 Checks 回传为 EXTERNAL_PENDING。上述局部 PASS 不等于整体产品已通过商业发布验收。

## 4. 真实试点资料清单与当前可用项

| 输入 | 当前情况 | 交付方式 |
|---|---|---|
| Dify 脱敏观察 | 已有；非官方 PRD | `packages/contracts/fixtures/pilot-dify-v1` |
| Dify 候选设计 | 已有；未经业务正式批准 | `docs/delivery/pilot-dify-candidate-design.md` |
| 多文件/长文合成夹具 | 已完成，明确 synthetic | 独立旧/新文件、hash、expected、synthetic 标记 |
| 完整业务 PRD 与权威性确认 | 未提供 | 版本化文档、来源/许可说明、人工审核记录 |
| 实际角色/权限矩阵与账号引用 | 未齐 | 环境登记 + 安全凭据引用，不放 Markdown 密码 |
| 第二实际业务项目 | 未提供，无确定日期 | 项目/仓库/网址、资料位置、允许的操作范围 |
| GitHub App 真实安装配置 | 未核实可用 | 受支持配置与仓库限定授权；缺失则外部待验 |
| 健康/隐蔽缺陷/修复版本 | 完整真实项目未齐 | 冻结提交/构建、独立评测 ground truth、执行输入分离 |

## 5. 发布决策规则

1. R00–R10 及 R12 的可独立代码、组件验收不得因为 R11 缺资料而停工。
2. 所有必做代码状态 CODE_VERIFIED 后，才能声明本轮代码验收完成；仍有已知行为缺陷不得标完成。
3. 所有横向门 PASS，真实试点通过，方可声明 1.0 发布验收通过。EXTERNAL_PENDING 只能说明原因与补充条件，不能豁免为 PASS。
4. 同一新问题修复后跑其反例与相关回归。文档/样式小修改不机械跑全部历史收费评测。
5. 每个子项的 N/A 需指出明确产品范围及审阅依据；不能将必做功能临时改为 N/A 以结项。

## 6. 可复现实证

- [R00–R12 台账](../../../delivery/release-completion-progress.md)
- [完成评审与命令/日志说明](../../../delivery/v1-code-completion-20260922.md)
- [镜像、备份与日志哈希](../../../delivery/evidence/v1-local-release-20260922.json)
- [隔离生产验收工具](../../../../tools/release-acceptance/README.md)
- [真实试点导入和三构建评估](../../../../tools/pilot-acceptance/README.md)

默认 TypeScript 回归有 7 个 opt-in 跳过，其中 6 个公开 GitHub CLI 已单独启用通过，另 1 个真实仓库资料解析整链未启用。真实模型模式本轮未运行，单列于 G08；不并入通过数量。
