import { describe, expect, it } from "vitest";
import { deterministicDecide } from "../src/v2/decision-baseline.js";
import type { DecisionRequestInput } from "@ai-qa/contracts";

/** W08 确定性决策基线：命中选择、无命中回退、平局不猜。 */
const req = (over: Partial<DecisionRequestInput> = {}): DecisionRequestInput => ({
  question: "浏览器界面验证怎么选",
  options: [
    { id: "browser", label: "浏览器界面验证", context: "" },
    { id: "api", label: "HTTP 接口验证", context: "" },
  ],
  kind: "choose",
  ...over,
});

describe("W08 确定性决策基线", () => {
  it("关键词命中唯一选项 → 选中", () => {
    const result = deterministicDecide(req());
    expect(result.fallbackUsed).toBe(false);
    expect(result.selectedOptionId).toBe("browser");
  });

  it("无命中 → 回退（不猜）", () => {
    const result = deterministicDecide(req({ question: "完全不相关的词" }));
    expect(result.fallbackUsed).toBe(true);
    expect(result.selectedOptionId).toBeNull();
    expect(result.fallbackReason).toContain("无关键词命中");
  });

  it("平局（choose）→ 回退", () => {
    const result = deterministicDecide(req({ question: "验证" }));
    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackReason).toContain("平局");
  });

  it("score 类型：给出归一化分值", () => {
    const result = deterministicDecide(req({ kind: "score", question: "浏览器界面验证" }));
    expect(result.fallbackUsed).toBe(false);
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});
