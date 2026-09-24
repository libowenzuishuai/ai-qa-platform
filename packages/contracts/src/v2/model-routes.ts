import { z } from "zod";

/**
 * W08（INT-05）：生成/视觉/决策三协议独立路由。
 * DecisionProvider 先有确定性规则基线；普通模型结构化决策为第二基线；
 * Jev 为可选适配器（低置信回退，不单独裁决 PASS）。
 */

export const ModelRole = z.enum(["generator", "vision", "decision"]);

export const ModelRouteConfig = z.object({
  role: ModelRole,
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  /** 版本固定（禁止 latest）。 */
  promptVersion: z.string().min(1).max(100),
  timeoutMs: z.number().int().min(1000).max(600_000),
  maxOutputTokens: z.number().int().min(64).max(200_000),
}).strict();
export type ModelRouteConfig = z.infer<typeof ModelRouteConfig>;

/** 决策请求（INT-06）：限定选项的结构化选择/评分。 */
export const DecisionOption = z.object({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(500),
  /** 附加上下文（受限数据）。 */
  context: z.string().max(2000).default(""),
}).strict();

export const DecisionRequestInput = z.object({
  question: z.string().min(1).max(2000),
  options: z.array(DecisionOption).min(2).max(20),
  /** 决策类型：单选 / 0-1 评分 / 分类。 */
  kind: z.enum(["choose", "score", "classify"]),
}).strict();
export type DecisionRequestInput = z.infer<typeof DecisionRequestInput>;

export const DecisionResult = z.object({
  kind: z.enum(["choose", "score", "classify"]),
  selectedOptionId: z.string().max(200).nullable().default(null),
  score: z.number().min(0).max(1).nullable().default(null),
  category: z.string().max(200).nullable().default(null),
  /** 原始置信度（未经本项目校准——不得当正确概率使用）。 */
  rawConfidence: z.number().min(0).max(1).nullable().default(null),
  /** 低置信度回退：确定性规则或人工。 */
  fallbackUsed: z.boolean().default(false),
  fallbackReason: z.string().max(500).nullable().default(null),
}).strict().superRefine((r, ctx) => {
  if (r.kind === "choose" && !r.selectedOptionId && !r.fallbackUsed)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selectedOptionId"], message: "choose 需要选中项（或声明回退）" });
  if (r.kind === "score" && r.score === null && !r.fallbackUsed)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["score"], message: "score 需要分值（或声明回退）" });
});
export type DecisionResult = z.infer<typeof DecisionResult>;
