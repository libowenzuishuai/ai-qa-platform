import { z } from "zod";
import { EntityId, IsoDateTime } from "../common.js";

/**
 * v2 结论侧（INT-01～04、CODE-02/04/06、W08/W10）：
 * Finding（缺陷候选完整链）、MemoryUsage（记忆消费闭环）、
 * TestPatch（候选测试补丁与有效性）、EvaluationTrial（冻结评测记录）。
 */

export const FindingStatus = z.enum(["candidate", "reproduced", "human_confirmed", "investigating", "fix_verified", "rejected"]);

export const RootCauseHypothesis = z.object({
  text: z.string().min(1).max(2000),
  /** 支持/反对证据（事实分栏；无证据的假设必须标注）。 */
  supportingEvidence: z.array(z.object({ kind: z.enum(["network", "console", "auth_log", "code_diff", "observation", "tool_output"]), ref: z.string().min(1).max(500) }).strict()).max(50).default([]),
  contradictingEvidence: z.array(z.object({ kind: z.enum(["network", "console", "auth_log", "code_diff", "observation", "tool_output"]), ref: z.string().min(1).max(500) }).strict()).max(50).default([]),
  status: z.enum(["open", "supported", "refuted", "unknown"]).default("open"),
}).strict();

export const MinimalReproduction = z.object({
  steps: z.array(z.object({ action: z.string().min(1).max(500), target: z.string().max(500).nullable().default(null) }).strict()).min(1).max(100),
  /** 最小化复现使用的资源（不得改变原标准）。 */
  resourceKeys: z.array(z.string().min(1).max(300)).max(100).default([]),
  verifiedAt: IsoDateTime.nullable().default(null),
}).strict();

export const Finding = z.object({
  id: EntityId,
  projectId: EntityId,
  oracleSpecId: EntityId.nullable().default(null),
  ruleVersionId: EntityId.nullable().default(null),
  status: FindingStatus.default("candidate"),
  /** expected/actual 冻结自 Oracle（不可改写以弱化）。 */
  expected: z.string().min(1).max(4000),
  actual: z.string().min(1).max(4000),
  /** 首败（保留原始记录；重试/修复不覆盖）。 */
  firstFailure: z.object({
    sessionId: EntityId.nullable().default(null),
    attemptId: EntityId.nullable().default(null),
    runId: EntityId.nullable().default(null),
    evidenceIds: z.array(EntityId).max(100).default([]),
    observedAt: IsoDateTime,
  }).strict(),
  /** 证据缺失时只能 candidate/investigating，不得直接 reproduced。 */
  hypotheses: z.array(RootCauseHypothesis).max(50).default([]),
  minimalReproduction: MinimalReproduction.nullable().default(null),
  severity: z.object({
    level: z.enum(["blocker", "critical", "major", "minor", "trivial"]),
    basis: z.string().min(1).max(2000),
  }).nullable().default(null),
  /** 去重键（同根因；不同业务错误不得合并）。 */
  dedupeKey: z.string().min(8).max(300),
  buildId: z.string().min(1).max(200),
  role: z.string().max(80).nullable().default(null),
  createdAt: IsoDateTime,
}).strict().superRefine((f, ctx) => {
  if ((f.status === "reproduced" || f.status === "human_confirmed" || f.status === "fix_verified") && f.firstFailure.evidenceIds.length === 0)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["firstFailure"], message: "无证据不得进入 reproduced/confirmed/fix_verified" });
  if (f.status === "fix_verified" && !f.minimalReproduction?.verifiedAt)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["minimalReproduction"], message: "fix_verified 需要已验证的最小复现" });
  if (f.severity && !f.severity.basis)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["severity"], message: "严重度必须有依据" });
});
export type Finding = z.infer<typeof Finding>;

// ---------- MemoryUsage（INT-04：检索→使用→结果的闭环记录） ----------

export const MemoryUsage = z.object({
  id: EntityId,
  projectId: EntityId,
  memoryRecordId: EntityId,
  sessionId: EntityId,
  retrieved: z.literal(true),
  decision: z.enum(["used", "rejected"]),
  /** used：影响了什么计划/动作；rejected：为什么（过期/冲突/跨项目/低质量）。 */
  reason: z.string().min(1).max(2000),
  /** 采用后该经验的效果（成功推进/误导→rejected 修正）。 */
  outcome: z.enum(["helped", "neutral", "harmful", "unknown"]).nullable().default(null),
  usedAt: IsoDateTime,
}).strict();
export type MemoryUsage = z.infer<typeof MemoryUsage>;

// ---------- TestPatch（CODE-02/04/06） ----------

export const TestPatchStatus = z.enum(["draft", "executed", "validated", "rejected"]);

export const TestPatch = z.object({
  id: EntityId,
  projectId: EntityId,
  /** 生成依据（批准规则/接口契约/批准性质——源码只是线索）。 */
  origin: z.object({
    kind: z.enum(["approved_rule", "api_contract", "approved_property"]),
    refs: z.array(z.string().min(1).max(500)).min(1).max(100),
  }).strict(),
  /** 仓库与提交（隔离工作区执行）。 */
  repositoryUrl: z.string().url(),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  files: z.array(z.object({ path: z.string().min(1).max(500), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(500),
  status: TestPatchStatus.default("draft"),
  /** 执行结果（零测试/全 skip/坏报告不算有效）。 */
  execution: z.object({
    ranAt: IsoDateTime.nullable().default(null),
    totalTests: z.number().int().min(0).nullable().default(null),
    failedTests: z.number().int().min(0).nullable().default(null),
    reportArtifactId: EntityId.nullable().default(null),
  }).strict(),
  /** 有效性（CODE-04）：变异检出/已知缺陷检出；null = 未验证。 */
  validity: z.object({
    knownDefectsDetected: z.number().int().min(0).nullable().default(null),
    mutantsKilled: z.number().int().min(0).nullable().default(null),
    mutantsTotal: z.number().int().min(0).nullable().default(null),
    /** 弱测试检出说明（恒真断言/无断言等）。 */
    weakPatternsFound: z.array(z.string().max(500)).max(50).default([]),
  }).strict(),
  createdAt: IsoDateTime,
}).strict().superRefine((p, ctx) => {
  if (p.status === "validated" && (p.validity.knownDefectsDetected === null || p.validity.knownDefectsDetected < 1))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["validity"], message: "validated 要求至少一个已知缺陷/变异检出（未验证不得标有效）" });
});
export type TestPatch = z.infer<typeof TestPatch>;

// ---------- EvaluationTrial（W10 冻结评测记录） ----------

export const EvaluationTrial = z.object({
  id: EntityId,
  campaignId: EntityId,
  projectId: EntityId,
  /** 冻结流程标识（与留出集登记一致；首败保留）。 */
  flowId: z.string().min(1).max(300),
  sessionId: EntityId.nullable().default(null),
  firstResult: z.enum(["pass_correct", "fail_correct", "false_positive", "false_negative", "blocked", "error", "unknown"]),
  finalResult: z.enum(["pass_correct", "fail_correct", "false_positive", "false_negative", "blocked", "error", "unknown"]),
  humanInterventionMinutes: z.number().min(0).nullable().default(null),
  costMicros: z.number().int().min(0).nullable().default(null),
  latencyMs: z.number().int().min(0),
  ranAt: IsoDateTime,
}).strict();
export type EvaluationTrial = z.infer<typeof EvaluationTrial>;
