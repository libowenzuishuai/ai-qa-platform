import { z } from "zod";

/**
 * 模型适配器契约（阶段 2 第 0 步 · docs/stage2-step0-contracts.md §2.2）。
 * 起草：李博闻（A）；vision 由原泽菲（B）注入；消费：李琦双（C）。
 *
 * 响应字段对齐 ModelInvocation 表，usage/requestId 落库零转换。
 */

/**
 * 【v2 已决】moonshot 对齐根 .env 已配置并实测的 Kimi（阶段 0.1 复核）；
 * mock 为确定性替身。禁止回退 glm/zhipu 假设（有测试锁定）。
 * 未来加供应商走契约单独 PR。
 */
export const ModelProvider = z.enum(["moonshot", "mock"]);
export type ModelProvider = z.infer<typeof ModelProvider>;

export const ModelCapabilities = z.object({
  vision: z.boolean(),
  maxInputTokens: z.number().int(),
  maxOutputTokens: z.number().int(),
  /** 能否原生接收 outputSchema（决定适配器是否走"提示词内嵌 schema"降级）。 */
  jsonSchemaInput: z.boolean(),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilities>;

export const ModelPurpose = z.enum(["RULE_EXTRACTION", "CASE_GENERATION", "VISION_DESCRIBE", "PLAN_PROPOSAL", "SOURCE_CLASSIFICATION", "GOAL_PROPOSAL"]);
export type ModelPurpose = z.infer<typeof ModelPurpose>;

/** 完整 JSON Schema 随请求传入（提示词总则 §5）。超时是契约，不是实现细节。 */
export const TextModelRequest = z.object({
  purpose: ModelPurpose,
  system: z.string(),
  user: z.string(),
  outputSchema: z.unknown().optional(),
  temperature: z.number().min(0).max(1).optional(),
  maxOutputTokens: z.number().int().optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000),
});
export type TextModelRequest = z.infer<typeof TextModelRequest>;

/** 有限格式修复（PRD FR-11：最多两次）：闭集，修复必须可观察。 */
export const ModelRepairKind = z.enum([
  "code-fence",
  "trailing-comma",
  "truncated-json",
  "bom",
]);
export type ModelRepairKind = z.infer<typeof ModelRepairKind>;

export const ModelUsage = z.object({
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  estimatedCost: z.number().optional(),
});
export type ModelUsage = z.infer<typeof ModelUsage>;

export const ModelResponse = z.object({
  /** 已过 outputSchema 校验的产物。 */
  parsedJson: z.unknown(),
  /** 原始输出，审计用。 */
  rawText: z.string(),
  repairsApplied: z.array(ModelRepairKind).default([]),
  provider: ModelProvider,
  /** 实际命中的模型名。 */
  model: z.string(),
  /** 供应商侧 id → ModelInvocation.requestId。 */
  requestId: z.string().nullable(),
  usage: ModelUsage,
  latencyMs: z.number().int(),
  outcome: z.enum(["SUCCESS", "INVALID_OUTPUT", "TIMEOUT", "PROVIDER_ERROR"]),
});
export type ModelResponse = z.infer<typeof ModelResponse>;

export interface TextModelAdapter {
  /** "mock" / "moonshot-…"，写 RunMode 判定。 */
  readonly name: string;
  capabilities(): ModelCapabilities;
  completeText(req: TextModelRequest): Promise<ModelResponse>;
}

/**
 * 【v2 已决】vision 请求也带 purpose——否则 ModelInvocation 落库时
 * purpose 无来源。purpose 固定为 VISION_DESCRIBE。
 */
export const VisionModelRequest = z.object({
  purpose: z.literal("VISION_DESCRIBE"),
  imageStorageKey: z.string().min(1),
  hint: z.string().min(1),
  outputSchema: z.unknown().optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000),
});
export type VisionModelRequest = z.infer<typeof VisionModelRequest>;

export interface VisionModelAdapter {
  /** 图片解析的最小面：图 → 结构化文字/描述，不暴露完整 chat。 */
  describeImage(req: VisionModelRequest): Promise<ModelResponse>;
}

/**
 * MockAdapter 确定性协议（【已决】，测试锁定）：
 * - mock 响应按 `purpose + 输入内容 hash` 查 fixtures 内置映射表；
 * - 查不到即抛 MODEL_OUTPUT_INVALID（details: { mockTable, inputHash }），
 *   禁止现编、禁止返回空——这是"real 不降级 mock"的另一半：
 *   mock 也不许偷偷变聪明。
 *
 * 错误映射（适配器实现必须遵守）：
 * - 缺密钥/缺 endpoint → MODEL_NOT_CONFIGURED（禁止静默换 mock）；
 * - 有限修复（≤2 次）后仍不合 schema → MODEL_OUTPUT_INVALID，
 *   details 携带 { repairsApplied, rawExcerpt }；
 * - 超出请求 timeoutMs → MODEL_TIMEOUT。
 */
