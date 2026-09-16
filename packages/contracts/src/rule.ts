import { z } from "zod";
import { EntityId, IsoDateTime } from "./common.js";
import { AssetOrigin, RuleClassification, RuleReviewStatus } from "./enums.js";

/**
 * 规则版本（PRD FR-03 / §6）。
 * RuleVersion 是不可变追加记录：修订产生新版本并指向 supersedesId，
 * 被引用的已批准版本不可原地覆盖。
 */

/** 规则的业务字段：数字、单位、边界包含关系必须准确（PRD 5.1 运行时提示词）。 */
export const BusinessField = z.object({
  key: z.string().min(1),
  operator: z
    .enum(["gt", "gte", "lt", "lte", "eq", "neq", "in", "between", "contains"])
    .optional(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  unit: z.string().min(1).optional(),
});
export type BusinessField = z.infer<typeof BusinessField>;

/** 规则来源：必须指向真实存在的 DocumentVersion 与 SourceSpan。 */
export const RuleSource = z.object({
  documentVersionId: EntityId,
  sourceSpanIds: z.array(EntityId).min(1),
});
export type RuleSource = z.infer<typeof RuleSource>;

export const RuleVersion = z
  .object({
    id: EntityId,
    ruleId: EntityId,
    version: z.number().int().min(1),
    /** 一句话陈述，供人审阅。 */
    statement: z.string().min(1),
    classification: RuleClassification,
    /** 业务角色（申请人/主管等），不是平台角色。 */
    role: z.string().min(1).optional(),
    precondition: z.string().optional(),
    action: z.string().min(1),
    condition: z.string().optional(),
    expectation: z.string().min(1),
    forbiddenBehaviors: z.array(z.string()).default([]),
    priority: z.enum(["P0", "P1", "P2"]).default("P1"),
    businessFields: z.array(BusinessField).default([]),
    sources: z.array(RuleSource).default([]),
    /** 与哪些规则版本相互矛盾；冲突条目必须关联各方来源（PRD FR-03）。 */
    conflictsWith: z.array(EntityId).default([]),
    reviewStatus: RuleReviewStatus.default("DRAFT"),
    supersedesId: EntityId.nullable().default(null),
    origin: AssetOrigin,
    /** 模型生成时的 prompt 版本，人工补充时为 null。 */
    promptVersion: z.string().nullable().default(null),
    reviewedBy: z.string().nullable().default(null),
    reviewedAt: IsoDateTime.nullable().default(null),
    createdAt: IsoDateTime,
  })
  .superRefine((rule, ctx) => {
    // EXPLICIT 必须有真实来源；无来源最多是 INFERRED/UNKNOWN。
    if (rule.classification === "EXPLICIT" && rule.sources.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sources"],
        message: "EXPLICIT 规则必须引用至少一个真实来源；无来源请标为 INFERRED 或 UNKNOWN",
      });
    }
    if (rule.conflictsWith.includes(rule.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["conflictsWith"],
        message: "规则不能与自身冲突",
      });
    }
  });
export type RuleVersion = z.infer<typeof RuleVersion>;

/** 澄清项（PRD FR-03 / §6 Clarification）。 */
export const Clarification = z.object({
  id: EntityId,
  ruleVersionIds: z.array(EntityId).min(1),
  question: z.string().min(1),
  answer: z.string().nullable().default(null),
  /** 回答本身也是来源（有作者与时间），不能伪装成原文。 */
  answerSource: z.string().nullable().default(null),
  resolvedBy: z.string().nullable().default(null),
  resolvedAt: IsoDateTime.nullable().default(null),
  createdAt: IsoDateTime,
});
export type Clarification = z.infer<typeof Clarification>;
