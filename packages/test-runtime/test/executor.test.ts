import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { TestCaseVersion, TestPlanV1, computePlanAcceptanceHash } from "@ai-qa/contracts";
import { checkDestination, executePlan, resolveTargetUrl } from "../src/index.js";

/**
 * 执行器单元/集成验证（真实 Chromium + 本地 HTTP 目标站）。
 * 覆盖：七动作、值解析、导航策略拦截、断言判定、取消、预算、写不确定。
 */

let server: Server;
let baseUrl: string;
const deadPort = 9; // 保留黑洞端口，用作越界目标。

const PAGE = (message: string) => `<!doctype html>
<html lang="zh-CN"><body>
  <input data-testid="amount-input" value="">
  <button data-testid="submit-btn">提交</button>
  <span data-testid="message">${message}</span>
  <span data-testid="amount-cents">500001</span>
  <span data-testid="order-id">PO-TEST-001</span>
  <span data-testid="never-visible" style="display:none">隐藏</span>
</body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/login") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><body><form><input data-testid="login-username"><input type="password" data-testid="login-password"><button data-testid="login-submit">登录</button><span data-testid="login-error" style="display:none"></span></form></body></html>`,
      );
      return;
    }
    if (url.startsWith("/redirect-away")) {
      res.writeHead(302, { location: `http://127.0.0.1:${deadPort}/evil` });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE(url.includes("fail") ? "提交失败" : "提交成功"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "object" && address) {
    baseUrl = `http://127.0.0.1:${address.port}`;
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const memorySink = () => {
  const saved: Array<{ kind: string; sensitivity: string; size: number }> = [];
  let counter = 0;
  return {
    saved,
    sink: {
      save: async (_kind: string, _filename: string, data: Buffer, opts: { sensitivity: string }) => {
        counter += 1;
        saved.push({ kind: _kind, sensitivity: opts.sensitivity, size: data.length });
        return { artifactId: `art-${counter}` };
      },
    },
  };
};

function makePlanFixture() {
  const testCase = {
    id: "tc-exec-v1",
    caseId: "tc-exec",
    version: 1,
    title: "执行器验证",
    ruleVersionIds: ["rule-1"],
    roles: ["applicant"],
    preconditions: [],
    dataSpec: { strategy: "create", note: "页面创建" },
    steps: [{ id: "st1", role: "applicant", action: "填写并提交" }],
    assertions: [
      {
        id: "a1",
        description: "提交后提示",
        kind: "ui.text",
        required: true,
        ruleVersionId: "rule-1",
        operator: "equals",
        expected: "提交成功",
      },
      {
        id: "a2",
        description: "金额（分）",
        kind: "data.value",
        required: true,
        ruleVersionId: "rule-1",
        operator: "gt",
        expected: 500000,
        unit: "fen",
      },
      {
        id: "a3",
        description: "单号存在",
        kind: "ui.element",
        required: false,
        ruleVersionId: "rule-1",
        operator: "exists",
      },
    ],
    cleanup: { strategy: "namespace" },
    origin: "manual",
    approvalStatus: "APPROVED",
    approvalHash: "placeholder",
    createdAt: "2026-09-17T00:00:00Z",
  } as const;
  const parsedCase = TestCaseVersion.parse(testCase);
  const draft = {
    schemaVersion: "1.0",
    caseVersionId: "tc-exec-v1",
    ruleVersionIds: ["rule-1"],
    roles: ["applicant"],
    bindings: [
      { targetRef: "b-amount", locator: { type: "testId", value: "amount-input" }, observedUrl: baseUrl, observedAt: "2026-09-17T00:00:00Z", evidenceId: "art-obs-1" },
      { targetRef: "b-submit", locator: { type: "testId", value: "submit-btn" }, observedUrl: baseUrl, observedAt: "2026-09-17T00:00:00Z", evidenceId: "art-obs-2" },
      { targetRef: "b-message", locator: { type: "testId", value: "message" }, observedUrl: baseUrl, observedAt: "2026-09-17T00:00:00Z", evidenceId: "art-obs-3" },
      { targetRef: "b-cents", locator: { type: "testId", value: "amount-cents" }, observedUrl: baseUrl, observedAt: "2026-09-17T00:00:00Z", evidenceId: "art-obs-4" },
      { targetRef: "b-order-id", locator: { type: "testId", value: "order-id" }, observedUrl: baseUrl, observedAt: "2026-09-17T00:00:00Z", evidenceId: "art-obs-5" },
    ],
    actions: [
      { id: "s1", type: "switchRole", role: "applicant", effect: "READ" },
      { id: "s2", type: "goto", path: "/", effect: "READ" },
      { id: "s3", type: "fill", targetRef: "b-amount", value: { source: "literal", value: "5000.01" }, effect: "READ" },
      { id: "s4", type: "click", targetRef: "b-submit", effect: "WRITE" },
      { id: "s5", type: "captureValue", targetRef: "b-order-id", saveAs: "orderId", effect: "READ" },
      { id: "s6", type: "waitFor", targetRef: "b-message", condition: { kind: "text", value: "提交成功" }, timeoutMs: 5_000, pollMs: 200, maxAttempts: 20, effect: "READ" },
      { id: "s7", type: "assert", assertionId: "a1", effect: "READ" },
      { id: "s8", type: "assert", assertionId: "a2", effect: "READ" },
      { id: "s9", type: "assert", assertionId: "a3", effect: "READ" },
    ],
    assertions: [
      { id: "a1", stepId: "s7", required: true, ruleVersionId: "rule-1", kind: "ui.text", targetRef: "b-message", operator: "equals", expected: "提交成功" },
      { id: "a2", stepId: "s8", required: true, ruleVersionId: "rule-1", kind: "data.value", targetRef: "b-cents", operator: "gt", expected: 500000, unit: "fen" },
      { id: "a3", stepId: "s9", required: false, ruleVersionId: "rule-1", kind: "ui.element", targetRef: "b-order-id", operator: "exists" },
    ],
  };
  const acceptanceHash = computePlanAcceptanceHash({ testCase: parsedCase, plan: draft as never });
  return TestPlanV1.parse({ ...draft, acceptanceHash });
}

const policy = (base: string) => ({ allowedOrigins: [base], dependencyOrigins: [] });

describe("navigation-policy", () => {
  it("checkDestination：白名单内允许、越界拒绝", () => {
    const p = { allowedOrigins: ["http://127.0.0.1:5900"], dependencyOrigins: ["http://cdn.local"] };
    expect(checkDestination("http://127.0.0.1:5900/x", p).allowed).toBe(true);
    expect(checkDestination("http://cdn.local/a.js", p).allowed).toBe(true);
    expect(checkDestination("http://127.0.0.1:5901/x", p).allowed).toBe(false);
    expect(checkDestination("http://evil.invalid/x", p).allowed).toBe(false);
    expect(checkDestination("about:blank", p).allowed).toBe(true);
  });

  it("resolveTargetUrl：模板变量替换与同源校验", () => {
    expect(resolveTargetUrl("/orders/{orderId}", "http://a.local", { orderId: "PO-1" })).toEqual({
      ok: true,
      url: "http://a.local/orders/PO-1",
    });
    expect(resolveTargetUrl("//evil.local/{x}", "http://a.local", { x: "1" }).ok).toBe(false);
    expect(() => resolveTargetUrl("/orders/{missing}", "http://a.local", {})).toThrow(/未定义/);
  });
});

describe("executor —— 真实浏览器执行", () => {
  it("健康计划：七动作全部执行，断言 PASS，产出截图与 trace 证据", async () => {
    const plan = makePlanFixture();
    const { sink, saved } = memorySink();
    const result = await executePlan({
      plan,
      baseUrl,
      policy: policy(baseUrl),
      namespace: "ns-test-1",
      resolveCredential: () => undefined,
      sink,
      budget: { maxActions: 50, wallClockMs: 60_000, perActionTimeoutMs: 8_000 },
      shouldContinue: async () => true,
    });
    expect(result.blocked).toBeUndefined();
    expect(result.steps.map((s) => s.status)).toEqual(
      expect.arrayContaining(["PASSED"]),
    );
    expect(result.steps.every((s) => s.status === "PASSED")).toBe(true);
    expect(result.vars["orderId"]).toBe("PO-TEST-001");
    const a1 = result.assertions.find((a) => a.assertionId === "a1")!;
    expect(a1.result).toBe("PASS");
    expect(a1.actual).toBe("提交成功");
    expect(a1.evidenceIds.length).toBeGreaterThan(0);
    const a2 = result.assertions.find((a) => a.assertionId === "a2")!;
    expect(a2.result).toBe("PASS");
    const a3 = result.assertions.find((a) => a.assertionId === "a3")!;
    expect(a3.result).toBe("PASS");
    // 截图（NORMAL）+ trace（RESTRICTED_RAW）
    expect(saved.some((s) => s.kind.startsWith("assert") && s.sensitivity === "NORMAL")).toBe(true);
    expect(saved.some((s) => s.kind === "TRACE" && s.sensitivity === "RESTRICTED_RAW")).toBe(true);
  }, 60_000);

  it("业务断言 FAIL：提示文本不符", async () => {
    const plan = makePlanFixture();
    plan.assertions[0]!.expected = "绝不出现的文本";
    const { sink } = memorySink();
    const result = await executePlan({
      plan,
      baseUrl: `${baseUrl}/fail-page`, // message=提交失败
      policy: policy(baseUrl),
      namespace: "ns-test-2",
      resolveCredential: () => undefined,
      sink,
      budget: { maxActions: 50, wallClockMs: 60_000, perActionTimeoutMs: 8_000 },
      shouldContinue: async () => true,
    });
    expect(result.assertions.find((a) => a.assertionId === "a1")!.result).toBe("FAIL");
    // FAIL 后继续执行（保留未执行部分）
    expect(result.assertions.find((a) => a.assertionId === "a2")!.result).toBe("PASS");
  }, 60_000);

  it("凭据缺失 → BLOCKED/AUTH", async () => {
    const plan = makePlanFixture();
    plan.actions[2] = {
      ...plan.actions[2]!,
      type: "fill",
      value: { source: "credential", ref: "applicant.password" },
    } as never;
    const { sink } = memorySink();
    const result = await executePlan({
      plan,
      baseUrl,
      policy: policy(baseUrl),
      namespace: "ns-test-3",
      resolveCredential: () => undefined,
      sink,
      budget: { maxActions: 50, wallClockMs: 60_000, perActionTimeoutMs: 8_000 },
      shouldContinue: async () => true,
    });
    expect(result.blocked?.reasonCode).toBe("AUTH");
  }, 60_000);

  it("越界导航在执行前被拒绝 → BLOCKED/ENVIRONMENT", async () => {
    const plan = makePlanFixture();
    plan.actions[1] = {
      id: "s2",
      type: "goto",
      pathTemplate: "/redirect-away",
      effect: "READ",
    } as never;
    // 模板变量无占位符即可；直接改为 path 版本更简单：
    plan.actions[1] = { id: "s2", type: "goto", path: "/redirect-away", effect: "READ" } as never;
    const { sink } = memorySink();
    const result = await executePlan({
      plan,
      baseUrl,
      policy: policy(baseUrl),
      namespace: "ns-test-4",
      resolveCredential: () => undefined,
      sink,
      budget: { maxActions: 50, wallClockMs: 60_000, perActionTimeoutMs: 8_000 },
      shouldContinue: async () => true,
    });
    // 302 → 127.0.0.1:9/evil：导航后离开白名单（或请求被拦截后 load 失败）。
    expect(result.blocked).toBeDefined();
    expect(["ENVIRONMENT"]).toContain(result.blocked?.reasonCode);
  }, 60_000);

  it("waitFor 未满足 → BLOCKED（TIME_BUDGET，等待类）", async () => {
    const plan = makePlanFixture();
    plan.actions[5] = {
      ...plan.actions[5]!,
      condition: { kind: "text", value: "永不存在" },
      timeoutMs: 1_000,
      pollMs: 200,
      maxAttempts: 4,
    } as never;
    const { sink } = memorySink();
    const result = await executePlan({
      plan,
      baseUrl,
      policy: policy(baseUrl),
      namespace: "ns-test-5",
      resolveCredential: () => undefined,
      sink,
      budget: { maxActions: 50, wallClockMs: 60_000, perActionTimeoutMs: 8_000 },
      shouldContinue: async () => true,
    });
    expect(result.blocked?.reasonCode).toBe("TIME_BUDGET");
    expect(result.blocked?.detail).toContain("waitFor 未满足");
    // 后续断言 NOT_EVALUATED
    expect(result.assertions.find((a) => a.assertionId === "a1")!.result).toBe("NOT_EVALUATED");
  }, 60_000);

  it("取消：shouldContinue=false → CANCELLED，未执行断言 NOT_EVALUATED", async () => {
    const plan = makePlanFixture();
    const { sink } = memorySink();
    let calls = 0;
    const result = await executePlan({
      plan,
      baseUrl,
      policy: policy(baseUrl),
      namespace: "ns-test-6",
      resolveCredential: () => undefined,
      sink,
      budget: { maxActions: 50, wallClockMs: 60_000, perActionTimeoutMs: 8_000 },
      shouldContinue: async () => {
        calls += 1;
        return calls <= 2; // 第 3 次检查（第 2 个动作前）取消
      },
    });
    expect(result.cancelled).toBe(true);
    expect(result.assertions.every((a) => a.result === "NOT_EVALUATED")).toBe(true);
  }, 60_000);

  it("预算耗尽 → BLOCKED/TIME_BUDGET", async () => {
    const plan = makePlanFixture();
    const { sink } = memorySink();
    const result = await executePlan({
      plan,
      baseUrl,
      policy: policy(baseUrl),
      namespace: "ns-test-7",
      resolveCredential: () => undefined,
      sink,
      budget: { maxActions: 2, wallClockMs: 60_000, perActionTimeoutMs: 8_000 },
      shouldContinue: async () => true,
    });
    expect(result.blocked?.reasonCode).toBe("TIME_BUDGET");
    expect(result.blocked?.detail).toContain("预算耗尽");
  }, 60_000);

  it("登录页启发式：目标缺失且页面呈登录表单 → AUTH", async () => {
    const plan = makePlanFixture();
    // 第一步导航到登录页后直接尝试填写不存在于登录页的目标。
    plan.actions[1] = { id: "s2", type: "goto", path: "/login", effect: "READ" } as never;
    const { sink } = memorySink();
    const result = await executePlan({
      plan,
      baseUrl,
      policy: policy(baseUrl),
      namespace: "ns-test-8",
      resolveCredential: () => undefined,
      sink,
      budget: { maxActions: 50, wallClockMs: 60_000, perActionTimeoutMs: 3_000 },
      shouldContinue: async () => true,
    });
    expect(result.blocked?.reasonCode).toBe("AUTH");
  }, 60_000);
});
