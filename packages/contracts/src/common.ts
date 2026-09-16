import { z } from "zod";

/** 实体 id：内部稳定英文值（PRD §1.1），前缀 + 随机段。 */
export const EntityId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/, "id 必须是稳定的英文标识符");

export const IsoDateTime = z.string().datetime({ offset: true });

/** 金额与数量等业务数值使用字符串承载十进制，避免浮点误差；比较用 decimal。 */
export const DecimalString = z.string().regex(
  /^-?\d+(\.\d+)?$/,
  "必须是十进制数字字符串，例如 \"5000.01\"；金额需明确单位",
);

/** 预算（PRD FR-11）：工程限制，不是业务 SLA。 */
export const Budget = z.object({
  maxToolActionsPerCase: z.number().int().min(1).max(1000).default(50),
  maxModelRequestsPerCase: z.number().int().min(1).max(200).default(20),
  maxWallClockMsPerCase: z.number().int().min(10_000).max(3_600_000).default(300_000),
  maxModelRequestsPerRun: z.number().int().min(1).max(10_000).default(2_000),
  maxTokensPerRun: z.number().int().min(1_000).default(2_000_000),
  maxWallClockMsPerRun: z.number().int().min(60_000).max(43_200_000).default(7_200_000),
});
export type Budget = z.infer<typeof Budget>;
