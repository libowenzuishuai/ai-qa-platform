import { z } from "zod";

/**
 * 共享断言语义（用例层与计划层一致，评审 R1）。
 *
 * 用例（TestCaseVersion.assertions）与计划（TestPlanV1.assertions）的断言
 * 必须携带同一套机器可读验收语义：operator / expected / unit。
 * 用例层丢失 operator 会导致"必须 <="与"必须 >"解析后不可区分，
 * 破坏"先批准标准，再执行"的基础。
 */

export const ASSERTION_KINDS = [
  "ui.text",
  "ui.element",
  "ui.state",
  "data.value",
  "api.response",
  "download.content",
  "visual",
] as const;
export type AssertionKind = (typeof ASSERTION_KINDS)[number];

export const ASSERTION_OPERATORS = [
  "equals",
  "notEquals",
  "contains",
  "notContains",
  "gt",
  "gte",
  "lt",
  "lte",
  "matches",
  "exists",
  "notExists",
] as const;
export type AssertionOperator = (typeof ASSERTION_OPERATORS)[number];

/** 不需要 expected 的运算符。 */
export const EXPECTED_OPTIONAL_OPERATORS: ReadonlySet<AssertionOperator> = new Set([
  "exists",
  "notExists",
]);

/** 数值比较运算符：expected 必须是数字，且必须声明单位。 */
export const NUMERIC_OPERATORS: ReadonlySet<AssertionOperator> = new Set([
  "gt",
  "gte",
  "lt",
  "lte",
]);

export const ExpectedValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * 断言语义校验（两层共用）：
 * - 比较运算符需要非空 expected；
 * - 数值运算符 expected 必须是数字且带明确单位（金额用最小货币单位，如 fen）。
 */
export function refineAssertionSemantics<
  T extends {
    operator: AssertionOperator;
    expected?: z.infer<typeof ExpectedValue>;
    unit?: string;
  },
>(a: T, ctx: z.RefinementCtx): void {
  const needsExpected = !EXPECTED_OPTIONAL_OPERATORS.has(a.operator);
  if (needsExpected && (a.expected === undefined || a.expected === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expected"],
      message: `运算符 ${a.operator} 需要非空 expected`,
    });
  }
  if (NUMERIC_OPERATORS.has(a.operator)) {
    if (typeof a.expected !== "number") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expected"],
        message: `数值运算符 ${a.operator} 的 expected 必须是数字`,
      });
    }
    if (!a.unit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unit"],
        message: "数值断言必须声明单位（金额用最小货币单位，如 fen）",
      });
    }
  }
}
