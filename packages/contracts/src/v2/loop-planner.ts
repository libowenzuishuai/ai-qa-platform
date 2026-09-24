import { z } from "zod";
import { EntityId, IsoDateTime } from "../common.js";

/**
 * W04 python-real 规划器 wire（A2-04）：
 * 循环每轮把"目标+批准 Oracle+最新观察+上下文清单"交给 Python 提议下一步；
 * 服务端结构/权限/标准校验后才执行。输出是操作建议——绝不改 oracleHash。
 */

export const LoopActionKind = z.enum(["create_draft", "rename_draft", "get_draft", "observe_only", "done", "blocked"]);

export const LoopPlannerInput = z.object({
  goal: z.string().min(1).max(4000),
  /** 批准 Oracle 断言（标准；规划只读）。 */
  oracleAssertions: z.array(z.object({
    observationType: z.enum(["ui_text", "ui_visible", "api_field", "api_status", "db_value"]),
    observationRef: z.string().max(300),
    operator: z.string().max(40),
    expected: z.union([z.string().max(2000), z.boolean(), z.null()]),
  }).strict()).min(1).max(100),
  /** 当前轮观察（系统真实状态）。 */
  observation: z.object({
    renamePath: z.string().max(300).nullable(),
    draft: z.object({ id: z.string().max(200), title: z.string().max(500) }).nullable(),
  }).strict(),
  /** 上下文清单 id 与选中摘要（CTX-02：规划消费具体原文的凭据）。 */
  contextManifestId: EntityId.nullable().default(null),
  contextExcerpt: z.array(z.object({ spanId: z.string(), text: z.string().max(2000) })).max(50).default([]),
  promptVersion: z.literal("loop-planner-v1"),
}).strict();
export type LoopPlannerInput = z.infer<typeof LoopPlannerInput>;

export const LoopPlannerOutput = z.object({
  action: LoopActionKind,
  /** 操作参数（draftId/title 等；服务端再校验，不盲信）。 */
  params: z.object({
    title: z.string().max(500).optional(),
    renamePath: z.string().max(300).optional(),
  }).strict().default({}),
  /** 简短决策理由（可审计；不要求私有思维链）。 */
  rationale: z.string().min(1).max(2000),
}).strict().superRefine((o, ctx) => {
  if (o.action === "rename_draft" && !o.params.title)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["params"], message: "rename 需要 title" });
});
export type LoopPlannerOutput = z.infer<typeof LoopPlannerOutput>;
