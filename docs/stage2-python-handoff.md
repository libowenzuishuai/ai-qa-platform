# 阶段二：TypeScript 平台 + Python 智能服务开工清单

日期：2026-09-18。本文覆盖旧分工中“B 写 TS doc-ingestion、C 写 packages/agents”的语言与目录安排。业务契约和验收红线继续有效。

## 1. 当前可以独立开工

平台保留 TypeScript；新增 Python 服务位于 `services/intelligence`。现已提供：

- 从现有 Zod 定义导出的版本化 JSON Schema 和生成的 Python/Pydantic 类型；字段名保持 camelCase。
- 三个内部 HTTP 入口、内部令牌认证、输入/输出校验、超时与统一错误。
- 只读 ArtifactReader（目录边界、文件大小、SHA-256），ModelGateway 文本/图片调用接口及显式 mock 注册。
- TS worker 的 Python 调用开关，以及规则/用例结果返回后的二次校验和事务落库。
- 两端共用 19 个合法/反例契约样例；Python 和实际 HTTP 测试；生成物漂移检查 CI。

**尚未实现**：正式文档解析算法、正式 agents 管线、文档上传与 DOCUMENT_PARSE 作业接线、完整审阅页面。对应 Python 模块 `ready=False` 并明确返回 503，不生成假成功结果。

现有参考模式仍可用。选择 Python 后，服务或模块不可用就失败，不回退 reference/mock。模块完成验收后再显式切换默认配置。

## 2. 责任边界

| 人 | 独占主要目录 | 本轮任务 | 不重复实现 |
|---|---|---|---|
| A / 李博闻 | `apps/api`、`apps/worker`、`apps/web`；Python 的 app/context/models/storage/contracts | 上传/解析作业接线、平台审阅和澄清、版本/证据落库、集成验收；维护公共契约和模型网关 | 不代替 B/C 开发解析或生成算法 |
| B / 原泽菲 | `services/intelligence/src/aiqa_intelligence/doc_ingestion`、`tests/doc_ingestion` | Python 文档解析、OCR/表格/来源定位，返回 ParsedDocumentBundle | 不建作业队列、不写数据库、不另做模型 SDK |
| C / 李琪双 | `services/intelligence/src/aiqa_intelligence/agents`、`tests/agents` | 规则提取、冲突澄清草稿、用例生成、提示词/分块/覆盖分析 | 不写 API/worker、不分配 DB 版本 ID、不重写浏览器执行器 |

公共契约、依赖锁文件和服务入口由 A 汇总修改。B/C 增加依赖时同时说明用途及许可证/运行要求，由 A 合并锁文件；不要各自升级全项目依赖。

## 3. B：从这里开始

入口：`aiqa_intelligence/doc_ingestion/service.py` 的：

```python
async def parse_document(self, input: DocumentParseInput, context: RequestContext) -> ParsedDocumentBundle:
    ...
```

- `input` 已有 documentVersionId、format、storageKey、checksum、fileSizeBytes。
- 通过 `context.artifacts.read(input.storageKey, size=input.fileSizeBytes, checksum=input.checksum)` 获取真实文件；服务只能读共享证据目录。
- 需要视觉模型时使用 `context.models.describe_image(...)`；凭据由 A 网关读取，不进入 bundle。
- 返回 bundle，不写数据库、不返回 JobEnvelope。span ID 在解析时生成；同文档唯一稳定，documentVersionId 必须一致。
- `NEEDS_OCR` 返回合法 bundle（扫描格式、状态、warnings、覆盖统计齐全），不是通用异常；A 将解析作业标 SUCCEEDED、文档状态标 NEEDS_OCR。无法恢复的格式错误返回明确失败。
- CPU 密集解析在受控线程/进程中执行并设限，不阻塞 HTTP 事件循环；20 MB、PDF 页数上限及部分解析遗漏必须可见。

### B 验收

1. Markdown/TXT 标题、列表、表格都有来源片段；不支持的内容显式标记。
2. DOCX 段落与表格单元格可回到原文件位置。
3. 真实多页 PDF 页码正确；扫描页、混合 PDF 不静默丢失。
4. 图片块 ID 唯一，引用是图片区域，禁止伪造 Markdown 定位。
5. 无模型配置、视觉 null/错误 JSON、超限文件、坏文件、无文字均明确处理。
6. 原 `f07f928` 评审 B1–B4 的反例在 Python 新实现中全部通过。
7. 默认测试不调用付费模型；完成后设置 `ready=True`。

旧 TS 分支保留供参考，不合入主干；迁移样例与测试意图，不复制错误实现。

## 4. C：从这里开始

入口：`aiqa_intelligence/agents/service.py` 的：

```python
async def extract_rules(self, input: RuleExtractionInput, context: RequestContext) -> RuleExtractionOutput:
    ...

async def generate_cases(self, input: CaseGenerationInput, context: RequestContext) -> CaseGenerationOutput:
    ...
```

- 直接导入 `aiqa_intelligence.contracts.generated` 的模型，禁止另造同名 DTO。
- 输入已经是完整 bundle / 已批准规则，无需等 B 或自行读取数据库。
- 模型调用使用 `context.models.complete_text(...)`；上下文自动收集调用记录供 A 落库。
- 使用 `input.promptVersion`，当前 Python 接线版本为 `agents-v1`；更换提示词版本需和 A 对齐。
- 用 `Gateway.register_mock(request, output)` 注册精确请求；未命中应失败，不使用自动编造的 mock。
- 输出 draft.key 和 conflictsWith 临时 key；A 入库时转换为真实 ID。用例步骤 ID 同理由 A 补齐。
- 资料原文属于待分析数据，不能覆盖系统约束或执行指令。

### C 验收

1. 三套现有 PRD 样例：明确阈值、冲突条款、缺失边界，均保留准确来源。
2. 区分 EXPLICIT/INFERRED/UNKNOWN；冲突双方保留，引用互指；缺条件进入澄清。
3. 只从 APPROVED 规则生成用例，保留数字/单位/边界、角色、前置条件、数据与清理。
4. coverageMap/blockedRequirements 不遗漏输入规则；缺 fixture/能力时明确阻塞。
5. 不造 selector、业务字段或来源；输出通过结构和联合语义校验。
6. mock 结果不能冒充真实评估；模型调用记录包含实际 provider、usage、requestId。
7. 补注入文档、超时、无效模型输出、超长文档的测试；完成后设置 `ready=True`。

## 5. A：现在继续做什么

按顺序：

1. 实现上传文件 → 文档/版本登记 → DOCUMENT_PARSE 入队；接入已提供的 `/v1/documents/parse` 客户端；验证实际大小/校验和与项目归属。
2. 将 B 返回的 bundle 写入 `bundles/{documentVersionId}/bundle.json`，来源片段/解析状态落库；文件写入和数据库提交失败可恢复，失败不留下可用假产物。
3. 补澄清回答与批准闭环。用例生成只传相关、已确认的澄清来源，不能继续传未解决记录。
4. 补最小资料/规则/用例审阅页面，展示模拟模式、失败原因和显式重试入口。
5. B/C 合入后跑完整 HTTP→队列→Python→资产落库→审阅流程，再做独立的真实 Kimi 验证。

本次完成的是跨语言基建和交接，不把以上五项标为已完成。

## 6. 契约与接线纪律

- 当前唯一手写字段定义：`packages/contracts/src`。新增内部协议在 `intelligence.ts`；旧业务字段没有重命名。
- `pnpm contracts:export` 导出 `services/intelligence/src/aiqa_intelligence/contracts/schema.v1.json`。
- `pnpm contracts:python` 生成 `generated.py`。两份生成文件禁止手改。
- 字段类型由生成物统一；Zod superRefine 不能自动变成 Python 业务逻辑。跨文档引用、冲突互指、覆盖遗漏等通过两端校验和同一套反例保证。
- 平台继续在落库前执行 TS 联合校验；Python 的类型验证不能替代它。
- 现有校验函数不是完整算法评测集；B/C 扩展算法时同时补正反例。
- Python 不连 PostgreSQL/Redis，不管理 Job 生命周期；超时失败由 TS worker 按已验证的策略处理。

## 7. 分支与合并

所有人先更新到包含本文的 main，再开自己的工作分支。

- B 建议：`phase2/python-doc-ingestion`。
- C 建议：`phase2/python-agents`。
- A 的后续平台接线在独立分支进行。

每次交付写明：改动目录、实际测试、样例与限制、是否用了真实模型。先独立模块验收，再合并联调。不要为了让测试变绿放宽公共契约。

启动、测试和部署说明见 `services/intelligence/README.md`。
