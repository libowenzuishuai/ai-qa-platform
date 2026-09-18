# 阶段 2 · 第 0 步落地清单（修订版 v2）：4 份契约 + 错误码 + 作业 body + 3 份 fixture

> 2026-09-18 架构更新：B/C 改用 Python，目录与开工安排以 [跨语言开工清单](stage2-python-handoff.md) 为准。本文保留原契约决策；不再按旧 TS 包路径扩展新算法。
日期：2026-09-18 · 对齐仓库 `libowenzuishuai/ai-qa-platform` @ `2e9ff73`
耗时预算：0.5–1 天 · **牵头人：李博闻** · 三人评审，合并即冻结。

> v2 修订说明：本版在 v1 基础上修正了三处会导致冻结错误契约的问题
> （供应商枚举、RuleDraft 锚点、金额单位组合），并纠正了对仓库现状的
> 三处误判（contracts 既有测试数、错误码数量、实际已配置供应商）。
> 详见 §8 修订记录。

## 分工人员

| 代号 | 姓名 | 第 0 步角色 |
|---|---|---|
| **A** | **李博闻** | `model-adapter.ts` 起草；**牵头**：`jobs.ts` + `api-error.ts` 增补 + `index.ts` 导出 + 测试汇总 + 单 PR 合并 |
| **B** | **原泽菲** | `document.ts` 起草；3 份 `source.md` + `parsed-bundle.json`；解析红线测试断言 |
| **C** | **李琦双** | `agent-rule.ts` + `agent-case.ts` 起草；3 份 `expected-rule-drafts.json`；联合校验测试断言 |

牵头人选说明：v1 建议 C 牵头，但 C 本就是最重负载（两份契约 + 全部
golden），再背 jobs/错误码/汇总/PR 必成瓶颈。A 的契约最小最独立，牵头
不影响关键路径。

---

## 0. 仓库现状盘点（已重新核实）

| 已存在 | 位置 | 对第 0 步的约束 |
|---|---|---|
| `RuleVersion` / `Clarification` / `RuleSource` / `BusinessField` | `packages/contracts/src/rule.ts` | 规则草稿语义字段**逐字段对齐** `RuleVersion`；`RuleSource = {documentVersionId, sourceSpanIds}`，引用 **span id**，不是内联引文 |
| `TestCaseVersion` / `CaseAssertion` / `DataSpec`（含 `refineAssertionSemantics`） | `packages/contracts/src/test-case.ts` | 用例草稿**复用** `DataSpec` / `CaseAssertion`，不得另起断言语义 |
| `RuleClassification` / `AssetOrigin` / `RunMode` | `enums.ts` | 直接 import，不加新值 |
| `ApiErrorBody` + `ApiErrorCode`（**14 码**）+ `DEFAULT_HTTP_STATUS_BY_CODE` | `api-error.ts` | 错误码向现有 enum **增补**（v1 误写 13 码）；`CONFIG_MISSING`/`IDEMPOTENCY_CONFLICT`/`DEPENDENCY_UNAVAILABLE` 已存在可复用 |
| **contracts 既有测试 81 项**（`domain.test.ts` + `test-plan.test.ts`） | `packages/contracts/test/` | v1 误称"零测试文件"。第 0 步是**在 81 项基线上追加**，新增测试不得破坏既有断言（与阶段 1.1 同一纪律） |
| `Document` / `DocumentVersion` / `SourceSpan` / `ModelInvocation` 表 | `apps/api/prisma/schema.prisma` | `document.ts` 枚举逐字 lift 自 schema 注释（§2.1）；适配器响应字段对齐 `ModelInvocation` 列 |
| **根 `.env` 已配置 `AIQA_TEXT_PROVIDER="moonshot"` + `kimi-k2.6`**（阶段 0.1 复核实测过两次调用） | `.env`（不入库） | **`ModelProvider` 必须是 `moonshot`，不是 `glm`**。`.env.example` 的 zhipu 占位已过期，A 在阶段 2 首个 PR 一并修正 |
| 提示词 §5.1/§5.2 输入输出变量名 | `docs/ai-qa/03-GLM开发提示词.md` | 字段名对齐，见 §2.3 的映射说明 |
| 4 个异步端点路径 | PRD §8 | `POST /projects/:id/documents`、`/rule-extractions`、`/case-generations`、`GET /api/jobs/:id`——路径不动，只补 body（api 中尚未实现，属后续 PR） |
| `packages/model-adapters` / `doc-ingestion` | 各只有 README | 第 0 步不写这两个包的代码，只写它们消费的契约 |

Prisma 中**没有 Job 表**——第 0 步只在 contracts 定义 HTTP body 形状；
Job 存储表随各自路由 PR 走单独契约 PR。

代码风格：zod + `superRefine`/`ctx.addIssue`，中文注释标 PRD 出处，
import 带 `.js` 后缀（NodeNext）。

---

## 1. 交付物总览

```
packages/contracts/
  src/
    document.ts        ← 新增（原泽菲起草）
    model-adapter.ts   ← 新增（李博闻起草）
    agent-rule.ts      ← 新增（李琦双起草）
    agent-case.ts      ← 新增（李琦双起草）
    jobs.ts            ← 新增（李博闻起草）
    api-error.ts       ← 改：ApiErrorCode 增补 5 码 + 状态码映射（李博闻）
    index.ts           ← 改：导出以上全部（李博闻）
  test/
    contracts-stage2.test.ts  ← 新增：fixture round-trip + 联合校验 +
                                  不变量测试（断言草稿按 §4 归属，李博闻汇总）
  fixtures/
    01-explicit-prd/       source.md · parsed-bundle.json · expected-rule-drafts.json
    02-conflict-prd/       source.md · parsed-bundle.json · expected-rule-drafts.json
    03-missing-boundary/   source.md · parsed-bundle.json · expected-rule-drafts.json
```

一个 PR 合并。合并后 `packages/contracts` 三人只读，改动走单独 PR。

---

## 2. 四份契约逐份内容

### 2.1 `document.ts`（原泽菲起草，李琦双消费）

枚举逐字 lift 自 Prisma schema 注释，不改名、不增删值：

```ts
import { z } from "zod";
import { EntityId } from "./common.js";

/** DocumentVersion.format（schema.prisma）。PDF 解析后才区分 PDF_TEXT / PDF_SCANNED。 */
export const DocumentFormat = z.enum([
  "MARKDOWN", "TXT", "DOCX", "PDF_TEXT", "PDF_SCANNED", "PNG", "JPEG",
]);

/** DocumentVersion.parseStatus。注意终态是 FAILED，不是 PARSE_FAILED。 */
export const ParseStatus = z.enum(["PENDING", "PARSING", "PARSED", "FAILED", "NEEDS_OCR"]);

/** SourceSpan.extractionQuality：质量挂 span，不是 bundle 级。 */
export const SpanExtractionQuality = z.enum(["GOOD", "LOW", "UNPARSED"]);

/** SourceSpan.locator：六种，闭集 discriminated union。【v2 已决】locator 是
 * 位置的唯一描述——DB 的 imageRegion 列保留但契约层不再镜像它（与
 * locator.image-region 语义重叠，双写必漂移）。 */
export const SourceLocator = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("markdown-line"),    startLine: z.number().int(), endLine: z.number().int() }),
  z.object({ kind: z.literal("markdown-heading"), path: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal("docx-paragraph"),   paragraphIndex: z.number().int() }),
  z.object({ kind: z.literal("docx-cell"),        tableIndex: z.number().int(), row: z.number().int(), col: z.number().int() }),
  z.object({ kind: z.literal("pdf-page"),         page: z.number().int().min(1) }),
  z.object({ kind: z.literal("image-region"),     bbox: z.array(z.number()).length(4) }),
]);

/** 与 SourceSpan 表一一对应。id 由解析时生成（生成时机见裁决点 2）。 */
export const SourceSpanRecord = z.object({
  id: EntityId,
  documentVersionId: EntityId,
  locator: SourceLocator,
  /** 原文逐字引用。EXPLICIT 验收 = quotedText 能在所属文档 block 文本中找到。 */
  quotedText: z.string().nullable(),
  extractionQuality: SpanExtractionQuality.default("GOOD"),
});

/** 有序内容块：模型读正文靠它。 */
export const ParsedBlock = z.object({
  id: EntityId,
  kind: z.enum(["heading", "paragraph", "table", "listItem", "image"]),
  text: z.string(),
  page: z.number().int().optional(),      // PDF
  imageStorageKey: z.string().optional(), // kind=image 时
});

/** 解析产物：原泽菲的解析器输出 → 存 artifact-store → 李琦双的作业输入。 */
export const ParsedDocumentBundle = z.object({
  documentVersionId: EntityId,
  format: DocumentFormat,
  parseStatus: ParseStatus,
  parserVersion: z.string().min(1),
  blocks: z.array(ParsedBlock),
  spans: z.array(SourceSpanRecord),
  /** 与 DocumentVersion.coverageSummary 同构：数字对账，防静默丢内容。 */
  coverageSummary: z.object({
    totalBlocks: z.number().int(),
    goodSpans: z.number().int(),
    lowSpans: z.number().int(),
    unparsedSpans: z.number().int(),
  }),
  warnings: z.array(z.string()).default([]),
}).superRefine((b, ctx) => {
  const fail = (path: string, message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  // 验收红线写成 schema（PRD FR-02）：PARSED 必须有实际文本。
  if (b.parseStatus === "PARSED" && !b.blocks.some((x) => x.text.trim().length > 0)) {
    fail("blocks", "PARSED 必须包含非空文本；扫描 PDF 应为 NEEDS_OCR 或 FAILED，禁止空文本成功");
  }
  if (b.parseStatus === "NEEDS_OCR" && !["PDF_SCANNED", "PNG", "JPEG"].includes(b.format)) {
    fail("parseStatus", "NEEDS_OCR 只应出现在 PDF_SCANNED / PNG / JPEG");
  }
  // 数字对账（PRD FR-02：未成功解析的部分必须显式展示）。
  const count = (q: string) => b.spans.filter((s) => s.extractionQuality === q).length;
  if (b.coverageSummary.goodSpans !== count("GOOD") ||
      b.coverageSummary.lowSpans !== count("LOW") ||
      b.coverageSummary.unparsedSpans !== count("UNPARSED")) {
    fail("coverageSummary", "coverageSummary 计数与 spans 实际质量分布不一致");
  }
});
```

### 2.2 `model-adapter.ts`（李博闻起草，原泽菲注入 vision、李琦双消费）

**【v2 已决】`ModelProvider = ["moonshot", "mock"]`**——依据：根 `.env`
已配置 moonshot/kimi-k2.6 并经阶段 0.1 复核实测；评审明确"不能按 zhipu
单供应商假设开发"。若未来加供应商，走契约单独 PR。

```ts
import { z } from "zod";

/** 【v2 已决】moonshot 对齐已配置并实测的 Kimi；mock 为确定性替身。 */
export const ModelProvider = z.enum(["moonshot", "mock"]);

export const ModelCapabilities = z.object({
  vision: z.boolean(),
  maxInputTokens: z.number().int(),
  maxOutputTokens: z.number().int(),
  /** 能否原生接收 outputSchema（决定适配器是否走"提示词内嵌 schema"降级）。 */
  jsonSchemaInput: z.boolean(),
});

/** 完整 JSON Schema 随请求传入（提示词总则 §5）。超时是契约，不是实现细节。 */
export const TextModelRequest = z.object({
  purpose: z.enum(["RULE_EXTRACTION", "CASE_GENERATION", "VISION_DESCRIBE"]),
  system: z.string(),
  user: z.string(),
  outputSchema: z.unknown().optional(),
  temperature: z.number().min(0).max(1).optional(),
  maxOutputTokens: z.number().int().optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000),
});

/** 有限格式修复（PRD FR-11：最多两次）：闭集，修复必须可观察。 */
export const ModelRepairKind = z.enum(["code-fence", "trailing-comma", "truncated-json", "bom"]);

export const ModelUsage = z.object({
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  estimatedCost: z.number().optional(),
});

/** 字段对齐 ModelInvocation 表，usage/requestId 落库零转换。 */
export const ModelResponse = z.object({
  parsedJson: z.unknown(),          // 已过 outputSchema 校验
  rawText: z.string(),              // 原始输出，审计用
  repairsApplied: z.array(ModelRepairKind).default([]),
  provider: ModelProvider,
  model: z.string(),                // 实际命中的模型名
  requestId: z.string().nullable(), // 供应商侧 id → ModelInvocation.requestId
  usage: ModelUsage,
  latencyMs: z.number().int(),
  outcome: z.enum(["SUCCESS", "INVALID_OUTPUT", "TIMEOUT", "PROVIDER_ERROR"]),
});

export interface TextModelAdapter {
  readonly name: string;            // "mock" / "moonshot-…"，写 RunMode 判定
  capabilities(): ModelCapabilities;
  completeText(req: TextModelRequest): Promise<ModelResponse>;
}

/** 【v2 修正】vision 请求也带 purpose——否则 ModelInvocation 落库时
 *  purpose 无来源（v1 的 describeImage 签名缺它）。 */
export const VisionModelRequest = z.object({
  purpose: z.literal("VISION_DESCRIBE"),
  imageStorageKey: z.string().min(1),
  hint: z.string().min(1),
  outputSchema: z.unknown().optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000),
});

export interface VisionModelAdapter {
  /** 图片解析的最小面：图 → 结构化文字/描述，不暴露完整 chat。 */
  describeImage(req: VisionModelRequest): Promise<ModelResponse>;
}
```

**MockAdapter 确定性协议（写进契约注释并由测试锁定）**：mock 响应按
`purpose + 输入内容 hash` 查 fixtures 内置映射表，**查不到即抛
`MODEL_OUTPUT_INVALID`（details: { mockTable, inputHash }），禁止现编**。
这是"李琦双不等李博闻开工"的前提，也是 real 不降级 mock（约定 §1.4）
的另一半：mock 也不许偷偷变聪明。错误映射：缺密钥/endpoint →
`MODEL_NOT_CONFIGURED`（禁止静默换 mock）；修复后仍不合 schema →
`MODEL_OUTPUT_INVALID`，details 携带 `{ repairsApplied, rawExcerpt }`。

### 2.3 `agent-rule.ts`（李琦双起草，入库前校验消费）

字段名与提示词 §5.1 对齐。**映射说明**：§5.1 的输入变量 `sourceSpans`
在契约中不设独立字段，它是 `documentVersions[].spans` 的展开物
（bundle 自包含，避免两处 id 集合漂移）。李博闻组装提示词时按此映射展开。

```ts
import { z } from "zod";
import { EntityId } from "./common.js";
import { BusinessField, RuleClassification } from "./index.js";
import { ParsedDocumentBundle } from "./document.js";

/** §5.1 输入。sourceSpans = documentVersions[].spans（见上方映射说明）。 */
export const RuleExtractionInput = z.object({
  projectGlossary: z.array(z.object({ term: z.string(), definition: z.string() })).default([]),
  documentVersions: z.array(ParsedDocumentBundle).min(1),
  images: z.array(z.object({ storageKey: z.string(), spanId: EntityId })).default([]),
  /** 写 RuleVersion.promptVersion。 */
  promptVersion: z.string().min(1),
});

/** 【v2 已决】draft 带稳定 key——conflictsWith / ruleDraftKeys 的引用锚点。
 *  v1 无此字段，联合校验只能靠数组位置猜，脆弱。入库时丢弃 key、换真 id。 */
export const RuleDraft = z.object({
  key: z.string().regex(/^rule-draft-\d{2,}$/, "draft key 形如 rule-draft-01，同批唯一"),
  statement: z.string().min(1),
  classification: RuleClassification,
  role: z.string().optional(),
  precondition: z.string().optional(),
  action: z.string().min(1),
  condition: z.string().optional(),
  expectation: z.string().min(1),
  forbiddenBehaviors: z.array(z.string()).default([]),
  priority: z.enum(["P0", "P1", "P2"]).default("P1"),
  businessFields: z.array(BusinessField).default([]),
  /** 与 RuleSource 同构；spanId 存在性由联合校验保证（见下）。 */
  sources: z.array(z.object({ documentVersionId: EntityId, sourceSpanIds: z.array(EntityId).min(1) })),
  /** 引用同批 draft 的 key（不是未来的实体 id）。 */
  conflictsWith: z.array(z.string()).default([]),
});

export const ClarificationDraft = z.object({
  ruleDraftKeys: z.array(z.string()).min(1),
  question: z.string().min(1),
  /** kind 缺失即 PRD 遗漏；CONFLICT 时双方来源已在各 draft 里。 */
  kind: z.enum(["MISSING_INFO", "CONFLICT", "AMBIGUITY"]),
});

export const RuleExtractionOutput = z.object({
  ruleDrafts: z.array(RuleDraft),
  clarifications: z.array(ClarificationDraft),
  /** 无法解析的内容：引用真实 spanId + 原因，供 coverageSummary 对账。 */
  unparsedRanges: z.array(z.object({
    spanId: EntityId,
    reason: z.enum(["TABLE_DEGRADED", "LOW_QUALITY_IMAGE", "IRRELEVANT", "OTHER"]),
  })),
});
```

**联合校验 `validateRuleExtraction(input, output)`**（导出供 worker 调用，
测试覆盖每条反例）：

1. 每条 EXPLICIT draft `sources` 非空（镜像 `rule.ts` 的 refine）；
2. 所有 `sourceSpanIds` ∈ 输入 spans 的 id 集合（**比 RuleVersion 更强**——
   入库前就拦住编造引用）；
3. 每条引用的 span，其 `quotedText` 逐字出现在**同一 documentVersion**
   的 blocks 文本中（拦跨文档张冠李戴与纯编造；block 级更精细的对应
   随裁决点 2 一起定）；
4. `unparsedRanges.spanId` 同样 ∈ 输入 spans；
5. draft key 同批唯一；`conflictsWith` 与 `ruleDraftKeys` 的每个值都 ∈
   同批 draft key 集合（引用闭合）；`conflictsWith` 标注 CONFLICT 的
   双方必须互相指向（不许单方消解）。

### 2.4 `agent-case.ts`（李琦双起草）

字段名对齐 §5.2；直接复用 `test-case.ts` 的积木：

```ts
import { z } from "zod";
import { EntityId } from "./common.js";
import { Clarification, RuleVersion } from "./rule.js";
import { CaseAssertion, DataSpec } from "./test-case.js";

/** §5.2 输入：只喂 APPROVED 规则实体。 */
export const CaseGenerationInput = z.object({
  approvedRuleVersions: z.array(RuleVersion).min(1),
  clarificationSources: z.array(Clarification).default([]),
  roles: z.array(z.string().min(1)).min(1),
  /** 可用 fixtureId 清单（PRD FR-06：模型只能引用，不能造 fixture）。 */
  fixtureCapabilities: z.array(EntityId).default([]),
  /** 阶段 2 执行器能力边界，防生成做不到的用例。 */
  executorCapabilities: z.array(z.string()).default([]),
  promptVersion: z.string().min(1),
});

export const CaseDraft = z.object({
  /** 与 TestCaseVersion 同构；入库补 id/version/DRAFT/origin=model，
   *  approvalHash 在人工批准时由服务端计算（沿用阶段 1 先算后建纪律）。 */
  title: z.string().min(1),
  description: z.string().optional(),
  ruleVersionIds: z.array(EntityId).min(1),
  roles: z.array(z.string().min(1)).min(1),
  preconditions: z.array(z.string()).default([]),
  dataSpec: DataSpec,                        // ← 复用
  steps: z.array(z.object({
    role: z.string(), action: z.string().min(1), expectedResult: z.string().optional(),
  })).min(1),
  assertions: z.array(CaseAssertion).min(1), // ← 连同 refineAssertionSemantics 复用
  cleanup: z.object({ strategy: z.enum(["namespace", "fixture", "manual"]), note: z.string().optional() }),
  priority: z.enum(["P0", "P1", "P2"]).default("P1"),
  /** 覆盖维度（提示词 §5.2 七维度），供 coverageMap 汇总。 */
  dimensions: z.array(z.enum([
    "HAPPY_PATH", "INVALID_INPUT", "BOUNDARY", "PERMISSION",
    "STATE", "CROSS_MODULE", "PERSISTENCE",
  ])).min(1),
});

export const CaseGenerationOutput = z.object({
  caseDrafts: z.array(CaseDraft),
  coverageMap: z.array(z.object({
    ruleVersionId: EntityId,
    caseCount: z.number().int(),
    dimensionsCovered: z.array(z.string()),
  })),
  /** 缺登录/缺数据/超能力 → 列阻塞，不脑补（提示词 §5.2）。 */
  blockedRequirements: z.array(z.object({
    ruleVersionId: EntityId,
    reason: z.enum(["MISSING_LOGIN", "MISSING_FIXTURE", "INSUFFICIENT_INFO", "OUT_OF_EXECUTOR_CAPABILITY"]),
    detail: z.string().min(1),
  })),
});
```

**联合校验 `validateCaseGeneration(input, output)`**：

1. draft 的 `ruleVersionIds` 与断言 `ruleVersionId` ∈ 输入
   `approvedRuleVersions` 的 id；
2. `dataSpec.strategy="fixture"` 的 `fixtureId` ∈ `fixtureCapabilities`；
3. `coverageMap.ruleVersionId` ∪ `blockedRequirements.ruleVersionId` 覆盖
   **所有**输入规则——覆盖率不许把资料遗漏藏进去（PRD FR-04）；
4. 步骤角色 ∈ `roles`（镜像 TestCaseVersion 的既有 refine，提前到草稿层）。

### 2.5 `jobs.ts`（李博闻起草）——四个端点的 body

路径全部来自 PRD §8，不新造：

```ts
import { z } from "zod";
import { EntityId, IsoDateTime } from "./common.js";
import { RunMode } from "./enums.js";
import { ApiErrorBody } from "./api-error.js";
import { DocumentFormat, ParseStatus } from "./document.js";

export const JobKind = z.enum(["DOCUMENT_PARSE", "RULE_EXTRACTION", "CASE_GENERATION"]);
export const JobStatus = z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED"]);

/** POST /api/projects/:id/documents → 202（文件本体走 multipart 的 file part，
 *  此处定义元数据 part 与响应）。【v2 增补】fileSizeBytes 进契约：
 *  PRD FR-02 单文件 ≤20MB 在请求层早拒，不等人传完。页数上限由解析器执行。 */
export const DocumentParseJobRequest = z.object({
  title: z.string().min(1),
  declaredFormat: DocumentFormat,
  fileSizeBytes: z.number().int().min(1).max(20 * 1024 * 1024), // PRD FR-02；放宽需改契约
});
export const DocumentParseJobResult = z.object({
  documentId: EntityId,
  documentVersionId: EntityId,
  /** 【已决·裁决点 3】NEEDS_OCR 是合法解析终态：作业 SUCCEEDED +
   *  parseStatus=NEEDS_OCR。NEEDS_OCR 错误码留给下游 rule-extraction 拒绝时用。 */
  parseStatus: ParseStatus,
  spanCounts: z.object({ good: z.number().int(), low: z.number().int(), unparsed: z.number().int() }),
});

/** POST /api/projects/:id/rule-extractions → 202 */
export const RuleExtractionJobRequest = z.object({
  documentVersionIds: z.array(EntityId).min(1),
  glossaryUpdates: z.array(z.object({ term: z.string(), definition: z.string() })).default([]),
  /** 默认 mock 是显式选择；real 需已配置，否则 MODEL_NOT_CONFIGURED，禁止降级。 */
  mode: RunMode.default("mock"),
});

/** POST /api/projects/:id/case-generations → 202 */
export const CaseGenerationJobRequest = z.object({
  ruleVersionIds: z.array(EntityId).min(1), // 必须全是 APPROVED，否则 VALIDATION_ERROR
  mode: RunMode.default("mock"),
});

/** GET /api/jobs/:id —— 三作业共用信封。result 按 kind 对应三个 Result；
 *  是否升级为 discriminatedUnion("kind") 见裁决点 5。 */
export const JobEnvelope = z.object({
  jobId: EntityId,
  kind: JobKind,
  status: JobStatus,
  createdAt: IsoDateTime,
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
  result: z.unknown().nullable(),
  /** FAILED 时必填。 */
  error: ApiErrorBody.nullable(),
});
```

result 只放实体 id 引用与计数，不内联 bundle/draft 大对象。

### 2.6 `api-error.ts` 增补（李博闻）

向现有 14 码 enum 追加 5 码并更新 `DEFAULT_HTTP_STATUS_BY_CODE`：

| 新码 | 默认 HTTP | 语义 | details 形状 |
|---|---|---|---|
| `MODEL_NOT_CONFIGURED` | 503 | real 模式缺密钥/endpoint；**禁止降级 mock** | `{ provider, missing: string[] }` |
| `MODEL_OUTPUT_INVALID` | 500 | 有限修复（≤2 次）后仍不合 schema；mock 查表 miss 复用此码 | `{ repairsApplied: string[], rawExcerpt: string }` 或 `{ mockTable, inputHash }` |
| `MODEL_TIMEOUT` | 504 | 超出请求的 `timeoutMs` | `{ timeoutMs }` |
| `PARSE_FAILED` | 422 | 解析器异常退出（区别于 NEEDS_OCR） | `{ parserVersion }` |
| `NEEDS_OCR` | 422 | 对 NEEDS_OCR 版本发起 rule-extraction 时拒绝 | `{ documentVersionId }` |

复用已有码：供应商 5xx 透传 → `DEPENDENCY_UNAVAILABLE`；作业重复提交 →
`IDEMPOTENCY_CONFLICT`。

---

## 3. 三份 fixture 细则（原泽菲写 source + bundle，李琦双写 golden）

目录 `packages/contracts/fixtures/`。bundle 是手工构造的
`ParsedDocumentBundle`（span 带假 id）；golden 是手工构造的
`RuleExtractionOutput`（含 draft key）。

**【v2 已决·金额口径】`unit: "fen"` + `value` 为分的数字**（与
`test-case.ts` L47 及执行器数值比较口径一致）。原文用"元"时，golden 必须换算。

| # | source.md 内容 | parsed-bundle.json 要点 | expected-rule-drafts.json 断言点 |
|---|---|---|---|
| 01 明确 | 采购审批 PRD：单段明确写「订单金额超过 5000.00 元需部门主管审批」 | MARKDOWN、PARSED、≥6 block、span 全 GOOD、coverageSummary 对账成立 | ≥1 条 EXPLICIT，key 如 `rule-draft-01`；`businessFields` 含 `{key:"amountCents", operator:"gt", value:500000, unit:"fen"}`（5000.00 元换算）；`sourceSpanIds` 指向真实 span |
| 02 冲突 | §2.1「审批后仍可修改金额」vs §4.2「审批后金额锁定」 | 两个 heading-path span 分别覆盖两处原文 | **两条 draft 各带各的来源**，`conflictsWith` 经 key 互相指向，+1 条 `kind:"CONFLICT"` clarification 关联两个 key；golden 中不得出现第三条「调和版」规则 |
| 03 缺边界 | 只写「高额采购订单需主管审批」，全文无具体金额 | 正常 PARSED | 边界规则 `classification:"UNKNOWN"`；**负向断言：任何 draft 的 businessFields.value 不得为数字字面量**（无依据不编数）；+1 条 `kind:"MISSING_INFO"` clarification 询问金额边界 |

fixture 的三个用途：① 李琦双的 pipeline 输入（不等原泽菲的解析器）；
② contracts 测试数据；③ 集成日原泽菲真解析 `source.md` 的产物与手写
bundle 做结构等价对照。

---

## 4. 测试与断言归属（v1 未落人，v2 落到人）

测试文件 `test/contracts-stage2.test.ts`，各人先写断言草稿，李博闻汇总：

| 测试 | 断言 | 断言草稿归属 |
|---|---|---|
| fixture round-trip | 3 份 bundle 过 `ParsedDocumentBundle`；3 份 golden 过 `RuleExtractionOutput` | 原泽菲（bundle）/ 李琦双（golden） |
| EXPLICIT 出处 | fixture 01 过 `validateRuleExtraction`；删某 draft 的 sources → 报错 | 李琦双 |
| spanId 存在性 | 改某 `sourceSpanIds` 为不存在 id → 报错（拦编造引用） | 李琦双 |
| quotedText 逐字 | 改 quotedText 为原文没有的句子 → 报错 | 李琦双 |
| 冲突保持 | fixture 02 golden 过校验；删任一方 conflictsWith → 报错（不许单方消解） | 李琦双 |
| key 引用闭合 | conflictsWith / ruleDraftKeys 指向不存在的 key → 报错 | 李琦双 |
| 不补造 | fixture 03 负向：golden 所有 businessFields.value 均非数字字面量 | 李琦双 |
| 空文本红线 | PARSED + 全空 blocks → schema 拒绝 | 原泽菲 |
| coverageSummary 对账 | 手改 goodSpans 计数 → 拒绝 | 原泽菲 |
| NEEDS_OCR 格式约束 | NEEDS_OCR + MARKDOWN → 拒绝 | 原泽菲 |
| case 联合校验 | 用 fixture 01 golden 伪造 APPROVED 输入，喂含未声明 ruleVersionId 断言的 draft → `validateCaseGeneration` 报错；fixture 策略 fixtureId 越界 → 报错；coverageMap 漏一条规则 → 报错 | 李琦双 |
| provider 枚举 | `ModelProvider` 含 moonshot；`ModelProvider.parse("glm")` 抛错（防回退） | 李博闻 |
| 错误码映射 | 新 5 码都在 `DEFAULT_HTTP_STATUS_BY_CODE` | 李博闻 |
| 既有基线 | 既有 81 项测试全绿（追加不得破坏） | 李博闻（CI 守门） |

---

## 5. 当天流程与分工

| 时段 | 动作 |
|---|---|
| 会前（半天） | 三人按 §2 各自起草（纯类型文件，可编译即可）；原泽菲起 3 份 source + bundle 草稿，李琦双起 3 份 golden 草稿 |
| 评审会（90 分钟） | 只裁 §7 的 5 个开放点，逐字段过 4 份草案 |
| 会后（半天） | 按裁决修订 → 李博闻合成单 PR（只动 `packages/contracts`）+ 补 §4 测试 → `pnpm --filter @ai-qa/contracts test` 与 `pnpm typecheck` 绿 → 三人 approve → **合并即冻结** |

| 人 | 第 0 步产出 |
|---|---|
| 李博闻（A，牵头） | `model-adapter.ts` + `jobs.ts` + `api-error.ts` 增补 + `index.ts` + 测试汇总 + PR |
| 原泽菲（B） | `document.ts` + 3 份 `source.md`/`parsed-bundle.json` + 解析红线断言 |
| 李琦双（C） | `agent-rule.ts` + `agent-case.ts` + 3 份 `expected-rule-drafts.json` + 联合校验断言 |

---

## 6. 已决定事项（不再裁决，直接进草案）

1. **`ModelProvider = ["moonshot", "mock"]`**（v1 的 glm 与根 `.env` 实际配置冲突）。
2. **`RuleDraft.key`**（`rule-draft-\d{2,}`，同批唯一）；`conflictsWith` /
   `ruleDraftKeys` 引用 key，联合校验保证闭合与冲突互指。
3. **金额口径 `unit:"fen"` + value 为分**（fixture 01：5000.00 元 → 500000）。
4. **NEEDS_OCR 作业语义**：parse job `SUCCEEDED` + `result.parseStatus=
   NEEDS_OCR`；`NEEDS_OCR` 错误码用于下游 rule-extraction 拒绝。
5. **MockAdapter 查表 miss**：抛 `MODEL_OUTPUT_INVALID`（details 带
   mockTable/inputHash），不现编、不返回空。
6. **`SourceSpanRecord` 不镜像 DB 的 imageRegion 列**：locator 是位置
   唯一描述，双写必漂移。
7. **vision 请求带 purpose**：`VisionModelRequest.purpose` 固定
   VISION_DESCRIBE，落 ModelInvocation 有来源。
8. **`DocumentParseJobRequest.fileSizeBytes`** 进契约（≤20MB 早拒，
   PRD FR-02）。
9. **§5.1 变量映射**：提示词输入 `sourceSpans` = `documentVersions[].spans`
   展开物，契约不设独立字段。

## 7. 开放裁决点（评审会裁，5 个）

1. **ParsedBlock 持久化位置**：bundle 整体只存 artifact-store
   （key=documentVersionId）还是 blocks 入库？（不影契约形状，影两边实现）
2. **span id 生成时机**：解析时生成并在入库前写死进 bundle，还是入库后
   回填？（决定 fixture 里 span id 写法与存在性校验时机；若裁"入库前
   写死"，quotedText 校验可升级为 block 级对应）
3. **bundle 读路径**：李琦双的 rule-extraction 作业从 artifact-store 按
   documentVersionId 取 bundle 并校验 parseStatus=PARSED 的时机与责任方
   （v1 未列；直接决定 C 能否真不等 B）。
4. **job 幂等**：同参数重复 POST 返回同一 jobId 还是新建？建议：
   documents 按 checksum 复用解析产物但**必须新版本**（PRD FR-02）；
   rule-extraction / case-generation 按输入指纹幂等，重复返回原 jobId，
   指纹不同才 `IDEMPOTENCY_CONFLICT`。
5. **`JobEnvelope` 是否升级为 `discriminatedUnion("kind", …)`**：让
   result 形状随 kind 收紧（更符合本仓库闭集风格）；建议升级，工作量小。

## 8. v1 → v2 修订记录

| # | v1 问题 | v2 处置 |
|---|---|---|
| 1 | `ModelProvider=["glm","mock"]` 与根 `.env` 已配置并实测的 moonshot/kimi 冲突；照抄即冻结错误契约 | §6-1：枚举改 `["moonshot","mock"]`，加防回退测试 |
| 2 | `RuleDraft` 无 key，但 conflictsWith / ruleDraftKeys 引用"临时 key"，联合校验无锚点 | §6-2：key 进 schema + 闭合校验 + 互指校验 |
| 3 | fixture 01 `value:"5000.00", unit:"fen"` 是错位组合（=500000 分） | §6-3：unit=fen + value=分数字，golden 按此换算 |
| 4 | 误称 contracts"零测试文件" | §0：实为 81 项基线，追加不得破坏既有断言 |
| 5 | 误称 ApiErrorCode 13 码 | §0：实为 14 码 |
| 6 | 牵头建议 C，但 C 负载最重（两契约+全部 golden） | 牵头改 A（李博闻），jobs/错误码随牵头走 |
| 7 | `describeImage` 无 purpose，ModelInvocation 落库无来源 | §6-7：VisionModelRequest 带 purpose |
| 8 | §5.1 要求字段名与提示词"逐字一致"但 spans 内嵌进 bundle，自相矛盾 | §6-9：写明映射，不再含糊 |
| 9 | 20MB/200 页限制未进契约 | §6-8：fileSizeBytes 进请求体 |
| 10 | imageRegion 字段与 locator.image-region 重叠 | §6-6：契约层不镜像，DB 列留空 |
| 11 | 9 组测试断言未落人 | §4：逐条归属 |
| 12 | 缺 bundle 读路径裁决 | §7-3 新增 |

## 9. 完成定义（DoD）

- [ ] `pnpm --filter @ai-qa/contracts test` 绿（既有 81 项 + §4 全部新增）
- [ ] `pnpm typecheck` 全仓绿
- [ ] 三人从合并后的 main 各自 `import` 新契约即可开工，互不等人：
      李博闻写 `packages/model-adapters`（moonshot + mock 适配器）、
      原泽菲写 `packages/doc-ingestion`、李琦双新建 `packages/agents`
      （规则提取/用例生成 pipeline，fixture 先行）
- [ ] §7 的 5 个裁决点在 PR 描述里留痕
- [ ] 合并后 `packages/contracts` 转只读；后续任何契约改动走单独 PR
