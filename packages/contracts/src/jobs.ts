import { z } from "zod";
import { EntityId, IsoDateTime } from "./common.js";
import { RunMode } from "./enums.js";
import { ApiErrorBody } from "./api-error.js";
import { DocumentFormat, ParseStatus } from "./document.js";

/**
 * 阶段 2 异步作业 HTTP body 契约（阶段 2 第 0 步 ·
 * docs/stage2-step0-contracts.md §2.5）。起草：李博闻（A，牵头）。
 *
 * 路径全部来自 PRD §8，不新造：
 * - POST /api/projects/:id/documents        → 202
 * - POST /api/projects/:id/rule-extractions → 202
 * - POST /api/projects/:id/case-generations → 202
 * - GET  /api/jobs/:id                      → JobEnvelope
 *
 * 【已决·裁决点 5】JobEnvelope 升级为 discriminatedUnion("kind")，
 * result 形状随 kind 收紧。result 只放实体 id 引用与计数，
 * 不内联 bundle/draft 大对象。
 */

export const JobKind = z.enum(["DOCUMENT_PARSE", "RULE_EXTRACTION", "CASE_GENERATION"]);
export type JobKind = z.infer<typeof JobKind>;

export const JobStatus = z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED"]);
export type JobStatus = z.infer<typeof JobStatus>;

/**
 * POST /api/projects/:id/documents 的元数据 part
 * （文件本体走 multipart 的 file part）。
 * 【v2 已决】fileSizeBytes 进契约：PRD FR-02 单文件 ≤20MB 在请求层早拒。
 * 页数上限（文本 PDF ≤200 页）由解析器执行并以 PARSE_FAILED/coverageSummary 体现。
 */
export const DocumentParseJobRequest = z.object({
  title: z.string().trim().min(1).max(200),
  documentId: EntityId.optional(),
  mode: RunMode.default("mock"),
  declaredFormat: DocumentFormat,
  fileSizeBytes: z
    .number()
    .int()
    .min(1)
    .max(20 * 1024 * 1024, "单文件不超过 20MB（PRD FR-02）；放宽需改契约"),
});
export type DocumentParseJobRequest = z.infer<typeof DocumentParseJobRequest>;

/**
 * 【已决·裁决点 3】NEEDS_OCR 是合法解析终态：parse job SUCCEEDED +
 * result.parseStatus=NEEDS_OCR（作业完成了"判定需 OCR"这个动作）。
 * NEEDS_OCR 错误码留给下游 rule-extraction 拒绝时用。
 */
export const DocumentParseJobResult = z.object({
  documentId: EntityId,
  documentVersionId: EntityId,
  parseStatus: ParseStatus,
  spanCounts: z.object({
    good: z.number().int(),
    low: z.number().int(),
    unparsed: z.number().int(),
  }),
});
export type DocumentParseJobResult = z.infer<typeof DocumentParseJobResult>;

/** POST /api/projects/:id/rule-extractions → 202。 */
export const RuleExtractionJobRequest = z.object({
  documentVersionIds: z.array(EntityId).min(1),
  glossaryUpdates: z
    .array(z.object({ term: z.string(), definition: z.string() }))
    .default([]),
  /**
   * 默认 mock 是显式选择（结果标 simulated，从 real 指标排除）；
   * real 需已配置，否则 MODEL_NOT_CONFIGURED，禁止降级。
   */
  mode: RunMode.default("mock"),
});
export type RuleExtractionJobRequest = z.infer<typeof RuleExtractionJobRequest>;

export const RuleExtractionJobResult = z.object({
  documentVersionIds: z.array(EntityId),
  /** 创建的 DRAFT 规则版本（等待人工批准）。 */
  ruleVersionIds: z.array(EntityId),
  clarificationIds: z.array(EntityId),
  unparsedSpanIds: z.array(EntityId),
});
export type RuleExtractionJobResult = z.infer<typeof RuleExtractionJobResult>;

/** POST /api/projects/:id/case-generations → 202。 */
export const CaseGenerationJobRequest = z.object({
  /** 必须全是 APPROVED，否则 VALIDATION_ERROR。 */
  ruleVersionIds: z.array(EntityId).min(1),
  mode: RunMode.default("mock"),
});
export type CaseGenerationJobRequest = z.infer<typeof CaseGenerationJobRequest>;

export const CaseGenerationJobResult = z.object({
  caseVersionIds: z.array(EntityId),
  blockedRequirementCount: z.number().int(),
});
export type CaseGenerationJobResult = z.infer<typeof CaseGenerationJobResult>;

/** GET /api/jobs/:id —— 三作业共用信封（按 kind 判别 result 形状）。 */
const JobEnvelopeBase = z.object({
  jobId: EntityId,
  status: JobStatus,
  mode: RunMode.optional(),
  createdAt: IsoDateTime,
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
  /** FAILED 时必填。 */
  error: ApiErrorBody.nullable(),
});

export const JobEnvelope = z.discriminatedUnion("kind", [
  JobEnvelopeBase.extend({
    kind: z.literal("DOCUMENT_PARSE"),
    result: DocumentParseJobResult.nullable(),
  }),
  JobEnvelopeBase.extend({
    kind: z.literal("RULE_EXTRACTION"),
    result: RuleExtractionJobResult.nullable(),
  }),
  JobEnvelopeBase.extend({
    kind: z.literal("CASE_GENERATION"),
    result: CaseGenerationJobResult.nullable(),
  }),
]);
export type JobEnvelope = z.infer<typeof JobEnvelope>;
