# 2.0 Harness：工具与执行框架规格

> 目标设计，尚未实现。对应 PRD HAR-01～07、LOOP、INT；本文定义开发边界，不是现有 API 文档。

## 1. 要解决的问题

目前的组合器可以编排内置能力，但新增能力仍依赖核心代码。2.0 要让独立开发者实现一个工具，在不修改核心调度器的情况下安装、调试、授权、组合和运行。模型只是选择已授权能力的参与者，不能自行安装工具或扩大权限。

第一版 SDK 必须同时展示两个独立样例：本地 TypeScript 的只读 HTTP 检查器、远程 Python 的数据核对器。浏览器执行器沿用独立进程和项目隔离；“本地适配器”指运行器内加载，不代表能直接访问 API 服务或宿主机。

## 2. 六个组件与版本关系

| 组件 | 必需字段/作用 | 版本规则 |
|---|---|---|
| CapabilityManifest | id、版本、协议、输入/输出 Schema、效果分类、权限、幂等/恢复说明、运行入口 | 内容哈希不可变；禁用不删除历史 |
| AdapterInstallation | 实际安装来源、摘要、可信发布者、校验结果、隔离方式、状态 | 注册不等于授权；安装过程不让模型执行任意代码 |
| HarnessProfile | 工具/模型/策略/数据/记忆/判定器引用 | 发布时固定具体版本与哈希，禁止使用 latest |
| WorkflowDefinition | 图节点、绑定、条件、子流程、预算 | 草稿可编辑，发布版本不可变 |
| Invocation | 调用身份、输入摘要、权限、预算、状态、回执 | 每个实际调用有唯一记录；重试另有 attempt |
| ExecutionSession | 本次目标、标准、上下文、检查点、剩余预算、终止原因 | 记录固定配置及实际使用情况 |

运行时有效权限 = **批准的任务范围 ∩ 安装授予权限 ∩ 当前平台策略**。历史运行固定工具版本，但实时撤销权限必须生效；不能用“已固定”绕过撤销。

## 3. Manifest 示例（协议提案）

以下字段是待冻结的 v2 提案，不应直接写入现有 v1 契约。

```yaml
protocolVersion: aiqa.capability/2
id: example.http-read
version: 1.0.0
runtime: remote-http
entrypointRef: installation.endpoint
inputSchema:
  type: object
  additionalProperties: false
  required: [environmentRef, resourcePath]
  properties:
    environmentRef: {type: string, minLength: 1}
    resourcePath: {type: string, pattern: '^/[^/].*'}
outputSchema:
  type: object
  additionalProperties: false
  required: [status, artifactRef]
  properties:
    status: {type: integer, minimum: 100, maximum: 599}
    artifactRef: {type: string, minLength: 1}
effectClass: READ
permissions:
  network: environment-allowlist
  secrets: declared-refs-only
idempotency: read-only
recovery: safe-to-retry
cancel: cooperative
```

这只是结构示例。路径正则不能替代 URL 规范化、编码/重定向/DNS/连接层校验；READ 声明不能独自证明接口无副作用。实际采用工具前必须审核效果分类。凭据引用由运行器解析，明文不传给规划模型。

结构统一采用平台选定的 JSON Schema 子集：封闭字段、明确 null 与 missing、长度/范围、有限深度。契约冻结时明确 Draft 版本和引用规则，TS/Python 同一套正反向量；不让某一侧的默认强制类型转换悄悄接受另一侧拒绝的值。

## 4. 调用协议与生命周期

提案入口：`describe`、`validateConfig`、`execute`、`poll`、`cancel`、`reconcile`。同步只读工具可一次完成 execute；耗时工具返回调用引用。共享信封包括 protocolVersion、invocationId、projectId、executionId、nodeInstanceId、deadline、idempotencyKey、输入与允许权限摘要。

状态：`PENDING → CLAIMED → RUNNING → SUCCEEDED | FAILED | CANCELLED | UNKNOWN`。等待认证或人工裁决进入 session 的 WAITING，不伪装成工具成功。UNKNOWN 表示外部效果未知，需要 reconcile；不能自动当成可安全重试。

输出包括：结构化结果、Artifact 引用、使用量、效果回执、可重试性与明确错误码。业务 FAIL 可以来自一次技术上 SUCCEEDED 的检查工具；不得将工具成功等同业务通过。

- 执行前写入 intent 和租约 fencing token，校验输入、权限、预算、取消状态。
- 工具结果必须验证输出 Schema、文件归属与内容摘要；远程返回的路径不能直接当成可信本地文件。
- 提交结果时再次做版本/CAS 校验；过期 worker 的结果不能覆盖新状态或触发下游。
- 事件先持久化再推送；消费端按事件 ID 去重，事件断线从最后确认序号恢复。
- 无法可靠中断的远程操作如实标记 UNKNOWN，停止派发新动作，并核对可能的业务副作用。

### 写操作的特殊规则

任何会创建/改变业务资源的动作，必须声明：命名空间、业务幂等键或核对方法、资源台账、可用清理方式。网络超时发生在点击“提交”后时，先查询是否已创建，而不是再次点击。无法判断且无幂等保证时暂停求助。

平台保证的是防重复派发、幂等协作和可核对恢复，**不能对任意外部系统承诺 exactly-once 副作用**。

## 5. 图、绑定与循环

每个节点有独立 nodeId，能力 id 可以重复。输出引用使用节点实例 + Schema 路径，不能仅引用能力名。子流程与 map 的实例还包含父实例、迭代号/项目号。

| 结构 | 规则 |
|---|---|
| 顺序/并行 | 依赖满足后运行；并发受任务/环境/资源锁限制 |
| 条件 | 只支持受限表达式，不支持任意 eval；三值逻辑明确 UNKNOWN 分支 |
| 绑定 | 编译时检查类型；运行时检查值、归属和来源；可选输出不绑定为必需输入 |
| 子流程 | 固定发布版本；最大嵌套深度；递归调用拒绝 |
| retry | 最大次数 + 错误分类 + 总截止；业务断言失败不可用 retry 擦除首败 |
| repeat | 显式退出判定 + 最大次数 + 总预算；不能画无界循环 |
| map | 有限输入集、条数上限和最大并发；逐项结果与缺项对账 |
| fail/skip | 下游传播策略明确；skip 不计覆盖通过 |

外层图保持无环；循环只通过上述显式节点表达。静态校验发现循环引用、不可达节点、缺失绑定、危险权限、没有终止条件时禁止发布。结构有效不代表业务合理，发布预检还显示准备缺口与可能副作用。

## 6. 自主执行节点与不可变标准

一个 agent-loop 节点内部执行“观察—选择—行动—验证—调整”。每轮记录：当前观测引用、候选工具、选中理由摘要、动作输入、拒绝原因、结果、进展标记和预算。记录可审计的简短理由与证据，不要求保存模型私有思维链。

OracleSpec 由已批准业务规则生成并固定哈希。操作计划可以改变路径、定位、等待策略和数据构造，但不能改金额阈值、权限、预期状态、删除断言或跳过失败步骤后宣告通过。新建议标准需要新草稿、新批准、新运行。

三次等价无进展、策略振荡、预算耗尽、构建漂移、未知写入、缺少业务标准均有明确出口。恢复尝试保持首败，报告另列“首次结果”和“最终结果”。

## 7. 模型和 MCP 的边界

- 生成、视觉、结构化决策各自协议，模型 Profile 固定提供商、模型版本、超时和预算策略。
- MCP 桥只导入管理员选中的工具，映射输入/输出、效果分类、权限和取消/核对能力。
- 没有明确输出 Schema 或恢复保证的工具可以作为实验工具安装，但不能获得高风险写入授权。
- MCP 的文字描述、网页内容、仓库文件均是不可信数据，不能授权额外工具或修改业务标准。
- 工具安装本身属于管理员操作；模型无安装/发布权限。工具凭据和项目业务凭据隔离。

## 8. 调试、回放与发布

提供四种清晰标注的模式：Schema 自检、模拟 dry-run、记录回放、授权真实试跑。模拟不能代替真实网络/浏览器验收。回放禁止外部写入，缺失记录时失败，不偷偷回退真实调用。

调试包包含版本、脱敏输入、时间线、Artifact 摘要与差异；原始截图/网络体按受限证据策略访问。分享前检查凭据、个人数据与项目归属。

Profile 状态：DRAFT → VALIDATED → PUBLISHED → DEPRECATED/DISABLED。发布需静态校验、安装健康检查、最小正例与反例。回滚产生一个新的选择，不改历史 pin；撤销危险插件阻止新调用并提示受影响运行。

## 9. 验收矩阵

1. 新 SDK 样例安装并真实运行，核心 dispatcher 无修改。
2. 同一能力两个实例、嵌套子流程、有限 map/retry 均不串结果；无界循环拒绝。
3. 不同版本插件并存，旧运行恢复仍用固定版本；旧版本撤权后拒绝下一次动作。
4. kill 在写入前/写入后回执前/回执后提交前，分别验证无多余副作用或明确 UNKNOWN；不能伪造全部成功。
5. 双 worker 抢占、租约过期、队列重复、取消竞态，不产生重复有效提交。
6. 错输出 Schema、跨项目 Artifact、过期观察、路径逃逸、页面注入均被拒绝。
7. replay 不产生外网请求，分享包不含真实凭据。
8. 画布/表单往返保持同一 AST 和哈希；键盘能够创建、校验与发布模板。
9. 一条接入→上下文→多角色浏览器→API 核验→报告模板在真实组件上完成；不是只有 mock 输出。

实现分解与依赖见 [ROADMAP](ROADMAP.md)。
