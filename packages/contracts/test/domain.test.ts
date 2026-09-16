import { describe, expect, it } from "vitest";
import {
  RUN_LIFECYCLE_TERMINAL,
  RUN_LIFECYCLE_TRANSITIONS,
  RuleVersion,
  TestCaseVersion,
  ApiErrorBody,
  canTransitionRunLifecycle,
} from "../src/index.js";

describe("Run 生命周期状态机", () => {
  it("正常路径 QUEUED→…→FINISHED 全部合法", () => {
    expect(canTransitionRunLifecycle("QUEUED", "PREPARING")).toBe(true);
    expect(canTransitionRunLifecycle("PREPARING", "RUNNING")).toBe(true);
    expect(canTransitionRunLifecycle("RUNNING", "FINALIZING")).toBe(true);
    expect(canTransitionRunLifecycle("FINALIZING", "FINISHED")).toBe(true);
  });

  it("终态不可回退", () => {
    for (const terminal of RUN_LIFECYCLE_TERMINAL) {
      for (const target of ["QUEUED", "PREPARING", "RUNNING", "FINALIZING", "CANCEL_REQUESTED", "FINISHED", "CANCELLED", "ERROR"] as const) {
        expect(canTransitionRunLifecycle(terminal, target)).toBe(false);
      }
    }
  });

  it("不允许跳过阶段（如 QUEUED→RUNNING）", () => {
    expect(canTransitionRunLifecycle("QUEUED", "RUNNING")).toBe(false);
    expect(canTransitionRunLifecycle("QUEUED", "FINISHED")).toBe(false);
  });

  it("任意非终态可请求取消，取消后只能落 CANCELLED 或 ERROR", () => {
    expect(canTransitionRunLifecycle("RUNNING", "CANCEL_REQUESTED")).toBe(true);
    expect(canTransitionRunLifecycle("CANCEL_REQUESTED", "CANCELLED")).toBe(true);
    expect(canTransitionRunLifecycle("CANCEL_REQUESTED", "RUNNING")).toBe(false);
    expect(RUN_LIFECYCLE_TRANSITIONS["CANCEL_REQUESTED"]).not.toContain("FINISHED");
  });
});

describe("RuleVersion", () => {
  const base = {
    id: "rule-1-v1",
    ruleId: "rule-1",
    version: 1,
    statement: "采购单金额超过 5000 元需主管审批",
    classification: "EXPLICIT",
    action: "提交采购单",
    expectation: "进入待审批状态",
    sources: [
      { documentVersionId: "doc-1", sourceSpanIds: ["span-1"] },
    ],
    origin: "manual",
    createdAt: "2026-09-16T00:00:00Z",
  } as const;

  it("接受带真实来源的 EXPLICIT 规则", () => {
    expect(RuleVersion.parse(base).classification).toBe("EXPLICIT");
  });

  it("拒绝无来源的 EXPLICIT 规则（原文没有的信息不得写成 EXPLICIT）", () => {
    expect(() => RuleVersion.parse({ ...base, sources: [] })).toThrow(/EXPLICIT/);
  });

  it("无来源的 INFERRED 规则合法", () => {
    expect(RuleVersion.parse({ ...base, classification: "INFERRED", sources: [] }).classification).toBe("INFERRED");
  });
});

describe("TestCaseVersion", () => {
  const base = {
    id: "tc-1-v1",
    caseId: "tc-1",
    version: 1,
    title: "金额超过阈值需审批",
    ruleVersionIds: ["rule-1-v1"],
    roles: ["applicant", "approver"],
    dataSpec: { strategy: "create", note: "从页面创建采购单，金额 5000.01 元" },
    steps: [
      { id: "st1", role: "applicant", action: "创建并提交 5000.01 元采购单" },
      { id: "st2", role: "approver", action: "审批通过" },
    ],
    assertions: [
      { id: "a1", description: "审批后订单状态为已审批", kind: "ui.text", required: true, ruleVersionId: "rule-1-v1", operator: "equals", expected: "已审批" },
    ],
    cleanup: { strategy: "namespace" },
    origin: "manual",
    createdAt: "2026-09-16T00:00:00Z",
  } as const;

  it("接受结构完整的用例", () => {
    expect(TestCaseVersion.parse(base).assertions).toHaveLength(1);
  });

  it("拒绝空断言用例", () => {
    expect(() => TestCaseVersion.parse({ ...base, assertions: [] })).toThrow(/空断言/);
  });

  it("拒绝引用未声明规则的断言", () => {
    expect(() =>
      TestCaseVersion.parse({
        ...base,
        assertions: [{ ...base.assertions[0], ruleVersionId: "rule-9-v1" }],
      }),
    ).toThrow(/ruleVersionIds 中声明/);
  });

  it("拒绝角色外步骤", () => {
    expect(() =>
      TestCaseVersion.parse({
        ...base,
        steps: [{ ...base.steps[0], role: "auditor" }],
      }),
    ).toThrow(/roles 中声明/);
  });

  // ---------- R1 回归：验收语义必须完整保留 ----------

  it("R1：lte 与 gt 解析后保持不同（operator 不丢失）", () => {
    const lte = TestCaseVersion.parse({
      ...base,
      assertions: [{ ...base.assertions[0], kind: "data.value", operator: "lte", expected: 500000, unit: "fen" }],
    });
    const gt = TestCaseVersion.parse({
      ...base,
      assertions: [{ ...base.assertions[0], kind: "data.value", operator: "gt", expected: 500000, unit: "fen" }],
    });
    expect(lte.assertions[0]!.operator).toBe("lte");
    expect(gt.assertions[0]!.operator).toBe("gt");
    expect(lte.assertions[0]!.operator).not.toBe(gt.assertions[0]!.operator);
  });

  it("R1：缺 operator 的断言被拒绝（不再静默丢弃）", () => {
    const { operator: _omit, ...withoutOperator } = base.assertions[0];
    expect(() =>
      TestCaseVersion.parse({ ...base, assertions: [withoutOperator] }),
    ).toThrow();
  });

  it("R1：数值断言缺 expected 被拒绝（无论审批状态）", () => {
    expect(() =>
      TestCaseVersion.parse({
        ...base,
        assertions: [{ ...base.assertions[0], kind: "data.value", operator: "lte", expected: undefined }],
      }),
    ).toThrow(/expected/);
  });

  it("R1：数值断言缺单位被拒绝", () => {
    expect(() =>
      TestCaseVersion.parse({
        ...base,
        assertions: [{ ...base.assertions[0], kind: "data.value", operator: "lte", expected: 500000, unit: undefined }],
      }),
    ).toThrow(/单位/);
  });

  it("R1：APPROVED 用例缺少 approvalHash 被拒绝", () => {
    expect(() =>
      TestCaseVersion.parse({ ...base, approvalStatus: "APPROVED" }),
    ).toThrow(/approvalHash/);
    expect(() =>
      TestCaseVersion.parse({ ...base, approvalStatus: "APPROVED", approvalHash: "h" }),
    ).not.toThrow();
  });
});

describe("ApiErrorBody", () => {
  it("接受标准错误体", () => {
    expect(
      ApiErrorBody.parse({
        code: "VALIDATION_ERROR",
        message: "baseUrl 必须是合法 URL",
        requestId: "req-1",
        details: { field: "baseUrl" },
      }).code,
    ).toBe("VALIDATION_ERROR");
  });

  it("拒绝缺失 requestId 与非法错误码格式", () => {
    expect(() =>
      ApiErrorBody.parse({ code: "VALIDATION_ERROR", message: "x" } as never),
    ).toThrow();
    expect(() =>
      ApiErrorBody.parse({ code: "not-a-code", message: "x", requestId: "r" }),
    ).toThrow();
  });
});
