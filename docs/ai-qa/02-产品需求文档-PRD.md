# AI 测试人员 PRD

版本：v0.1 · 日期：2026-09-16 · 优先级：P0 首版必需 / P1 试点后扩展

> 历史规格：2026-09-20 新增 [产品 1.0 PRD](../product/v1.0/PRD.md) 和 [交互原型](../product/v1.0/prototype/README.md)，以新稿明确的范围调整为准；现行契约约束仍须保留，实际进度见 implementation-status.md。

## 1. 背景、定位与目标

多人借助 AI 开发各自模块并合并后，仍可能出现跨模块状态、权限、数据和业务流程不符合需求的问题。本产品根据业务资料独立验收运行中的系统，承担测试用例设计、执行、报告和复测工作。

**核心输入**：版本化产品资料、合并后测试环境、角色账号、数据准备方式。

**核心输出**：有来源的规则、可执行用例、完整执行证据、缺陷与未验证范围、版本复测报告。

### 1.1 首版默认假设

- 单组织私有部署，组织内多个项目；平台包含管理员、测试负责人、只读查看者。
- 待测对象为测试环境中的 Web 管理后台；首版浏览器为 Chromium。
- 主场景是申请/审批/订单等 CRUD 与跨角色状态流转；至少两个角色，至少两个业务模块。
- 不要求客户提供产品源码；版本号与部署清单由客户或部署流程提供。
- 中文界面；内部 ID 与枚举使用稳定英文值。
- 部署后可自动触发执行；有歧义的规则等待澄清，已批准规则的定常回归无需每轮人工批准。

### 1.2 成功定义

用户导入资料并完成一次接入后，能够生成可追溯用例，在新构建部署完成时运行选定用例，查看具体问题并在下一构建复测。每个“通过”都具有已执行的必要检查和证据；没有证据的用例不能通过。

### 1.3 首版范围

P0：文本型资料与原型图片、规则与用例版本、角色账号、数据夹具、浏览器执行、程序化/视觉检查、证据、缺陷、复测、平台权限、预算与基本部署触发。

P1：扫描 PDF OCR、Figma/Axure 等外部原型连接器、任意网站爬取、移动端、多浏览器矩阵、压测、安全专项、生产巡检、多组织 SaaS 计费、第三方缺陷平台集成、自动推导复杂变更影响范围、Browser Use/Codex 扩展执行器。

“并发审批冲突”属于有价值的后续测试维度；首版必须支持多角色顺序协作，真正并发业务操作在 P1 实现，报告明确该覆盖缺口。

## 2. 用户与权限

| 用户 | 权限 |
|---|---|
| 管理员 | 管理平台用户、项目访问、模型/网络配置、密钥引用与保留策略 |
| 测试负责人 | 导入资料、批准规则和用例、配置项目测试账号、运行/取消/复测、维护缺陷 |
| 查看者 | 查看授权项目的用例、脱敏结果与报告，无执行和配置权限 |

平台角色与“待测系统中的申请人/主管”是两个概念。所有项目读写、附件下载和执行控制都做服务端鉴权；不可仅在前端隐藏按钮。

## 3. 端到端流程

1. 创建项目与测试环境，登记允许访问的目标域名、构建标识与依赖域名。
2. 配置模型与角色账号，验证连接、登录和必要测试数据。
3. 导入文档，生成不可变 DocumentVersion 和可定位 SourceSpan。
4. 模型提取 Rule 草稿，区分明确要求、推测和未知；生成冲突/缺口列表。
5. 测试负责人一次性或批量批准清晰规则，解决冲突；清晰无争议部分可继续。
6. 生成 TestCaseVersion 草稿，逐项关联规则、步骤、数据和预期检查；批准可执行用例。
7. 智能体探索当前页面，绑定现场观察到的定位信息，生成受限 TestPlan。
8. 冻结本轮需求、用例、执行计划、模型设置、环境配置与构建版本。
9. 初始化独立数据，运行浏览器步骤与检查，保存证据和每次尝试。
10. 聚合报告，创建失败对应的缺陷候选；新构建运行相关用例及基础回归。

## 4. 功能要求与验收

### FR-01 项目与环境接入（P0）

字段：项目名、baseUrl、授权目标/依赖域名、环境名、buildId、可选服务版本清单、登录方法、角色凭据引用、夹具配置、预算与超时。

- 支持账号密码和管理员预先导入的浏览器登录态。验证码、MFA 或 SSO 无法自动完成时返回明确阻塞原因，允许按项目策略刷新登录态后新建尝试。
- 同一构建测试期间发现部署版本变化，标为环境漂移，不能给出该构建全部通过的结论。
- 缺构建标识可调试运行，但报告标记“版本未验证”，不作为完整版本验收。
- 接入检查只验证连通性、登录和数据条件，不等价于业务通过。

验收：申请人与主管使用独立会话；账号过期时显示 BLOCKED/AUTH，未运行断言计数为零；配置错误可定位到具体字段。

### FR-02 资料导入与来源（P0）

- 接受 Markdown/TXT、DOCX、具有文本层的 PDF、PNG/JPEG 原型图。默认单文件不超过 20 MB，文本型 PDF 不超过 200 页，限制可配置。
- 保存原始文件、校验和、解析器版本、提取时间、解析覆盖情况。
- 来源定位：Markdown 行或标题；DOCX 标题+段落/表格单元格（不编造页码）；PDF 页码；图片 ID+可选区域坐标。
- 表格要保留行列关系。图片走视觉模型；无法识别文字时标记低质量/待处理。
- 扫描 PDF 首版提示“不支持/需 OCR”，不得返回空文本并显示解析成功。
- 新上传相同文件可复用解析，但版本关联必须明确；不同内容产生新版本。

验收：每条提取规则能打开真实来源；文件中未成功解析的部分必须显式展示；解析失败可重试且不丢原文件。

### FR-03 规则分析与澄清（P0）

RuleVersion 包含角色、前置状态、动作、条件、预期、禁止行为、优先级、来源和确认状态。

- 分类为 EXPLICIT（有明确依据）、INFERRED（推测）、UNKNOWN（资料不足）。模型置信度不能代替业务批准。
- 检测相互矛盾的阈值、角色权限和状态描述；冲突条目必须关联各方来源。
- 默认不自行决定 PRD 与原型的优先级；项目负责人可声明版本优先级，决策留痕。
- 人工补充业务说明保存为有作者与时间的来源，不能伪装成原文。
- 批准、驳回、修订产生审计记录。被引用的已批准版本不可原地覆盖。

验收：文档只写“超过 5,000 元”，可确定 >5000 的规则；如果未定义 <=5000 的处理方式，边界预期保持未知；不能自动补出“直接付款”。

### FR-04 用例生成与维护（P0）

- 根据批准规则生成正常、异常、边界、权限、状态流转、跨模块一致性和持久化用例。
- 首版确保需求范围内的关键跨角色路径被覆盖；不承诺自动穷举所有业务组合。
- 每条用例有规则版本引用、前置条件、角色、数据策略、操作步骤、预期检查、清理策略和优先级。
- 生成后验证来源存在、角色合法、引用闭合、断言非空、执行能力可支持。
- 不可执行条件应变为缺口项；不要生成“待定”预期并把用例设为可执行。
- 人工修改、批准与批量操作可用；修改生成新版本。
- 资料更新后，受影响的规则与用例标为 NEEDS_REVIEW。旧基线可保留运行，但必须标识针对旧需求版本，不能宣称覆盖新资料。

验收：可从需求跳到用例再跳到运行证据；任一 required=true 的检查缺失都不允许该用例通过。

### FR-05 页面探索与计划绑定（P0）

- 需求预期冻结后，允许模型读取 DOM/可访问性信息、截图并使用受限操作工具探索页面。
- 页面探索优先使用指定测试数据和可重置环境；探索属于独立 session，不能复用为正式执行证据。
- 绑定优先顺序：经实际观察的 testId、角色+可访问名称、标签、稳定文本；有歧义时不猜测第一个元素。
- 绑定记录页面 URL、观察时间、页面证据和目标引用。视觉操作通过当前页面的 Midscene 适配器完成。
- 计划包含可解释步骤与断言；生成程序校验 JSON Schema、允许动作、数据引用与来源后才能入库。
- 平台提供定位/角色绑定修正入口；人工修正留痕。

验收：对未观察到的按钮返回重新观察或 REVIEW，而不是凭空创建 selector；不能以探索结果覆盖已批准的预期状态。

### FR-06 数据与多角色执行（P0）

- 每次 case attempt 有独立 runNamespace 和数据记录，按项目允许接口/专用测试脚本初始化与清理。
- 夹具由管理员维护可信模板；模型只能传入校验后的参数，不得生成 SQL 或 shell 执行。
- 业务创建步骤本身是测试目标时必须从该步骤执行，不能用夹具提前跳过。
- 每角色独立 BrowserContext；业务 ID 可在步骤之间传递，Cookie、登录态不能互传。
- 两个 worker 不能并发使用相同独占数据。支持环境/数据锁或独立命名空间。
- 默认最多两个独立用例并发，同一用例步骤有序执行；可配置降为串行。
- 下载文件保存到该尝试的受控目录，检查内容后作为附件证据。

验收：连续两次执行不会互相污染；审批后通过申请人和主管页面验证相同业务 ID；清理仅针对本次命名空间数据。

### FR-07 自动执行与判定（P0）

- Playwright 管理会话、操作、程序化断言与 trace；视觉步骤通过复用当前 page 的适配器完成。
- 每条断言记录 expected、actual、判定、时间和证据。数值使用明确单位与 decimal 或最小货币单位，不做字符串近似匹配。
- 可观测性以业务要求决定：UI-only 用例不能声称已经证明服务端权限；需要验证直接越权请求时使用授权接口检查，否则该范围标为未验证。
- 对持久化要求，刷新/重新登录或授权数据查询后检查；成功 toast 不足以证明持久化。
- 对异步要求保存 waitPolicy 与来源。项目定义的技术超时只能形成工程假设；缺业务 SLA 时，超时不自动证明业务需求违规。
- LLM 可解释失败原因，但必需的确定性断言由执行器判定；视觉判断不足以单独证明金额、权限等核心业务事实。
- 视觉断言返回结构化判定与证据，无法清楚判断则 REVIEW，不返回猜测的通过。

验收：只出现“操作成功”提示、数据实际未落库的缺陷，在有持久化预期的用例中被发现。

### FR-08 异常、恢复和脚本维护（P0）

- 有限重试；默认最多一次额外尝试，完整保留历史。首次失败后通过的 case 设 unstable=true。
- 只读模型请求遇到 429/暂时网络错误可有限退避；点击提交等有副作用动作不得在状态不明时盲目重放。
- Worker 失联或进程中断后，先检查业务 ID/操作结果；无法判断提交是否发生则 BLOCKED/UNCERTAIN_SIDE_EFFECT，交由重置夹具或人工处置。
- 自动维护只提出定位或有依据的等待调整，保存补丁前后版本。不能改角色、业务数据含义、required、operator、expected、规则引用。
- 使用 acceptanceHash 对受保护字段做规范化哈希；包括需求规定的时限、观察窗口和失败容差，不能以“调整等待”为名放宽业务 SLA。变更时拒绝自动修复并产生待审修改。
- 用户取消后停止新的动作与模型调用，在可控范围内结束在途操作并清理，无法终止的请求有状态说明。

验收：弱化断言或跳过失败步骤的补丁被拒绝；一次重试成功不能改写原尝试；未知副作用不会导致重复订单。

### FR-09 证据、缺陷与复测（P0）

- 存运行与尝试版本、步骤时间线、检查结果、截图、控制台异常、必要网络元信息及 trace 引用。
- 凭据、Authorization、Cookie、敏感输入不进入模型上下文、普通日志或脱敏报告。
- 原始 trace/截图可能仍有业务敏感内容；单独标为 restricted_raw，限制授权访问和保留时间，不宣称已经完全脱敏。
- 创建缺陷候选需有规则来源、实际违反的断言和证据；模型仅给出猜测时保留 REVIEW。
- 缺陷按规则+失败检查+模块+错误签名聚合，订单号等动态值不能导致大量重复缺陷；不同构建的 occurrence 单独保留。
- 状态：CANDIDATE → CONFIRMED → FIX_PENDING → READY_FOR_RETEST → VERIFIED；另有 REJECTED、REOPENED。首版复测通过后由负责人确认 VERIFIED，历史记录不可删除覆盖。
- 复测基于新 run 链接旧缺陷，固定需求/用例基线或明确记录已批准的变更，不能把新用例的通过直接覆盖旧缺陷。
- 导出 JSON 和 Markdown 报告；HTML 作为 P0 页面展示，可下载版本视实现成本安排。

验收：开发者能从报告定位具体需求、重现步骤和实际数据；证据链接必须指向存在且有权限校验的文件。

### FR-10 覆盖与版本报告（P0）

- 显示用例总量、PASS/FAIL/BLOCKED/REVIEW/NOT_RUN、unstable 数、未解析资料、待确认规则与不支持范围。
- 规则覆盖率 = 基线中具有已批准用例的规则数 / 基线中应测试的已批准规则数；这不证明资料已完全理解。
- 用例执行率 = 已形成 PASS 或 FAIL 的用例数 / 本轮选定用例数；BLOCKED/REVIEW 不算完整执行。
- 通过比例 = PASS 数 / 本轮选定用例数，同时展示完整状态分布。分母为零显示 N/A，不能显示 100%。
- 严格验收状态：有 FAIL 为 FAIL；否则有阻塞、待确认、未执行、unstable、构建漂移或验收所需证据缺失为 INCOMPLETE；非空范围内全部符合才为 PASS。
- 有解析缺口的范围不得给出“全部需求已通过”；可明确表达“选定基线通过，资料覆盖不完整”。

### FR-11 配置、用量与运行模式（P0）

- 每项目明确 real/mock 模式；模式影响 UI、数据、报告和 API，不能只在日志中显示。
- mock 为开发与演示，输出标记 simulated；其结果从真实效果指标和发版判定中排除。
- 缺真实密钥、账号、网络或依赖时 real 模式返回配置错误，不得自动降级为 mock。
- 文本与视觉模型分别配置 provider/baseUrl/model，平台记录 capabilities；不硬编码某个套餐或永久模型名。
- 输出必须 schema 校验；最多两次受限格式修复，仍失败则 REVIEW/MODEL_OUTPUT_INVALID。
- 默认每用例 50 次工具动作、20 次模型请求、5 分钟截止；这些是首版可配置工程限制，不是业务 SLA。
- 每轮有最大请求数、token 额度和时间上限；按已知价格可估算金额，价格未知显示未知。达到上限前停止新调用，在途请求可能超出估算。

### FR-12 部署触发与运行管理（P0）

- 手动启动、取消、复测；部署 webhook 携带 projectId、environmentId、buildId、eventId 和签名。
- 验证签名、时间窗、事件去重、目标环境就绪后再排队。就绪失败返回阻塞报告，不启动业务操作。
- 返回异步 jobId/runId，可查询状态、事件和最终报告；前端用 SSE 或轮询展示实际进度。
- 环境标为 production 的目标在首版禁止业务测试；已登记测试内网可访问，禁止泛化屏蔽所有内网而使客户测试环境不可用。

## 5. 执行状态契约

### 5.1 三种状态分别存储

**Run.lifecycle**：QUEUED → PREPARING → RUNNING → FINALIZING → FINISHED；另有 CANCEL_REQUESTED → CANCELLED、ERROR。终态不可回退。ERROR 表示平台执行故障，不等于业务 FAIL。

**Case.verdict**：PASS / FAIL / BLOCKED / REVIEW / NOT_RUN。

**reasonCode**：BUSINESS_MISMATCH / ENVIRONMENT / AUTH / TEST_DATA / LOCATOR / MODEL / TIME_BUDGET / UNCERTAIN_SIDE_EFFECT / UNSUPPORTED / CANCELLED / NONE。可在详细事件中补充子码。

Assertion.result：PASS / FAIL / REVIEW / NOT_EVALUATED。

### 5.2 用例聚合规则

1. 有可信、已批准必需断言 FAIL，则 case FAIL，即使后续步骤又受阻，仍保留已发现缺陷和未执行部分。
2. 没有 FAIL，但关键步骤因环境/凭据/预算等无法完成，则 BLOCKED。
3. 没有前两项，但业务预期或观察证据不充分，则 REVIEW。
4. 从未开始的选定用例为 NOT_RUN。
5. 已开始、必要步骤完成且所有必需断言 PASS、证据完整，才为 PASS；空断言集合禁止 PASS。

多个 attempt 不能被覆盖。case 保存 latestVerdict、attemptIds、unstable，并记录为何重试；run 的严格验收状态按 FR-10 计算。

## 6. 数据模型（开发契约）

所有实体含 id、createdAt；可变实体含 updatedAt。项目实体强制 projectId；跨表引用校验同项目。版本表只追加。删除采用归档；报告引用的版本不可物理删除。

| 实体 | 关键字段 |
|---|---|
| User / ProjectMembership | 用户、角色、项目访问范围 |
| Project | name、settings、activeBaselineId |
| Environment | baseUrl、allowedOrigins、dependencyOrigins、isProduction、secretRefs、buildMetadata、revision |
| Document / DocumentVersion | checksum、storageKey、format、parseStatus、parserVersion、coverageSummary |
| SourceSpan | documentVersionId、locator、quotedText、imageRegion、extractionQuality |
| Rule / RuleVersion | sources、classification、businessFields、approval、reviewStatus、supersedesId |
| Clarification | ruleVersionIds、question、answer、answerSource、resolvedBy |
| TestCase / TestCaseVersion | ruleVersionIds、roles、dataSpec、steps、assertions、cleanup、approval、acceptanceHash |
| TestPlanVersion | caseVersionId、bindingEvidenceIds、actions、assertions、schemaVersion、acceptanceHash |
| Baseline | approved ruleVersionIds/caseVersionIds、scope、exclusions |
| Run | baselineId、selectedCaseVersionIds、environmentSnapshot、buildId、mode、modelConfigSnapshot、lifecycle、budget、idempotencyKey |
| CaseExecution / Attempt | runId、caseVersionId、attemptNo、namespace、lifecycle、verdict、reasonCode、unstable |
| StepExecution / AssertionResult | attemptId、step/assertionId、timestamps、actual、result、evidenceIds |
| Artifact | projectId、attemptId、storageKey、type、sensitivity、checksum、expiresAt |
| Defect / DefectOccurrence | fingerprint、sourceRuleVersion、assertionId、status、severity、run/attempt/evidenceRefs、retestRefs |
| ModelInvocation | provider/model、promptVersion、requestId、usage、estimatedCost、latency、outcome，不存密钥 |
| AuditEvent | actor、action、entity、before/afterRefs、timestamp |

数据库至少约束：(runId, caseVersionId, attemptNo) 唯一；项目内 idempotencyKey 唯一；源引用、规则与计划外键存在；重复 webhook eventId 不创建第二个 run。

## 7. 结构化测试计划契约

名称：TestPlan v1。定义并验证 JSON Schema/Zod，禁止任意函数体、shell、SQL、eval、文件系统访问。

### 7.1 允许动作

`goto`、`fill`、`click`、`select`、`switchRole`、`captureValue`、`waitFor`、`assert`、`visualAction`、`visualAssert`、`downloadCheck`、`apiCheck`。

- 目标使用 observed targetRef，或明确的 locator 类型（testId/role/label/text），保存相应观察证据。
- `fill` 等值来自字面量、命名空间数据、先前 captureValue 或凭据引用。凭据仅在执行时注入。
- `apiCheck` 只能使用项目预先登记的请求模板，限制方法、路径和可传参数；校验服务端权限时使用当前角色凭据。
- 变量引用必须由之前步骤定义，无循环、无任意表达式执行；首版只允许有界轮询与显式顺序分支，分支语法需 schema 列明。
- 每个动作标注副作用类别 READ/WRITE；WRITE 不允许状态不明时重放。
- 视觉动作只定位/操作；关键业务结果仍引用批准断言。视觉操作不能偷偷包含“修改后端让测试通过”。

### 7.2 示例（展示结构，ID 为示例，正式计划须引用实际库中对象）

```json
{
  "schemaVersion": "1.0",
  "caseVersionId": "tc-order-001-v1",
  "ruleVersionIds": ["rule-approval-v1"],
  "roles": ["applicant", "approver"],
  "acceptanceHash": "computed-by-server",
  "actions": [
    {"id": "s1", "type": "switchRole", "role": "applicant", "effect": "READ"},
    {"id": "s2", "type": "goto", "path": "/orders/new", "effect": "READ"},
    {"id": "s3", "type": "fill", "targetRef": "observed-amount", "value": "5000.01", "effect": "READ"},
    {"id": "s4", "type": "click", "targetRef": "observed-submit", "effect": "WRITE"},
    {"id": "s5", "type": "captureValue", "targetRef": "observed-order-id", "saveAs": "orderId", "effect": "READ"},
    {"id": "s6", "type": "assert", "assertionId": "a1", "effect": "READ"}
  ],
  "assertions": [
    {
      "id": "a1", "stepId": "s6", "required": true,
      "ruleVersionId": "rule-approval-v1", "kind": "ui.text",
      "targetRef": "observed-order-status", "operator": "equals", "expected": "待审批"
    }
  ]
}
```

上例 fill 按不提交的演示表单标为 READ；存在自动保存的字段必须按 WRITE 处理。完整场景须追加审批人操作及申请人刷新核对，不能把此片段当作全流程通过。

批准的断言、expected、operator、required、角色、测试数据语义、来源规则和业务时限等字段纳入 acceptanceHash；批准状态是工作流元数据，不纳入语义哈希；locator 绑定单独 version。由服务端计算，模型传入哈希不得直接信任。

## 8. API 与异步作业（建议路径，实现需 OpenAPI 契约）

| 接口 | 行为 |
|---|---|
| POST /api/projects | 建立项目 |
| POST /api/projects/:id/environments | 登记环境和凭据引用 |
| POST /api/environments/:id/check | 202 接入检查 job |
| POST /api/projects/:id/documents | 上传；202 解析 job |
| POST /api/projects/:id/rule-extractions | 指定 documentVersionIds；202 |
| POST /api/rule-versions/:id/approve | 批准并记录操作者 |
| POST /api/clarifications/:id/resolve | 保存回答及来源 |
| POST /api/projects/:id/case-generations | 指定规则版本；202 |
| POST /api/case-versions/:id/approve | 校验后批准 |
| POST /api/case-versions/:id/bindings | 指定环境；202 生成计划 |
| POST /api/projects/:id/baselines | 固定本轮批准版本 |
| POST /api/runs | baselineId、caseVersionIds、environmentId、buildId、mode、budget；202 |
| POST /api/runs/:id/cancel | 幂等申请取消 |
| GET /api/runs/:id | 生命周期、结果、成本与进度 |
| GET /api/runs/:id/events | SSE；支持 Last-Event-ID |
| GET /api/runs/:id/report | 完整状态分布与覆盖范围 |
| POST /api/defects/:id/retests | 指定新构建和环境；202 新 run |
| GET /api/artifacts/:id | 鉴权后受控下载 |
| POST /api/webhooks/deployments | 签名/时间窗/事件去重 |
| GET /api/jobs/:id | 资料与用例生成等异步任务状态 |

POST /runs、retests 与 webhook 接受幂等键；相同键不同请求体返回 409，相同键相同请求返回原对象。并发版本冲突返回 409，参数校验 422，缺配置 503/具体错误码，权限问题 401/403。

错误体统一含 code/message/requestId/details；details 不泄露密钥。异步作业必须落库，不能靠浏览器页面打开状态维持。

## 9. 工程架构与依赖决策

### 9.1 默认技术路线（方案选择，不是唯一实现）

- TypeScript + pnpm workspace，Next.js 前端，Fastify API。
- PostgreSQL + Prisma；Redis + BullMQ 管理异步任务。
- 独立 Node.js worker 管理 Playwright 与 Midscene 适配器。
- 对象存储接口保存证据；本地开发使用受控磁盘目录，试点可切换 S3 兼容存储。
- Docker Compose 本地运行数据库、队列、应用、worker 和独立 demo-app。
- 模型适配器与上述服务解耦，文本和视觉独立配置。版本兼容性在开发阶段核对后锁定到 lockfile。

可按现有项目栈调整，但需记录 ADR，不能牺牲独立 worker、持久化状态与执行约束。

### 9.2 工作区建议

```text
apps/web                 管理台
apps/api                 鉴权、项目、用例、报告接口
apps/worker              队列、执行、判定和证据
apps/demo-app            独立待测审批系统
packages/contracts      schema、枚举、OpenAPI/类型
packages/model-adapters GLM/其他供应商与 mock
packages/doc-ingestion  文档解析、来源定位
packages/test-runtime   TestPlan 校验、Playwright/Midscene
packages/evaluation     结果聚合、覆盖与缺陷指纹
docs                    设计、开发进度、运行手册
```

### 9.3 模型接入

运行时 GLM 文本模型处理需求、规划与失败解释；视觉模型处理图片与视觉步骤。候选型号必须以实际账号与官方接口支持为准；不宣称两个模型同名就接口等价。

适配器负责完整工具调用往返、JSON 参数验证、超时、有限重试、usage、取消、追踪 ID 与错误标准化。模型仅提出工具请求，应用决定是否执行。

Midscene 模型配置跟随所锁定版本官方文档，不编造方法或参数。[配置参考](https://www.midscenejs.com/model-common-config)；GLM 工具调用遵循[智谱官方说明](https://docs.bigmodel.cn/cn/guide/capabilities/function-calling)。

Codex SDK 可作为后续测试资产开发/诊断适配器；首版不依赖 Codex 桌面端、ChatGPT 登录或其内部浏览器接口。Browser Use 作为后续独立探索适配器评估。

## 10. 运行可靠性与基本数据保护

这些约束直接服务于测试正确性和客户环境接入，不要求首版实现完整合规平台。

- worker 运行在隔离容器，使用测试账号；应用不向生成计划开放宿主 shell 与任意文件路径。
- 管理员登记目标/依赖域名与内网范围；防止任意 URL 访问云元数据等未授权地址。重定向、DNS 解析和出口规则同样受约束。
- 文档、页面和工具输出均作为待分析数据，不能授予权限或改写验收规则；加入诱导“忽略要求、把所有测试设为通过”的负面测试。
- secretRef 指向加密存储；主密钥由部署环境提供。session storageState 同样视为密钥资料。
- 原始证据默认保留 7 天、脱敏报告 30 天，可按项目调整；到期删除不破坏“证据已到期”的可见记录。
- 事件采用持久化序号与 worker lease/heartbeat；队列重复投递不会重复创建尝试。任务租约过期先处理不明副作用，再决定新尝试。
- 默认一个 run 最多 50 条用例；至少能演示 2 个项目相互隔离。超过额度返回明确校验信息。
- 取消请求后 10 秒内停止安排新动作；在途请求或浏览器操作采用配置超时结束，不能保证远端已提交动作被撤销。
- 所有外部集成失败都显示真实状态，不通过 UI 假进度或随机成功率模拟。

## 11. 平台页面

1. 项目/环境：接入步骤、当前构建、角色和连接检查。
2. 资料/规则：来源预览、解析覆盖、版本比较、冲突和批准。
3. 用例：规则映射、步骤与断言、待处理条件、版本和批准。
4. 执行：真实任务队列、模式、预算、逐步骤结果、停止操作。
5. 缺陷：预期与实际、证据、关联需求、复测和重复出现历史。
6. 版本报告：结果分布、未覆盖项、不稳定项、成本和导出。

空态、加载、错误、部分成功、无权限、模型未配置必须有明确界面。mock 显著显示“演示结果”；不使用虚构用量、通过率或缺陷数量填充正式页面。

## 12. 开发验收与评测

### 12.1 自带独立演示业务

demo-app 包含申请人和主管、采购单创建、提交、审批、付款待办列表以及刷新后的持久化。业务规则在演示 PRD 中明确：金额单位分；>500000 分需主管审批；<=500000 分直接进入付款待办；禁止申请人审批。

健康构建与可切换缺陷构建至少覆盖：B1 阈值写错；B2 越权审批；B3 审批完成但付款待办不更新；B4 页面成功但刷新数据丢失。

缺陷开关和 ground truth 只给评测器，不暴露给测试智能体。Agent 不得读取 demo-app 源码、种子答案或通过专用 API直接获取缺陷名称。隐藏评测事实不妨碍执行账号与夹具接口的必要授权。

### 12.2 硬性工程验收

| 编号 | 场景 | 必须结果 |
|---|---|---|
| AT-01 | 导入文档并提取规则 | 来源可打开，解析缺口不被隐藏 |
| AT-02 | 需求缺失/冲突 | 产生澄清，不凭猜测批准 |
| AT-03 | real 无模型凭据 | 明确配置错误，无 mock 降级 |
| AT-04 | 健康构建双角色流程 | 真浏览器执行，所有必要断言有 actual 和证据 |
| AT-05 | 已知业务错误 | FAIL 对应具体断言与需求，保存真实截图/trace |
| AT-06 | 登录过期/环境不可达 | BLOCKED，不能 PASS |
| AT-07 | 削弱断言的修复补丁 | 被拒绝，原验收标准不变 |
| AT-08 | 重试成功 | 历史失败保留，unstable=true |
| AT-09 | 提交中 worker 退出 | 不盲目重放；验证副作用或明确阻塞 |
| AT-10 | 重复 webhook/重复队列消息 | 不重复创建业务执行 |
| AT-11 | 取消任务 | 停止新动作，保留已执行记录与未执行项 |
| AT-12 | 需求版本更新 | 新旧基线分开，历史报告不变 |
| AT-13 | 项目隔离与凭据保护 | 越项目访问拒绝；普通报告无密钥 |
| AT-14 | 零用例/全部跳过/视觉不确定 | 不输出全部通过 |
| AT-15 | 修复后新构建复测 | 产生新 run，关联旧缺陷，历史不覆盖 |
| AT-16 | 文档/网页含指令诱导 | 不修改权限与验收规则，不把内容当系统指令 |
| AT-17 | 部署中途变化/超预算 | 明确不完整/阻塞，证据保留 |
| AT-18 | OCR 不支持/证据文件不存在 | 明确未处理/缺证据，不能伪造成功 |

### 12.3 分开评估两个层面

**执行器验证**：使用已批准的固定用例与计划验证上述行为，结果应确定、可重复。这只能证明平台执行与判定逻辑。

**模型端到端评测**：从资料重新生成规则和用例，现场绑定目标站并执行，记录模型产生的遗漏与错误；不得用手工黄金计划冒充模型自主效果。

### 12.4 首轮效果目标（待实测，不作已达成承诺）

- 使用 20–30 条人工确认用例，健康构建与缺陷构建分开运行；在真实客户站补充至少一条完整流程。
- 缺陷有效率 = 人工确认真实缺陷的候选数 / 已完成人工判定的候选数，目标 >=90%；未判定数量另列。
- 已知缺陷检出率 = 被有效报告命中的已知缺陷数 / 评测范围内植入缺陷数，目标 >=80%；不得因用例未生成而缩小分母。
- 一致率：同一版本、相同夹具初态，每用例重复 5 次；五次 verdict 完全一致且无基础设施异常的用例数 / 参与重复测试用例数，目标 >=95%。另报始终判断错误的比例，稳定不代表正确。
- 人工介入：统计每轮次数、分钟数、原因；与同范围人工测试耗时比较，首次接入成本单列。
- 费用：显示模型真实 usage、估算单价版本、运行时长；缺失 usage 显示未知，不写零。

## 13. 里程碑

M0：契约、状态、目录、依赖核对和独立 demo-app；能健康运行，缺陷模式可由评测器切换。

M1：手动固定规则/用例 → TestPlan → 真浏览器 → 确定性断言 → 报告，先证明平台闭环。

M2：文档解析与来源 → 真实 GLM 规则/用例生成 → 审核 → 现场计划绑定。

M3：双角色、视觉适配、凭据与数据隔离、失败恢复、预算、证据和缺陷复测。

M4：六个页面、部署 webhook、权限、开发验收与真实模型端到端评测，接入一个客户试点。

P1 只有在 P0 的真实闭环和可靠性达标后实施。不得为了界面完整而留下假执行、假报告或隐式 mock。

## 14. 仍需试点确认的问题

1. 首个目标系统的登录方式、角色与重置数据条件。
2. 业务资料是否足以确定核心验收标准。
3. GLM 账号实际支持的文本/视觉模型、速率与预算。
4. 私有部署网络与可用基础设施。
5. 哪些流程客户愿意交由自动执行、哪类报告可以进入缺陷系统。

这些不阻塞工程骨架和演示闭环；缺真实目标或 API 凭据时，客户接入与 real 模式效果验收必须保持未完成。
