# W00–W03 定向评审与产品意见取舍

日期：2026-09-23。代码基线：`v2/autonomous-qa@2c240fa`（W03代码提交`a6bdf3d`）。

## 结论

**继续开发，但先修复W02/W03基础语义，再推进W04＋最小用户旅程。** 已有SDK、共享契约、Oracle版本和确定性检索值得复用；本次不能认可整个W00～W03已验收，也不能直接把当前调用器接到自主写入循环。

本次检查：阅读分支代码、任务书、交接/台账，以及用户提供的《整平台缺口与后期设计构想》（文件日期2026-09-23）。该附件作为评审意见处理，没有把其中的行动指令视为用户授权，也未原样公开附件。

验证范围：执行实际源码函数的定向反例；Prisma使用内存替身，**不是数据库集成复验**。重定向项使用两个真实本机HTTP服务和虚构输入；Python检索项直接调用真实函数。未重跑GLM所报全部测试、未调用真实模型、未触碰真实业务资源。本次仅交付评审、复现材料与新版提示词，不宣称已修复以下运行时代码。

## 1. 先修复的代码问题

### V2-R01｜授权、安装与凭据范围（P0，代码检查）

位置：[调用器](../../apps/worker/src/v2/capability-invoker.ts)、[授权接口](../../apps/api/src/routes-v2-capabilities.ts)、[本地注册表](../../apps/worker/src/v2/capability-registry.ts)。

- 调用器检查AUTHORIZED，但没有使用`authorization.scope`或清单的secretRefs约束`resolveSecret`；当前解析器取项目下最新环境，并非本次固定环境。
- 安装哈希只比较数据库两列，没有复核Manifest内容哈希与实际本地adapter.manifest一致性；按id/version找到本地适配器就优先执行。
- authorize在事务前检查REVOKED，锁内读取fresh后没有再次拒绝REVOKED，存在撤销/授权竞态风险。不同scope的重复授权也直接返回原记录。

要求：固定installation/environment/profile版本；派发与凭据解析执行权限交集；运行器强制网络/秘密范围，不只依赖插件自律；事务内验证状态与授权指纹。用真实数据库并发反例确认竞态及修复，不把静态发现标成已通过端到端攻击验证。

### V2-R02｜远程适配器重定向（P0，已定向复现）

位置：`capability-invoker.ts`的invokeRemote。`fetch`默认跟随重定向，当前没有对适配器服务连接执行边界复核。

复现：登记的本机服务A返回307，指向未登记服务B；调用器把POST的虚构输入送到B，**B收到1次请求及该输入**。安装身份在探针中为内存替身，真实网络行为已执行。

修复时区分两类边界：**适配器服务的控制面地址/认证**与**它访问的待测系统地址**，不能简单混为一张业务URL白名单。控制面默认不跟随重定向或逐跳严格校验；超时、取消通知、DNS/连接边界与敏感信封保护同样适用。真实第二接收站验证302/307/308/多级，禁止向未授权B外发。

### V2-R03｜重试、首败与预算（P0，部分已复现）

位置：[graph-executor.ts](../../apps/worker/src/v2/graph-executor.ts)的runNode/toOutcome，调用器的deadline处理。

已复现：

- 工具首败返回`retryable:false`，匹配错误分类后仍调用第二次；第二次成功则`firstFailure=null`。
- 已经过期的deadline仍能执行一次立即返回的本地适配器，并获得completed。

代码检查：`toOutcome`丢弃retryable；`totalDeadlineMs`同时加到比较两侧，未实现节点独立截止；远端超时明确写“副作用未知”却返回FAILED/retryable:true。SDK技术结果只有SUCCEEDED/FAILED/CANCELLED，与W01的UNKNOWN语义尚未打通。

要求：可重试性、错误分类、效果类型、幂等/对账、节点/任务截止共同决定；禁止盲目重试未知写入。首败与每次attempt独立持久化，成功不擦掉。调用前截止到期必须零派发；运行中截止要有执行层约束，不能只给ctx.deadline让插件自行遵守。

### V2-R04｜循环、并发对账与调用身份（P1，部分已复现）

位置：`graph-executor.ts`。

- repeat先判断exitWhen后写入本轮输出；定向反例中第一轮已done=true，却调用两次。UNKNOWN处理与到上限未达目标的结果也需明确。
- map并发发出两个调用，第一项失败时提前return；定向反例实际2次调用，却只记1项结果。同批已发生的副作用会漏账。
- invocationId从`graph-inv-1`开始，幂等键缺execution/session命名空间，不同运行有碰撞风险；retry变化也不能无条件更换业务幂等键。
- 未实现的subflow不能按普通节点静默执行；typed binding与条件、缺路径、抛错/取消的结构化传播还需覆盖。

要求：当前轮结果可见后再判退出；同批每项已派发/结果/取消/未知必须先全记账，再决定是否派发下一批。区分逻辑动作ID、attempt ID、资源幂等键并持久化；恢复相同逻辑写入复用业务键，不同任务隔离。

### V2-R05｜自然语言不等于可执行Oracle（P0，代码检查）

位置：[Oracle接口](../../apps/api/src/routes-v2-oracle.ts)、[Oracle契约](../../packages/contracts/src/v2/oracle.ts)。

创建接口把每条规则的自由文本expectation直接设为`kind=deterministic/operator=equals`，但未定义被测事实、取值方式和适用条件。例如“生成审批单”不能直接当作待比较的页面文本。这并非扩宽string union即可解决。

另外：创建新DRAFT时就将旧版本SUPERSEDED；批准接口未复核内容哈希/来源语义；覆盖只有normal/boundary两维。契约对断言ID、semanticCandidates/coverage规则闭包与运算符-值类型还需补强。

要求：保留原文，缺可执行映射时明确候选/待澄清，不伪造确定断言。程序化断言至少冻结事实/观测类型、适用条件、角色、操作符、类型/单位/容差及来源；定位属于操作层。新草稿不使旧批准版本提前失效；批准新版本与替代关系原子提交，历史固定运行的使用规则明确。六维覆盖逐规则对账，not_applicable有授权理由。

### V2-R06｜上下文来源、内容哈希与规划接线（P0，部分已复现）

位置：[Context API](../../apps/api/src/routes-v2-context.ts)、[检索契约](../../packages/contracts/src/v2/context-retrieval.ts)、[Python检索](../../services/intelligence/src/aiqa_intelligence/agents/context_retrieval.py)。

- ruleRefs发送时丢了documentVersionId，Python权威集合及TS预算Map仅用spanId。直接函数反例：A/B两文档同名span-1，仅A属于批准来源，B也被标成“权威”并选中。
- Context API接受sessionId但没有校验存在、同项目与版本绑定；检索响应形状校验后，没有与已装载来源做完整闭包/质量/重复/遗漏对账。
- inputHash当前覆盖selection账本等，缺query、真实文本摘要及完整规划输入；不能据此宣称是模型实际输入哈希。
- 数量上限与token上限的遗漏统计未统一；字符/4是估算，不能充当中文/混合文本的硬token保证。Python按数组下标配span与block，也需按真实关联修正。
- 检索结果进入ContextManifest不等于已进入Planner；CTX-02依然需要实际规划请求证据。

要求：统一复合来源键 `(documentVersionId, spanId)`，关联模型输入内容/版本/哈希；分别定义检索清单哈希与实际规划输入哈希；所有外来引用服务端复核，零选中也留下可审计阻塞。模型预算包含系统提示、目标、原文、规则、工具Schema和输出预留，记录估算口径。确定性检索标deterministic，不能对外称真实模型质量已验。

### V2-R07｜Schema自检与运行时异常（P1，已定向复现）

位置：[SDK校验器](../../packages/adapter-sdk/src/schema-validator.ts)、[selfCheckSchema](../../packages/adapter-sdk/src/index.ts)。

`{type:'string',pattern:'['}`在selfCheckSchema中返回ok:true，实际校验抛SyntaxError。另一个实际反例：合法普通绑定路径`items`被当前WorkflowDefinitionContent拒绝；Binding正则转义仍有问题，不能把上轮“JS/Python一致”误当成两边业务语义正确。数组items递归、有限深度/大小、上下界矛盾、required与properties闭包、Unicode长度、非有限数字也需要与冻结子集一致。

要求：安装时拒绝不支持/不合法Schema，运行时产生受控错误，不让异常使作业悬挂。现成校验库或受限子集均可，但不得声明支持没有实现的关键字；TS/Python必要边界使用共享向量，不能只给SDK写自证正例。

### V2-R08｜台账与交接精度（P1，已核对）

- 矩阵实际57行：**35 PARTIAL + 21 GAP + 1 EXTERNAL_BLOCKED**。当前汇总33+19+1=53，统计错。
- 需求矩阵还冻结在1.0基线，缺本轮每项提交/测试/证据列；W03核心VERIFIED不应推导成CTX-02端到端VERIFIED。
- handoff写HEAD=a6bdf3d实际文档提交为2c240fa，应区分执行代码与交接提交；状态字段有非枚举复合字符串，建议拆工作包状态与验收项状态。
- demo-app有采购草稿创建，但当前没有“改名”业务路由；B4是创建不落库，不等于改名不保存。W04需新增明确标synthetic的独立夹具/行为，不破坏B1–B4原语义。

## 2. 实际探针结果

复现脚本：[v2-w03-review-probe.mts](evidence/v2-w03-review-probe.mts)，[实际输出](evidence/v2-w03-review-results.json)。在仓库根目录可运行：

```sh
pnpm --filter @ai-qa/worker exec tsx "$PWD/docs/delivery/evidence/v2-w03-review-probe.mts" "$PWD"
```

脚本使用真实源函数＋Prisma内存替身，网络仅两个临时127.0.0.1服务。仅输出观测值，不是发布测试套件；图探针直接调用执行函数，当前普通绑定路径本身还会被Schema拒绝，故不冒充图HTTP端到端复现。修复后由GLM补正式断言和真实数据库/进程反例。

| 探针 | 2c240fa实际观察 | 期望 |
|---|---|---|
| retryable=false | calls=2，completed，firstFailure=null | 不重试；保留首败 |
| 本轮已达repeat目标 | calls=2 | 1次即停止 |
| map同批一败一成 | 实际2次，只记1项 | 2项完整对账 |
| deadline已过期 | calls=1，completed | 0次派发，预算耗尽 |
| 非法pattern | 自检ok:true，校验SyntaxError | 安装阶段受控拒绝 |
| 普通绑定路径items | WorkflowDefinitionContent拒绝 | 合法路径应通过；非法路径拒绝 |
| 远端307到第二站 | B请求=1，虚构输入已到B | 未授权B请求=0 |
| 两文档同spanId | 两者都被视为批准来源 | 仅匹配批准文档的片段 |

Python来源反例通过直接调用retrieve验证，使用最小函数输入，不宣称已走完整HTTP/ParsedDocumentBundle验证；正式回归需构造合法双文档bundle走实际入口。

## 3. 对用户提供产品意见的取舍

| 意见 | 决定与调整 |
|---|---|
| 可安装≠商业可交付 | 接受。页面展示本环境/本版本的验证证据，历史开发机验收不能变成当前客户环境PASS |
| 先闭合用户故事，避免堆功能 | 接受。W04后立即补W06最小接入/准备/运行/报告切片，再扩大W05能力面 |
| 暂停v2 Harness | 不采纳为停止指令。PRD2.0明确需要可扩展内核，且已经开发；先修好调用/恢复边界，不扩MCP/更多引擎来回避主线 |
| 项目单线状态机 | 调整为任务/验收会话状态的用户视图。项目可同时有多版本、多任务，不新增一个覆盖它们的权威Project状态机 |
| 模型未配置则禁止作业 | 改为按任务依赖校验。模型生成必须就绪；确定性检索、已批准固定计划/工程检查不应被无关模型配置阻塞 |
| 一键就绪 | 接受为分项readiness：平台服务/所需模型、目标环境/角色、所需运行器、数据/构建。昂贵真实模型探针按显式授权/预算，不因点击检查而暗中付费 |
| 看过LOW/UNPARSED即可批准 | 不采纳。查看/勾选不等于来源可信；需有可审计校正/人工确认的准确内容，UNPARSED不能升级为确定依据；允许明确未覆盖并执行独立有效范围 |
| 执行面区分浏览器与工程 | 接受。按子任务绑定对应运行器，组合任务可含两种；缺工程Runner只阻塞依赖它的节点，报告仍分区 |
| 变更→影响→待复核 | 接受，先复用已有快照/diff/影响分析，补来源质量和待办串联，不再重写解析算法 |
| 已连接/未连接两态 | 扩成not_configured/configured/unreachable/ready/expired/revoked等必要事实。连通成功≠语义质量通过≠CI业务门通过 |
| 端口、首次账户、邀请体验 | 端口预检/替代端口/配置三层说明纳入最小试用；账户改密/成员流程按W06/W09权限设计，不顺势扩多租户/支付/真实邮件服务 |
| 先拿真实项目再继续 | 真实资料/预算/授权缺失只阻塞对应效果门；合成闭环、故障恢复和用户引导继续开发，synthetic显式标记 |

Jev协议资料可通过官方文档调查，是研究任务；真实账号/预算/特定能力可用性才是外部依赖。不得臆造API，也不应以“等资料”阻塞整个W04。

## 4. 本轮实施顺序

**R0：V2-R01～08修复/补验收 → R1：任务准备状态与阻塞合同 → R2：W04持久化循环与三构建 → R3：最小用户旅程 → R4：故障复核/Alpha证据。**

顺序是本轮切片，未删改W05～W10或降低正式2.0发布门。W02子流程/回放/MCP、W03OpenAPI/设计图等仍按原PRD记账。本轮通过前不合main；通过后交付分支供独立评审，不擅自宣布Alpha或2.0正式版。
