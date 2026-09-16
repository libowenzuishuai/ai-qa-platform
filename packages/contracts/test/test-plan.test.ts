import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  PHASE1_EXECUTOR_ACTIONS,
  TestPlanV1,
  TestCaseVersion,
  computeAcceptanceHash,
  computePlanAcceptanceHash,
  extractAcceptanceProtectedFields,
  validatePlanAgainstApprovedCase,
  validatePlanForExecutor,
  verifyStoredPlan,
  type TestCaseVersion as TestCase,
  type TestPlanV1 as TestPlan,
} from "../src/index.js";

/** 构造合法基线用例（断言携带 operator —— 评审 R1）。 */
function makeTestCase(overrides: Partial<TestCase> = {}): TestCase {
  return TestCaseVersion.parse({
    id: "tc-order-001-v1",
    caseId: "tc-order-001",
    version: 1,
    title: "金额超过阈值需审批",
    ruleVersionIds: ["rule-approval-v1"],
    roles: ["applicant", "approver"],
    preconditions: ["申请人已登录"],
    dataSpec: { strategy: "create", note: "从页面创建采购单，金额 5000.01 元" },
    steps: [
      { id: "st1", role: "applicant", action: "创建并提交 5000.01 元采购单", expectedResult: "进入待审批" },
      { id: "st2", role: "approver", action: "审批通过" },
    ],
    assertions: [
      {
        id: "a1",
        description: "提交后订单状态为待审批",
        kind: "ui.text",
        required: true,
        ruleVersionId: "rule-approval-v1",
        operator: "equals",
        expected: "待审批",
      },
    ],
    cleanup: { strategy: "namespace" },
    origin: "manual",
    approvalStatus: "APPROVED",
    approvalHash: "placeholder-filled-by-helper",
    createdAt: "2026-09-16T00:00:00Z",
    ...overrides,
  });
}

/** 预解析草稿：使用 zod 输入类型（acceptanceHash 后算）。 */
type PlanDraft = Omit<z.input<typeof TestPlanV1>, "acceptanceHash"> & {
  acceptanceHash?: string;
};

/** 构造合法基线计划（结构参照 PRD §7.2 示例，引用完整闭合）。 */
function makeValidPlan(caseOverrides: Partial<TestCase> = {}): TestPlan {
  const testCase = makeTestCase(caseOverrides);
  const draft: PlanDraft = {
    schemaVersion: "1.0",
    caseVersionId: testCase.id,
    ruleVersionIds: ["rule-approval-v1"],
    roles: ["applicant", "approver"],
    bindings: [
      {
        targetRef: "observed-amount",
        locator: { type: "testId", value: "amount-input" },
        observedUrl: "http://demo.local/orders/new",
        observedAt: "2026-09-16T00:00:00Z",
        evidenceId: "art-observe-1",
      },
      {
        targetRef: "observed-submit",
        locator: { type: "role", role: "button", name: "提交审批" },
        observedUrl: "http://demo.local/orders/new",
        observedAt: "2026-09-16T00:00:00Z",
        evidenceId: "art-observe-2",
      },
      {
        targetRef: "observed-order-status",
        locator: { type: "testId", value: "order-status" },
        observedUrl: "http://demo.local/orders",
        observedAt: "2026-09-16T00:00:01Z",
        evidenceId: "art-observe-3",
      },
    ],
    actions: [
      { id: "s1", type: "switchRole", role: "applicant", effect: "READ" },
      { id: "s2", type: "goto", path: "/orders/new", effect: "READ" },
      {
        id: "s3",
        type: "fill",
        targetRef: "observed-amount",
        value: { source: "literal", value: "5000.01" },
        effect: "READ",
      },
      { id: "s4", type: "click", targetRef: "observed-submit", effect: "WRITE" },
      { id: "s6", type: "assert", assertionId: "a1", effect: "READ" },
    ],
    assertions: [
      {
        id: "a1",
        stepId: "s6",
        required: true,
        ruleVersionId: "rule-approval-v1",
        kind: "ui.text",
        targetRef: "observed-order-status",
        operator: "equals",
        expected: "待审批",
      },
    ],
  };
  const acceptanceHash = computePlanAcceptanceHash({ testCase, plan: draft });
  return TestPlanV1.parse({ ...draft, acceptanceHash });
}

describe("TestPlan v1 —— 合法计划", () => {
  it("接受结构闭合的 PRD 示例计划", () => {
    const plan = makeValidPlan();
    expect(plan.actions).toHaveLength(5);
    expect(plan.acceptanceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("接受有界轮询与显式顺序分支", () => {
    const plan = makeValidPlan();
    const draft: PlanDraft = {
      ...plan,
      bindings: [
        ...plan.bindings,
        {
          targetRef: "observed-order-id",
          locator: { type: "testId", value: "order-id" },
          observedUrl: "http://demo.local/orders",
          observedAt: "2026-09-16T00:00:01Z",
          evidenceId: "art-observe-6",
        },
        {
          targetRef: "observed-toast",
          locator: { type: "testId", value: "toast" },
          observedUrl: "http://demo.local/orders",
          observedAt: "2026-09-16T00:00:02Z",
          evidenceId: "art-observe-4",
        },
      ],
      actions: [
        ...plan.actions.slice(0, 4),
        {
          id: "s4b",
          type: "captureValue",
          targetRef: "observed-order-id",
          saveAs: "orderId",
          effect: "READ",
        },
        {
          id: "s5",
          type: "waitFor",
          targetRef: "observed-toast",
          condition: { kind: "text", value: "提交成功" },
          timeoutMs: 10_000,
          pollMs: 500,
          maxAttempts: 20,
          effect: "READ",
          onlyIf: { varName: "orderId", operator: "neq", value: "" },
        },
        plan.actions[4]!,
      ],
    };
    const extended = TestPlanV1.parse({
      ...draft,
      acceptanceHash: computePlanAcceptanceHash({ testCase: makeTestCase(), plan: draft }),
    });
    expect(extended.actions).toHaveLength(7);
  });

  it("waitFor urlContains 不需要 targetRef", () => {
    const plan = makeValidPlan();
    const draft: PlanDraft = {
      ...plan,
      actions: [
        ...plan.actions.slice(0, 4),
        {
          id: "s5",
          type: "waitFor",
          condition: { kind: "urlContains", value: "/orders" },
          timeoutMs: 10_000,
          pollMs: 500,
          maxAttempts: 20,
          effect: "READ",
        },
        plan.actions[4]!,
      ],
    };
    expect(() =>
      TestPlanV1.parse({
        ...draft,
        acceptanceHash: computePlanAcceptanceHash({ testCase: makeTestCase(), plan: draft }),
      }),
    ).not.toThrow();
  });
});

describe("TestPlan v1 —— 拒绝非法动作", () => {
  it("拒绝未列明的动作类型", () => {
    const plan = makeValidPlan();
    const draft: PlanDraft = {
      ...plan,
      actions: [
        ...plan.actions,
        // 任意代码执行类动作不允许入库
        {
          id: "s9",
          type: "eval",
          code: "await page.evaluate(() => 1)",
          effect: "READ",
        } as never,
      ],
    };
    expect(() => TestPlanV1.parse({ ...draft, acceptanceHash: "0".repeat(64) })).toThrow(
      /eval|Invalid/i,
    );
  });

  it("拒绝非法 effect 值", () => {
    const plan = makeValidPlan();
    expect(() =>
      TestPlanV1.parse({
        ...plan,
        actions: [
          ...plan.actions,
          { id: "s9", type: "goto", path: "/x", effect: "SIDE_EFFECT" as never },
        ],
      }),
    ).toThrow();
  });

  it("拒绝绝对 URL 的 goto（只允许相对路径）", () => {
    const plan = makeValidPlan();
    expect(() =>
      TestPlanV1.parse({
        ...plan,
        actions: [
          ...plan.actions,
          { id: "s9", type: "goto", path: "http://evil.example.com", effect: "READ" },
        ],
      }),
    ).toThrow(/相对路径/);
  });

  it("R5：拒绝协议相对路径 //host（同站校验）", () => {
    const plan = makeValidPlan();
    expect(() =>
      TestPlanV1.parse({
        ...plan,
        actions: [
          ...plan.actions,
          { id: "s9", type: "goto", path: "//other.invalid/orders", effect: "READ" },
        ],
      }),
    ).toThrow(/相对路径/);
    // 语义确认：这类路径经 new URL 解析会指向其它 host。
    const resolved = new URL("//other.invalid/orders", "https://qa.example.com");
    expect(resolved.origin).toBe("https://other.invalid");
  });

  it("R5：拒绝反斜杠路径（浏览器归一化后可跳站）", () => {
    const plan = makeValidPlan();
    expect(() =>
      TestPlanV1.parse({
        ...plan,
        actions: [
          ...plan.actions,
          { id: "s9", type: "goto", path: "/\\other.invalid/orders", effect: "READ" },
        ],
      }),
    ).toThrow(/相对路径/);
  });

  it("拒绝无界轮询（maxAttempts 超上限）", () => {
    const plan = makeValidPlan();
    expect(() =>
      TestPlanV1.parse({
        ...plan,
        actions: [
          ...plan.actions,
          {
            id: "s9",
            type: "waitFor",
            condition: { kind: "visible" },
            targetRef: "observed-toast" in {} ? undefined : undefined,
            timeoutMs: 10_000,
            pollMs: 500,
            maxAttempts: 100_000,
            effect: "READ",
          },
        ],
      }),
    ).toThrow();
  });

  it("拒绝计划角色外的 switchRole", () => {
    const plan = makeValidPlan();
    expect(() =>
      TestPlanV1.parse({
        ...plan,
        actions: [
          ...plan.actions,
          { id: "s9", type: "switchRole", role: "admin", effect: "READ" },
        ],
      }),
    ).toThrow(/roles 中声明/);
  });

  it("三.3：拒绝条件捕获（captureValue + onlyIf）", () => {
    const plan = makeValidPlan();
    const draft: PlanDraft = {
      ...plan,
      bindings: [
        ...plan.bindings,
        {
          targetRef: "observed-order-id",
          locator: { type: "testId", value: "order-id" },
          observedUrl: "http://demo.local/orders",
          observedAt: "2026-09-16T00:00:01Z",
          evidenceId: "art-observe-6",
        },
      ],
      actions: [
        ...plan.actions.slice(0, 4),
        {
          id: "s4b",
          type: "captureValue",
          targetRef: "observed-order-id",
          saveAs: "maybeVar",
          effect: "READ",
          onlyIf: { varName: "orderId", operator: "eq", value: "x" },
        },
        plan.actions[4]!,
      ],
    };
    expect(() => TestPlanV1.parse({ ...draft, acceptanceHash: "0".repeat(64) })).toThrow(
      /onlyIf|尚未定义/,
    );
  });
});

describe("TestPlan v1 —— 拒绝断裂引用", () => {
  it("拒绝未登记观察绑定的 targetRef（不能凭空创建 selector）", () => {
    const plan = makeValidPlan();
    expect(() =>
      TestPlanV1.parse({
        ...plan,
        actions: [
          ...plan.actions,
          { id: "s9", type: "click", targetRef: "never-observed", effect: "READ" },
        ],
      }),
    ).toThrow(/未在 bindings 登记/);
  });

  it("拒绝引用不存在的断言", () => {
    const plan = makeValidPlan();
    expect(() =>
      TestPlanV1.parse({
        ...plan,
        actions: [
          ...plan.actions,
          { id: "s9", type: "assert", assertionId: "a-missing", effect: "READ" },
        ],
      }),
    ).toThrow(/不存在的断言/);
  });

  it("拒绝没有任何检查动作引用的断言", () => {
    const plan = makeValidPlan();
    expect(() =>
      TestPlanV1.parse({
        ...plan,
        assertions: [
          ...plan.assertions,
          {
            id: "a2",
            stepId: "s6",
            required: true,
            ruleVersionId: "rule-approval-v1",
            kind: "ui.text",
            targetRef: "observed-order-status",
            operator: "equals",
            expected: "x",
          },
        ],
      }),
    ).toThrow(/没有任何检查动作引用/);
  });

  it("拒绝引用计划外规则的断言", () => {
    const plan = makeValidPlan();
    expect(() =>
      TestPlanV1.parse({
        ...plan,
        assertions: [
          {
            ...plan.assertions[0]!,
            ruleVersionId: "rule-not-in-plan",
          },
        ],
      }),
    ).toThrow(/ruleVersionIds 中声明/);
  });

  it("拒绝先使用后定义的捕获变量", () => {
    const plan = makeValidPlan();
    const draft: PlanDraft = {
      ...plan,
      bindings: [
        ...plan.bindings,
        {
          targetRef: "observed-remark",
          locator: { type: "testId", value: "remark" },
          observedUrl: "http://demo.local/orders",
          observedAt: "2026-09-16T00:00:03Z",
          evidenceId: "art-observe-5",
        },
      ],
      actions: [
        {
          id: "s0",
          type: "fill",
          targetRef: "observed-remark",
          value: { source: "captured", varName: "notYetCaptured" },
          effect: "READ",
        },
        ...plan.actions,
      ],
    };
    expect(() => TestPlanV1.parse({ ...draft, acceptanceHash: "0".repeat(64) })).toThrow(
      /尚未定义/,
    );
  });

  it("拒绝断言 stepId 与实际检查动作不一致", () => {
    const plan = makeValidPlan();
    expect(() =>
      TestPlanV1.parse({
        ...plan,
        assertions: [{ ...plan.assertions[0]!, stepId: "s1" }],
      }),
    ).toThrow(/不一致/);
  });
});

describe("TestPlan v1 —— 拒绝空断言与目标缺失", () => {
  it("拒绝空断言集合（空断言禁止 PASS）", () => {
    const plan = makeValidPlan();
    expect(() => TestPlanV1.parse({ ...plan, assertions: [] as never })).toThrow();
  });

  it("拒绝空动作集合", () => {
    const plan = makeValidPlan();
    expect(() => TestPlanV1.parse({ ...plan, actions: [] as never })).toThrow();
  });

  it("拒绝 expected 缺失的比较断言", () => {
    const plan = makeValidPlan();
    expect(() =>
      TestPlanV1.parse({
        ...plan,
        assertions: [{ ...plan.assertions[0]!, expected: undefined, operator: "equals" }],
      }),
    ).toThrow(/expected/);
  });

  it("拒绝缺单位的数值断言（金额必须带最小货币单位）", () => {
    const plan = makeValidPlan();
    expect(() =>
      TestPlanV1.parse({
        ...plan,
        assertions: [
          { ...plan.assertions[0]!, operator: "gt", expected: 500000 },
        ],
      }),
    ).toThrow(/单位/);
  });

  it("三.1：ui.text 断言缺少 targetRef 被拒绝", () => {
    const plan = makeValidPlan();
    expect(() =>
      TestPlanV1.parse({
        ...plan,
        assertions: [{ ...plan.assertions[0]!, targetRef: undefined }],
      }),
    ).toThrow(/targetRef/);
  });

  it("三.1：断言 kind 与检查动作类型不一致被拒绝（assert 不能判 visual）", () => {
    const plan = makeValidPlan();
    expect(() =>
      TestPlanV1.parse({
        ...plan,
        assertions: [{ ...plan.assertions[0]!, kind: "visual" }],
      }),
    ).toThrow(/不能由 assert 动作判定/);
  });

  it("三.2：waitFor visible 缺少 targetRef 被拒绝", () => {
    const plan = makeValidPlan();
    const draft: PlanDraft = {
      ...plan,
      actions: [
        ...plan.actions.slice(0, 4),
        {
          id: "s5",
          type: "waitFor",
          condition: { kind: "visible" },
          timeoutMs: 10_000,
          pollMs: 500,
          maxAttempts: 20,
          effect: "READ",
        },
        plan.actions[4]!,
      ],
    };
    expect(() => TestPlanV1.parse({ ...draft, acceptanceHash: "0".repeat(64) })).toThrow(
      /waitFor visible 必须提供 targetRef/,
    );
  });
});

describe("执行器能力校验", () => {
  it("阶段 1 子集执行器拒绝 visualAction/apiCheck", () => {
    const plan = makeValidPlan();
    const withVisual = TestPlanV1.parse({
      ...plan,
      actions: [
        ...plan.actions,
        { id: "s7", type: "visualAction", instruction: "点击审批按钮", effect: "WRITE" },
      ],
    });
    const result = validatePlanForExecutor(withVisual, PHASE1_EXECUTOR_ACTIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.unsupported).toContain("visualAction");
  });

  it("全量能力通过阶段 1 子集计划", () => {
    const plan = makeValidPlan();
    expect(validatePlanForExecutor(plan, PHASE1_EXECUTOR_ACTIONS).ok).toBe(true);
  });
});

describe("R1：计划与已批准用例的一致性", () => {
  it("一致的计划通过校验", () => {
    const plan = makeValidPlan();
    const approved = makeTestCase();
    expect(validatePlanAgainstApprovedCase(plan, approved).ok).toBe(true);
  });

  it("计划改变 operator 被拒绝", () => {
    const plan = makeValidPlan();
    const approved = makeTestCase();
    const mutated = TestPlanV1.parse({
      ...plan,
      assertions: [{ ...plan.assertions[0]!, operator: "contains" }],
    });
    const result = validatePlanAgainstApprovedCase(mutated, approved);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.mismatches.join()).toMatch(/operator/);
  });

  it("计划改变 expected 被拒绝", () => {
    const plan = makeValidPlan();
    const approved = makeTestCase();
    const mutated = TestPlanV1.parse({
      ...plan,
      assertions: [{ ...plan.assertions[0]!, expected: "已审批" }],
    });
    expect(validatePlanAgainstApprovedCase(mutated, approved).ok).toBe(false);
  });

  it("计划出现用例外的断言被拒绝", () => {
    const plan = makeValidPlan();
    const approved = makeTestCase({
      assertions: [
        {
          id: "a1",
          description: "提交后订单状态为待审批",
          kind: "ui.text",
          required: true,
          ruleVersionId: "rule-approval-v1",
          operator: "equals",
          expected: "待审批",
        },
        {
          id: "a2",
          description: "付款待办包含该单",
          kind: "ui.text",
          required: true,
          ruleVersionId: "rule-approval-v1",
          operator: "equals",
          expected: "付款待办",
        },
      ],
    });
    // 计划只包含 a1，缺少 a2 → 拒绝。
    const result = validatePlanAgainstApprovedCase(plan, approved);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.mismatches.join()).toMatch(/缺失/);
  });
});

describe("R4：acceptanceHash 服务端统一提取", () => {
  it("相同语义产生相同哈希（对象键序无关）", () => {
    const h1 = computePlanAcceptanceHash({ testCase: makeTestCase(), plan: makeValidPlan() });
    const h2 = computePlanAcceptanceHash({ testCase: makeTestCase(), plan: makeValidPlan() });
    expect(h1).toBe(h2);
  });

  it("换 fixture（A→B）改变哈希", () => {
    const withA = makeTestCase({
      dataSpec: { strategy: "fixture", fixtureId: "fixture-a", params: { type: "unpaid" } },
    });
    const withB = makeTestCase({
      dataSpec: { strategy: "fixture", fixtureId: "fixture-b", params: { type: "unpaid" } },
    });
    const hA = computeAcceptanceHash(extractAcceptanceProtectedFields({ testCase: withA }));
    const hB = computeAcceptanceHash(extractAcceptanceProtectedFields({ testCase: withB }));
    expect(hA).not.toBe(hB);
  });

  it("改 fixture 参数改变哈希", () => {
    const base = makeTestCase({
      dataSpec: { strategy: "fixture", fixtureId: "fixture-a", params: { state: "unpaid" } },
    });
    const changed = makeTestCase({
      dataSpec: { strategy: "fixture", fixtureId: "fixture-a", params: { state: "paid" } },
    });
    expect(computeAcceptanceHash(extractAcceptanceProtectedFields({ testCase: base }))).not.toBe(
      computeAcceptanceHash(extractAcceptanceProtectedFields({ testCase: changed })),
    );
  });

  it("改步骤执行角色改变哈希（角色集合不变）", () => {
    const base = makeTestCase();
    const swapped = makeTestCase({
      steps: [
        { id: "st1", role: "approver", action: "创建并提交 5000.01 元采购单" },
        { id: "st2", role: "approver", action: "审批通过" },
      ],
    });
    // roles 集合不变（仍含两个角色），仅步骤角色映射变化。
    expect(swapped.roles).toEqual(base.roles);
    expect(computeAcceptanceHash(extractAcceptanceProtectedFields({ testCase: base }))).not.toBe(
      computeAcceptanceHash(extractAcceptanceProtectedFields({ testCase: swapped })),
    );
  });

  it("改 expected / operator / required 任意一项改变哈希", () => {
    const base = makeTestCase();
    const h = computeAcceptanceHash(extractAcceptanceProtectedFields({ testCase: base }));
    const changedExpected = makeTestCase({
      assertions: [{ ...base.assertions[0]!, expected: "已审批" }],
    });
    const changedOperator = makeTestCase({
      assertions: [{ ...base.assertions[0]!, operator: "contains" }],
    });
    const changedRequired = makeTestCase({
      assertions: [{ ...base.assertions[0]!, required: false }],
    });
    expect(
      computeAcceptanceHash(extractAcceptanceProtectedFields({ testCase: changedExpected })),
    ).not.toBe(h);
    expect(
      computeAcceptanceHash(extractAcceptanceProtectedFields({ testCase: changedOperator })),
    ).not.toBe(h);
    expect(
      computeAcceptanceHash(extractAcceptanceProtectedFields({ testCase: changedRequired })),
    ).not.toBe(h);
  });

  it("计划值引用：literal 值变化改变哈希；dataRef 与 literal 不同", () => {
    const testCase = makeTestCase();
    const planLiteral = makeValidPlan();
    const draftDataRef: PlanDraft = {
      ...planLiteral,
      actions: planLiteral.actions.map((a) =>
        a.id === "s3" && a.type === "fill"
          ? { ...a, value: { source: "dataRef", ref: "order-amount" } }
          : a,
      ),
    };
    expect(
      computePlanAcceptanceHash({ testCase, plan: planLiteral }),
    ).not.toBe(computePlanAcceptanceHash({ testCase, plan: draftDataRef }));

    const draftOtherLiteral: PlanDraft = {
      ...planLiteral,
      actions: planLiteral.actions.map((a) =>
        a.id === "s3" && a.type === "fill"
          ? { ...a, value: { source: "literal", value: "5000.02" } }
          : a,
      ),
    };
    expect(
      computePlanAcceptanceHash({ testCase, plan: planLiteral }),
    ).not.toBe(computePlanAcceptanceHash({ testCase, plan: draftOtherLiteral }));
  });

  it("合法定位/等待调整不改变哈希（locator 可变、语义不可变）", () => {
    const testCase = makeTestCase();
    const plan = makeValidPlan();
    const adjusted: PlanDraft = {
      ...plan,
      bindings: plan.bindings.map((b) =>
        b.targetRef === "observed-order-status"
          ? { ...b, locator: { type: "text", value: "状态" } }
          : b,
      ),
      actions: plan.actions.map((a) => a), // 动作语义不变
    };
    expect(computePlanAcceptanceHash({ testCase, plan })).toBe(
      computePlanAcceptanceHash({ testCase, plan: adjusted }),
    );
  });
});


describe("F5：goto 路径控制字符（URL 归一化跳站）", () => {
  const badPaths = [
    "/\t/other.invalid/path",
    "/\r/other.invalid/path",
    "/\n/other.invalid/path",
    "/\u0000/other.invalid",
    "/\u007f/other.invalid",
  ];
  for (const path of badPaths) {
    it(`拒绝含控制字符的路径 ${JSON.stringify(path)}`, () => {
      const plan = makeValidPlan();
      expect(() =>
        TestPlanV1.parse({
          ...plan,
          actions: [
            ...plan.actions,
            { id: "s9", type: "goto", path, effect: "READ" },
          ],
        }),
      ).toThrow(/控制字符|同源|相对路径/);
    });
  }

  it("语义确认：URL 解析器会去除 TAB 使 origin 指向其它 host", () => {
    expect(new URL("/\t/other.invalid/path", "https://approved.example").origin).toBe(
      "https://other.invalid",
    );
  });

  it("合法路径（含查询参数与中文）仍被接受", () => {
    const plan = makeValidPlan();
    expect(() =>
      TestPlanV1.parse({
        ...plan,
        actions: [
          ...plan.actions,
          { id: "s9", type: "goto", path: "/orders?status=待审批&page=2", effect: "READ" },
        ],
      }),
    ).not.toThrow();
  });
});

describe("F2：受保护语义覆盖计划断言目标与导航路径", () => {
  it("改变导航业务路径（/orders/new → /different-order）改变哈希", () => {
    const testCase = makeTestCase();
    const withPath = (path: string): PlanDraft => {
      const plan = makeValidPlan();
      return {
        ...plan,
        actions: plan.actions.map((a) => (a.type === "goto" ? { ...a, path } : a)),
      };
    };
    const h1 = computePlanAcceptanceHash({ testCase, plan: withPath("/orders/new") });
    const h2 = computePlanAcceptanceHash({ testCase, plan: withPath("/different-order") });
    expect(h1).not.toBe(h2);
  });

  it("改变计划断言 targetRef（检查另一个字段）改变哈希", () => {
    const plan = makeValidPlan();
    const testCase = makeTestCase();
    const h1 = computePlanAcceptanceHash({ testCase, plan });
    const swapped: PlanDraft = {
      ...plan,
      assertions: plan.assertions.map((a) =>
        a.id === "a1" ? { ...a, targetRef: "observed-amount" } : a,
      ),
    };
    const h2 = computePlanAcceptanceHash({ testCase, plan: swapped });
    expect(h1).not.toBe(h2);
  });

  it("改变计划断言 kind 或 stepId 改变哈希", () => {
    const plan = makeValidPlan();
    const testCase = makeTestCase();
    const h1 = computePlanAcceptanceHash({ testCase, plan });
    const changedKind: PlanDraft = {
      ...plan,
      assertions: plan.assertions.map((a) => (a.id === "a1" ? { ...a, kind: "ui.element" } : a)),
    };
    expect(computePlanAcceptanceHash({ testCase, plan: changedKind })).not.toBe(h1);
    const changedStep: PlanDraft = {
      ...plan,
      actions: [
        { id: "s6b", type: "assert", assertionId: "a1", effect: "READ" },
        ...plan.actions.filter((a) => a.id !== "s6"),
      ],
      assertions: plan.assertions.map((a) => (a.id === "a1" ? { ...a, stepId: "s6b" } : a)),
    };
    expect(computePlanAcceptanceHash({ testCase, plan: changedStep })).not.toBe(h1);
  });

  it("waitFor：业务条件值变化改变哈希，仅调超时参数不变", () => {
    const plan = makeValidPlan();
    const draft: PlanDraft = {
      ...plan,
      bindings: [
        ...plan.bindings,
        {
          targetRef: "observed-toast",
          locator: { type: "testId", value: "toast" },
          observedUrl: "http://demo.local/orders",
          observedAt: "2026-09-16T00:00:02Z",
          evidenceId: "art-observe-4",
        },
      ],
      actions: [
        ...plan.actions.slice(0, 4),
        {
          id: "s5",
          type: "waitFor",
          targetRef: "observed-toast",
          condition: { kind: "text", value: "提交成功" },
          timeoutMs: 10_000,
          pollMs: 500,
          maxAttempts: 20,
          effect: "READ",
        },
        plan.actions[4]!,
      ],
    };
    const testCase = makeTestCase();
    const h1 = computePlanAcceptanceHash({ testCase, plan: draft });
    const changedValue: PlanDraft = {
      ...draft,
      actions: draft.actions.map((a) =>
        a.id === "s5" && a.type === "waitFor"
          ? { ...a, condition: { kind: "text", value: "提交失败" } }
          : a,
      ),
    };
    expect(computePlanAcceptanceHash({ testCase, plan: changedValue })).not.toBe(h1);
    const changedTimeout: PlanDraft = {
      ...draft,
      actions: draft.actions.map((a) =>
        a.id === "s5" && a.type === "waitFor"
          ? { ...a, timeoutMs: 20_000, pollMs: 1_000, maxAttempts: 10 }
          : a,
      ),
    };
    expect(computePlanAcceptanceHash({ testCase, plan: changedTimeout })).toBe(h1);
  });

  it("仅更换定位方式（testId → text）不改变哈希", () => {
    const plan = makeValidPlan();
    const testCase = makeTestCase();
    const relocalized: PlanDraft = {
      ...plan,
      bindings: plan.bindings.map((b) =>
        b.targetRef === "observed-order-status"
          ? { ...b, locator: { type: "text", value: "状态" } }
          : b,
      ),
    };
    expect(computePlanAcceptanceHash({ testCase, plan })).toBe(
      computePlanAcceptanceHash({ testCase, plan: relocalized }),
    );
  });
});

describe("F3：可信入口校验身份、状态与类别", () => {
  it("DRAFT 用例被拒绝（不能作为批准标准）", () => {
    const plan = makeValidPlan();
    const draft = makeTestCase({ approvalStatus: "DRAFT", approvalHash: undefined });
    const result = validatePlanAgainstApprovedCase(plan, draft);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.mismatches.join()).toMatch(/APPROVED/);
  });

  it("计划 caseVersionId 指向另一版本被拒绝", () => {
    const plan = makeValidPlan();
    const other = makeTestCase({ id: "tc-order-999-v1" });
    const result = validatePlanAgainstApprovedCase(plan, other);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.mismatches.join()).toMatch(/caseVersionId/);
  });

  it("断言 kind 从 ui.text 改为 data.value 被拒绝", () => {
    const plan = makeValidPlan();
    const approved = makeTestCase();
    const mutated = TestPlanV1.parse({
      ...plan,
      assertions: [{ ...plan.assertions[0]!, kind: "data.value" }],
    });
    const result = validatePlanAgainstApprovedCase(mutated, approved);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.mismatches.join()).toMatch(/kind/);
  });

  it("计划包含用例未批准的角色（admin）被拒绝", () => {
    const plan = makeValidPlan();
    const mutated = TestPlanV1.parse({ ...plan, roles: [...plan.roles, "admin"] });
    const result = validatePlanAgainstApprovedCase(mutated, makeTestCase());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.mismatches.join()).toMatch(/角色 admin/);
  });

  it("计划引用用例未批准的规则被拒绝", () => {
    const plan = makeValidPlan();
    const mutated = TestPlanV1.parse({
      ...plan,
      ruleVersionIds: [...plan.ruleVersionIds, "rule-extra"],
      assertions: plan.assertions.map((a) => ({ ...a, ruleVersionId: "rule-extra" })),
    });
    const result = validatePlanAgainstApprovedCase(mutated, makeTestCase());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.mismatches.join()).toMatch(/规则 rule-extra/);
  });

  it("verifyStoredPlan：一致的存储计划通过并返回重算哈希", () => {
    const plan = makeValidPlan();
    const approved = makeTestCase();
    const result = verifyStoredPlan(plan, approved);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.recomputedHash).toBe(plan.acceptanceHash);
  });

  it("verifyStoredPlan：存储哈希被篡改时拒绝", () => {
    const plan = makeValidPlan();
    const approved = makeTestCase();
    const tampered = { ...plan, acceptanceHash: "f".repeat(64) };
    const result = verifyStoredPlan(tampered, approved);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join()).toMatch(/acceptanceHash 与受保护语义不符/);
  });

  it("verifyStoredPlan：schema 不合法的计划直接拒绝", () => {
    const result = verifyStoredPlan({ garbage: true }, makeTestCase());
    expect(result.ok).toBe(false);
  });
});
