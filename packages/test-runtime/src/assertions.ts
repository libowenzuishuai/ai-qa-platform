import type { AssertionOperator } from "@ai-qa/contracts";

/**
 * 程序化断言判定（PRD FR-07）。
 * 机器判定 expected/actual；自然语言解释不能覆盖结果。
 * 数值比较使用明确单位（金额最小货币单位 fen），不做字符串模糊匹配。
 */

export type AssertionValue = string | number | boolean | null;

export interface CompareResult {
  result: "PASS" | "FAIL" | "REVIEW";
  note?: string;
}

function toNumber(value: AssertionValue): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return null;
  const trimmed = value.replace(/[,，\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export function compareAssertion(
  operator: AssertionOperator,
  expected: AssertionValue,
  actual: AssertionValue,
): CompareResult {
  switch (operator) {
    case "equals":
      if (typeof expected === "number") {
        const a = toNumber(actual);
        if (a === null) return { result: "REVIEW", note: `实际值无法解析为数字：${actual}` };
        return { result: a === expected ? "PASS" : "FAIL" };
      }
      return { result: actual === expected ? "PASS" : "FAIL" };
    case "notEquals":
      if (typeof expected === "number") {
        const a = toNumber(actual);
        if (a === null) return { result: "REVIEW", note: `实际值无法解析为数字：${actual}` };
        return { result: a !== expected ? "PASS" : "FAIL" };
      }
      return { result: actual !== expected ? "PASS" : "FAIL" };
    case "contains":
      return { result: String(actual).includes(String(expected)) ? "PASS" : "FAIL" };
    case "notContains":
      return { result: !String(actual).includes(String(expected)) ? "PASS" : "FAIL" };
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const e = toNumber(expected);
      const a = toNumber(actual);
      if (e === null || a === null) {
        return { result: "REVIEW", note: "数值比较的 expected/actual 无法解析为数字" };
      }
      switch (operator) {
        case "gt":
          return { result: a > e ? "PASS" : "FAIL" };
        case "gte":
          return { result: a >= e ? "PASS" : "FAIL" };
        case "lt":
          return { result: a < e ? "PASS" : "FAIL" };
        default:
          return { result: a <= e ? "PASS" : "FAIL" };
      }
    }
    case "matches": {
      try {
        return { result: new RegExp(String(expected)).test(String(actual)) ? "PASS" : "FAIL" };
      } catch {
        return { result: "REVIEW", note: "expected 不是合法正则" };
      }
    }
    case "exists":
    case "notExists":
      // 元素存在性由执行器以 elementCount 结果传入（"0"/"1"）。
      return { result: "REVIEW", note: "exists/notExists 由执行器元素探测判定" };
  }
}
