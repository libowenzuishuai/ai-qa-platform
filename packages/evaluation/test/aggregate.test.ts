import { describe, expect, it } from "vitest";
import { aggregateCase, aggregateRun, percent, type CaseOutcomeInput } from "../src/index.js";

const base: CaseOutcomeInput = {
  caseVersionId: "c1",
  selected: true,
  started: true,
  assertions: [
    { assertionId: "a1", required: true, result: "PASS" },
    { assertionId: "a2", required: false, result: "FAIL" },
  ],
  evidenceComplete: true,
};

describe("aggregateCase —— PRD §5.2", () => {
  it("必需断言 PASS + 证据完整 → PASS", () => {
    expect(aggregateCase(base).verdict).toBe("PASS");
  });

  it("必需断言 FAIL → FAIL（后续受阻也保留）", () => {
    const result = aggregateCase({
      ...base,
      blocked: { reasonCode: "ENVIRONMENT" },
      assertions: [
        { assertionId: "a1", required: true, result: "FAIL" },
        { assertionId: "a2", required: true, result: "NOT_EVALUATED" },
      ],
    });
    expect(result.verdict).toBe("FAIL");
    expect(result.reasonCode).toBe("BUSINESS_MISMATCH");
  });

  it("无 FAIL 但关键步骤受阻 → BLOCKED（带原因码）", () => {
    for (const reasonCode of ["AUTH", "ENVIRONMENT", "TIME_BUDGET", "UNCERTAIN_SIDE_EFFECT", "CANCELLED"] as const) {
      const result = aggregateCase({
        ...base,
        blocked: { reasonCode },
        assertions: [{ assertionId: "a1", required: true, result: "NOT_EVALUATED" }],
      });
      expect(result.verdict).toBe("BLOCKED");
      expect(result.reasonCode).toBe(reasonCode);
    }
  });

  it("证据缺失或必需步骤被跳过 → REVIEW", () => {
    expect(aggregateCase({ ...base, evidenceComplete: false }).verdict).toBe("REVIEW");
    expect(aggregateCase({ ...base, requiredStepsSkipped: true }).verdict).toBe("REVIEW");
  });

  it("从未开始或未选定 → NOT_RUN", () => {
    expect(aggregateCase({ ...base, started: false }).verdict).toBe("NOT_RUN");
    expect(aggregateCase({ ...base, selected: false }).verdict).toBe("NOT_RUN");
  });

  it("空断言集合禁止 PASS → REVIEW", () => {
    const result = aggregateCase({ ...base, assertions: [] });
    expect(result.verdict).toBe("REVIEW");
  });

  it("必需断言未全部判定 → REVIEW", () => {
    const result = aggregateCase({
      ...base,
      assertions: [
        { assertionId: "a1", required: true, result: "PASS" },
        { assertionId: "a2", required: true, result: "NOT_EVALUATED" },
      ],
    });
    expect(result.verdict).toBe("REVIEW");
  });

  it("非必需断言 FAIL 不影响 PASS", () => {
    expect(base.assertions[1]!.required).toBe(false);
    expect(aggregateCase(base).verdict).toBe("PASS");
  });
});

describe("aggregateRun —— FR-10", () => {
  const caseOf = (id: string, verdict: "PASS" | "FAIL" | "BLOCKED" | "REVIEW" | "NOT_RUN") => ({
    caseVersionId: id,
    verdict,
    reasonCode: "NONE",
  });

  it("全 PASS → 严格验收 PASS", () => {
    const m = aggregateRun({ cases: [caseOf("c1", "PASS"), caseOf("c2", "PASS")] });
    expect(m.acceptanceStatus).toBe("PASS");
    expect(m.executionRate).toBe(1);
    expect(m.passRate).toBe(1);
  });

  it("有 FAIL → 严格验收 FAIL", () => {
    const m = aggregateRun({ cases: [caseOf("c1", "PASS"), caseOf("c2", "FAIL")] });
    expect(m.acceptanceStatus).toBe("FAIL");
  });

  it("BLOCKED/REVIEW/NOT_RUN/unstable/取消/缺构建标识 → INCOMPLETE", () => {
    expect(aggregateRun({ cases: [caseOf("c1", "BLOCKED")] }).acceptanceStatus).toBe("INCOMPLETE");
    expect(aggregateRun({ cases: [caseOf("c1", "REVIEW")] }).acceptanceStatus).toBe("INCOMPLETE");
    expect(aggregateRun({ cases: [caseOf("c1", "NOT_RUN")] }).acceptanceStatus).toBe("INCOMPLETE");
    expect(
      aggregateRun({
        cases: [{ ...caseOf("c1", "PASS"), unstable: true } as never],
      }).acceptanceStatus,
    ).toBe("INCOMPLETE");
    expect(aggregateRun({ cases: [caseOf("c1", "PASS")], cancelled: true }).acceptanceStatus).toBe(
      "INCOMPLETE",
    );
    expect(
      aggregateRun({ cases: [caseOf("c1", "PASS")], hasBuildId: false }).acceptanceStatus,
    ).toBe("INCOMPLETE");
  });

  it("空集合 → INCOMPLETE 且分母为零显示 N/A（不显示 100%）", () => {
    const m = aggregateRun({ cases: [] });
    expect(m.acceptanceStatus).toBe("INCOMPLETE");
    expect(m.executionRate).toBeNull();
    expect(m.passRate).toBeNull();
    expect(percent(m.passRate)).toBe("N/A");
  });

  it("执行率不含 BLOCKED/REVIEW/NOT_RUN", () => {
    const m = aggregateRun({
      cases: [caseOf("c1", "PASS"), caseOf("c2", "FAIL"), caseOf("c3", "BLOCKED"), caseOf("c4", "NOT_RUN")],
    });
    expect(m.totalSelected).toBe(4);
    expect(m.executionRate).toBe(0.5);
    expect(m.passRate).toBe(0.25);
  });

  it("规则覆盖率分母为零 → N/A", () => {
    expect(aggregateRun({ cases: [caseOf("c1", "PASS")], baselineRuleTotal: 0 }).ruleCoverage).toBeNull();
    expect(
      aggregateRun({ cases: [caseOf("c1", "PASS")], baselineRuleTotal: 4, baselineRuleCovered: 1 }).ruleCoverage,
    ).toBe(0.25);
  });
});
