import { z } from "zod";

/**
 * API 错误结构（PRD §8）。
 * 错误体统一含 code / message / requestId / details；
 * details 不得泄露密钥或凭据。
 */
export const ApiErrorBody = z.object({
  code: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/, "错误码使用 SCREAMING_SNAKE_CASE"),
  message: z.string().min(1),
  requestId: z.string().min(1),
  details: z.unknown().optional(),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

/** 平台统一错误码。可按需扩展，但必须保持稳定英文值。 */
export const ApiErrorCode = z.enum([
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_ERROR",
  "CONFLICT",
  "VERSION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "CONFIG_MISSING",
  "DEPENDENCY_UNAVAILABLE",
  "UNSUPPORTED",
  "RATE_LIMITED",
  "BUDGET_EXCEEDED",
  "CANCELLED",
  "INTERNAL",
  // ---------- 阶段 2 增补（docs/stage2-step0-contracts.md §2.6）----------
  /** real 模式缺密钥/endpoint；禁止降级 mock。details: {provider, missing[]} */
  "MODEL_NOT_CONFIGURED",
  /** 有限修复（≤2 次）后仍不合 schema；mock 查表 miss 复用。
   *  details: {repairsApplied, rawExcerpt} 或 {mockTable, inputHash} */
  "MODEL_OUTPUT_INVALID",
  /** 超出请求的 timeoutMs。details: {timeoutMs} */
  "MODEL_TIMEOUT",
  /** 解析器异常退出（区别于 NEEDS_OCR 终态）。details: {parserVersion} */
  "PARSE_FAILED",
  /** 对 NEEDS_OCR 版本发起 rule-extraction 时拒绝。
   *  details: {documentVersionId} */
  "NEEDS_OCR",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

/** HTTP 状态码与错误码的默认映射（PRD §8）。 */
export const DEFAULT_HTTP_STATUS_BY_CODE: Readonly<Record<string, number>> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 422,
  CONFLICT: 409,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  CONFIG_MISSING: 503,
  DEPENDENCY_UNAVAILABLE: 503,
  UNSUPPORTED: 422,
  RATE_LIMITED: 429,
  BUDGET_EXCEEDED: 429,
  CANCELLED: 409,
  INTERNAL: 500,
  MODEL_NOT_CONFIGURED: 503,
  MODEL_OUTPUT_INVALID: 500,
  MODEL_TIMEOUT: 504,
  PARSE_FAILED: 422,
  NEEDS_OCR: 422,
};
