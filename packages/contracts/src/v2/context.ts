import { z } from "zod";
import { EntityId, IsoDateTime } from "../common.js";

/**
 * v2 上下文与覆盖（CTX-02/03/04/06、DES-01）：
 * ContextManifest 是"规划实际消费了什么"的账本，不是 hasDocuments 布尔。
 * CoverageLedger 是六维覆盖对账：每条规则×维度必须 covered/blocked/not_applicable
 * /not_evaluated 四选一，重复用例不提高分母。
 */

export const ContextSelectionEntry = z.object({
  kind: z.enum(["span", "rule", "page_clue", "api_clue", "memory", "conflict", "unparsed_range"]),
  /** 具体引用（spanId/ruleVersionId/url 等；归属校验在服务端）。 */
  ref: z.string().min(1).max(500),
  documentVersionId: EntityId.nullable().default(null),
  /** 检索分数（基线为关键词/结构关联得分；策略版本化）。 */
  score: z.number().min(0).max(1).nullable().default(null),
  /** selected / rejected + 原因（审计）。 */
  decision: z.enum(["selected", "rejected"]),
  reason: z.string().min(1).max(2000),
}).strict();
export type ContextSelectionEntry = z.infer<typeof ContextSelectionEntry>;

export const ContextManifest = z.object({
  id: EntityId,
  sessionId: EntityId.nullable().default(null),
  projectId: EntityId,
  /** 检索策略标识与版本（可替换实现；增益以评测为准）。 */
  retrievalStrategy: z.string().min(1).max(200),
  selections: z.array(ContextSelectionEntry).min(1).max(5000),
  /** 上下文预算：截断必须保留缺口记录。 */
  budget: z.object({
    tokensMax: z.number().int().min(100),
    tokensUsed: z.number().int().min(0),
    truncated: z.boolean(),
    /** 截断/排除后未进入规划的片段（原文否定、条件、单位不得被静默丢弃）。 */
    omittedRefs: z.array(z.string().max(500)).max(5000).default([]),
  }).strict(),
  /** 输入哈希：规划调用必须记录，同哈希同上下文。 */
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  generatedAt: IsoDateTime,
}).strict().superRefine((m, ctx) => {
  if (m.budget.truncated && m.budget.omittedRefs.length === 0)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["budget"], message: "截断必须保留被省略片段清单" });
  if (m.budget.tokensUsed > m.budget.tokensMax)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["budget"], message: "tokensUsed 超过预算上限" });
  if (!m.selections.some((s) => s.decision === "selected"))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selections"], message: "上下文没有任何选中项（检索无命中≠没有要求，应记录 blocked）" });
});
export type ContextManifest = z.infer<typeof ContextManifest>;

// ---------- CoverageLedger（DES-01 六维覆盖） ----------

export const CoverageDimension = z.enum(["normal", "boundary", "permission", "multi_role", "state", "persistence"]);

export const RuleCoverageEntry = z.object({
  ruleVersionId: EntityId,
  dimension: CoverageDimension,
  status: z.enum(["covered", "blocked", "not_applicable", "not_evaluated"]),
  /** 依据：covered→attempt/断言引用；blocked/not_applicable→原因；不适用须有权人员确认。 */
  evidenceAttemptId: EntityId.nullable().default(null),
  reason: z.string().min(1).max(2000),
  confirmedBy: z.string().nullable().default(null),
}).strict().superRefine((e, ctx) => {
  if (e.status === "covered" && !e.evidenceAttemptId)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "covered 必须引用证据 attempt" });
  if (e.status === "not_applicable" && !e.confirmedBy)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "not_applicable 必须由有权人员确认" });
  if (e.status === "covered" && e.confirmedBy === "")
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "covered 不需要确认人字段留空字符串" });
});
export type RuleCoverageEntry = z.infer<typeof RuleCoverageEntry>;

export const CoverageLedger = z.object({
  id: EntityId,
  projectId: EntityId,
  oracleSpecId: EntityId,
  entries: z.array(RuleCoverageEntry).min(1).max(6000),
  updatedAt: IsoDateTime,
}).strict();
export type CoverageLedger = z.infer<typeof CoverageLedger>;

/**
 * 覆盖率：按 规则×维度 声明的矩阵计算分母；重复用例不提高分母
 * （同一 (ruleVersionId, dimension) 只计一次）。
 */
export function coverageDenominator(ledger: CoverageLedger): {
  total: number;
  covered: number;
  blocked: number;
  notApplicable: number;
  notEvaluated: number;
  duplicatesRejected: number;
} {
  const seen = new Set<string>();
  let duplicates = 0;
  const counts = { covered: 0, blocked: 0, notApplicable: 0, notEvaluated: 0 };
  for (const entry of ledger.entries) {
    const key = `${entry.ruleVersionId}:${entry.dimension}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    if (entry.status === "covered") counts.covered += 1;
    else if (entry.status === "blocked") counts.blocked += 1;
    else if (entry.status === "not_applicable") counts.notApplicable += 1;
    else counts.notEvaluated += 1;
  }
  const total = counts.covered + counts.blocked + counts.notApplicable + counts.notEvaluated;
  return { total, ...counts, duplicatesRejected: duplicates };
}
