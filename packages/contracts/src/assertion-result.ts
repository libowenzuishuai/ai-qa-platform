import { z } from "zod";
import { EntityId, IsoDateTime } from "./common.js";
import { AssertionResultKind } from "./enums.js";

/**
 * 断言执行结果（PRD FR-07 / §6 AssertionResult）。
 * 每条断言记录 expected、actual、判定、时间和证据；
 * 数值使用明确单位，不做字符串近似匹配。
 */
export const AssertionResult = z.object({
  assertionId: EntityId,
  expected: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  actual: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  unit: z.string().optional(),
  result: AssertionResultKind,
  evaluatedAt: IsoDateTime,
  evidenceIds: z.array(EntityId).default([]),
  note: z.string().optional(),
});
export type AssertionResult = z.infer<typeof AssertionResult>;

/** 用例尝试（PRD §6 CaseExecution / Attempt）。多个 attempt 不能被覆盖。 */
export const CaseAttempt = z.object({
  id: EntityId,
  runId: EntityId,
  caseVersionId: EntityId,
  attemptNo: z.number().int().min(1),
  namespace: z.string().min(1),
  verdict: z.enum(["PASS", "FAIL", "BLOCKED", "REVIEW", "NOT_RUN"]),
  reasonCode: z.enum([
    "BUSINESS_MISMATCH",
    "ENVIRONMENT",
    "AUTH",
    "TEST_DATA",
    "LOCATOR",
    "MODEL",
    "TIME_BUDGET",
    "UNCERTAIN_SIDE_EFFECT",
    "UNSUPPORTED",
    "CANCELLED",
    "NONE",
  ]),
  unstable: z.boolean().default(false),
  startedAt: IsoDateTime.nullable().default(null),
  finishedAt: IsoDateTime.nullable().default(null),
});
export type CaseAttempt = z.infer<typeof CaseAttempt>;
