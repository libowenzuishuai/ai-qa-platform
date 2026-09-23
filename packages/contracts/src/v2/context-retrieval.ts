import { z } from "zod";
import { EntityId } from "../common.js";
import { ParsedDocumentBundle } from "../document.js";

/**
 * v2 上下文检索 wire（CTX-04，W03 Alpha：keyword-structural-v1 基线）。
 * 确定性打分：无外部依赖；向量检索以评测增益为依据另立（A2-03）。
 */

export const ContextRetrievalInput = z.object({
  /** 检索查询（目标/规则语句关键词来源）。 */
  query: z.string().min(1).max(4000),
  documentVersions: z.array(ParsedDocumentBundle).min(1).max(50),
  /** 批准规则来源引用（权威路径：其 span 直接入选）。 */
  ruleRefs: z.array(z.object({
    ruleVersionId: EntityId,
    sourceSpanIds: z.array(EntityId).min(1),
  }).strict()).max(500).default([]),
  maxSelected: z.number().int().min(1).max(500).default(50),
}).strict();
export type ContextRetrievalInput = z.infer<typeof ContextRetrievalInput>;

export const ContextRetrievalSelection = z.object({
  kind: z.enum(["span", "unparsed_range"]),
  ref: z.string().min(1).max(500),
  documentVersionId: EntityId,
  score: z.number().min(0).max(1).nullable(),
  decision: z.enum(["selected", "rejected"]),
  reason: z.string().min(1).max(2000),
}).strict();

export const ContextRetrievalOutput = z.object({
  strategy: z.string().min(1).max(200),
  selections: z.array(ContextRetrievalSelection).min(1).max(10000),
}).strict();
export type ContextRetrievalOutput = z.infer<typeof ContextRetrievalOutput>;
