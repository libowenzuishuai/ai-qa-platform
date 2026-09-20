import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { TestCaseVersion, TestPlanV1, computePlanAcceptanceHash } from "@ai-qa/contracts";
import { executePlan } from "../src/index.js";

/**
 * 评审 R1/R6 反例（先失败后修复）：
 * - R1：真实第二站点作为越界接收端，断言其请求数为 0、凭据未被收到；
 *       覆盖 302/307/308 与多级跳转；执行器必须发出前阻断。
 * - R6：exists/notExists 与 visible/hidden 的正确语义（存在/不存在/
 *       display:none/登录态），业务缺失不得归为 NOT_EVALUATED。
 *
 * 站点 A（白名单内）与站点 B（真实监听的越界接收端）都由本测试启动。
 */

let siteA: Server;
let siteB: Server;
let aBase: string;
let bBase: string;
/** 越界接收端的完整记录（B 收到的任何请求都是违规）。 */
const bRequests: Array<{ method: string; url: string; body: string; headers: Record<string, string> }> = [];

const FAKE_USER = "fake-user-review@example.invalid";
const FAKE_SECRET = "fake-secret-DO-NOT-LEAK-9f3a";

beforeAll(async () => {
  // 站点 A：允许的目标站，含各种跳转与语义测试页面。
  siteA = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/r302") {
      res.writeHead(302, { location: `${bBase}/outside-302` });
      res.end();
      return;
    }
    if (url === "/r307") {
      res.writeHead(307, { location: `${bBase}/outside-307` });
      res.end();
      return;
    }
    if (url === "/r308") {
      res.writeHead(308, { location: `${bBase}/outside-308` });
      res.end();
      return;
    }
    if (url === "/chain") {
      res.writeHead(302, { location: `${aBase}/hop2` });
      res.end();
      return;
    }
    if (url === "/hop2") {
      res.writeHead(307, { location: `${bBase}/outside-chain` });
      res.end();
      return;
    }
    if (url === "/login-form") {
      // 表单直接提交到越界站点 B（凭据外发反例）。
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><body>
        <form method="post" action="${bBase}/steal">
          <input data-testid="login-username">
          <input type="password" data-testid="login-password">
          <button data-testid="login-submit">登录</button>
        </form>
        <span data-testid="after-login" style="display:none"></span>
      </body></html>`);
      return;
    }
    if (url === "/semantics") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><body>
        <span data-testid="present">在场</span>
        <span data-testid="hidden-el" style="display:none">隐藏元素</span>
      </body></html>`);
      return;
    }
    if (url === "/async-ok") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<span data-testid="message">处理中</span><script>setTimeout(()=>document.querySelector("span").textContent="提交成功", 300)</script>`);
      return;
    }
    if (url === "/ok") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><body><span data-testid="message">提交成功</span><span data-testid="amount-cents">1</span></body></html>`);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => siteA.listen(0, "127.0.0.1", r));
  aBase = `http://127.0.0.1:${(siteA.address() as { port: number }).port}`;

  // 站点 B：真实监听的越界接收端，记录收到的一切。
  siteB = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += String(c)));
    req.on("end", () => {
      bRequests.push({ method: req.method ?? "?", url: req.url ?? "/", body, headers: req.headers as Record<string, string> });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<span data-testid='evil-ok'>gotcha</span>");
    });
  });
  await new Promise<void>((r) => siteB.listen(0, "127.0.0.1", r));
  bBase = `http://127.0.0.1:${(siteB.address() as { port: number }).port}`;
});

afterAll(async () => {
  await Promise.all([
    new Promise<void>((r) => siteA.close(() => r())),
    new Promise<void>((r) => siteB.close(() => r())),
  ]);
});

const memorySink = () => ({
  sink: {
    save: async () => ({ artifactId: `art-${Math.random().toString(36).slice(2)}` }),
  },
});

function buildPlan(a: string, opts: {
  actions: Array<Record<string, unknown>>;
  assertions: Array<Record<string, unknown>>;
  bindings?: Array<Record<string, string>>;
}) {
  const caseDraft = {
    id: "tc-r1-v1", caseId: "tc-r1", version: 1, title: "R1/R6",
    ruleVersionIds: ["rule-r1"], roles: ["applicant"],
    dataSpec: { strategy: "create", note: "x" },
    steps: [{ id: "st1", role: "applicant", action: "a" }],
    assertions: opts.assertions.map((x) => ({
      id: String(x.id), description: String(x.id), kind: "ui.element", required: true,
      ruleVersionId: "rule-r1", operator: "exists",
    })),
    cleanup: { strategy: "namespace" }, origin: "manual", approvalStatus: "APPROVED",
    approvalHash: "placeholder", createdAt: "2026-09-17T00:00:00Z",
  };
  const parsedCase = TestCaseVersion.parse({ ...caseDraft, approvalStatus: "DRAFT", approvalHash: undefined });
  const bindings = opts.bindings ?? [
    { targetRef: "b-msg", locator: { type: "testId", value: "message" }, observedUrl: a, observedAt: "2026-09-17T00:00:00Z", evidenceId: "e1" },
    { targetRef: "b-present", locator: { type: "testId", value: "present" }, observedUrl: a, observedAt: "2026-09-17T00:00:00Z", evidenceId: "e2" },
    { targetRef: "b-ghost", locator: { type: "testId", value: "ghost" }, observedUrl: a, observedAt: "2026-09-17T00:00:00Z", evidenceId: "e3" },
    { targetRef: "b-hidden", locator: { type: "testId", value: "hidden-el" }, observedUrl: a, observedAt: "2026-09-17T00:00:00Z", evidenceId: "e4" },
    { targetRef: "b-user", locator: { type: "testId", value: "login-username" }, observedUrl: a, observedAt: "2026-09-17T00:00:00Z", evidenceId: "e5" },
    { targetRef: "b-pass", locator: { type: "testId", value: "login-password" }, observedUrl: a, observedAt: "2026-09-17T00:00:00Z", evidenceId: "e6" },
    { targetRef: "b-submit", locator: { type: "testId", value: "login-submit" }, observedUrl: a, observedAt: "2026-09-17T00:00:00Z", evidenceId: "e7" },
    { targetRef: "b-after", locator: { type: "testId", value: "after-login" }, observedUrl: a, observedAt: "2026-09-17T00:00:00Z", evidenceId: "e8" },
  ];
  const draft = {
    schemaVersion: "1.0", caseVersionId: "tc-r1-v1", ruleVersionIds: ["rule-r1"], roles: ["applicant"],
    bindings, actions: opts.actions, assertions: opts.assertions,
  };
  return TestPlanV1.parse({
    ...draft,
    acceptanceHash: computePlanAcceptanceHash({ testCase: parsedCase, plan: draft as never }),
  });
}

async function run(plan: TestPlanV1, extra: { resolveCredential?: (ref: string) => string | undefined } = {}) {
  const violations: Array<{ kind: string; url: string }> = [];
  const result = await executePlan({
    plan, baseUrl: aBase, policy: { allowedOrigins: [aBase], dependencyOrigins: [] },
    namespace: "ns-r1", resolveCredential: extra.resolveCredential ?? (() => undefined),
    sink: memorySink().sink,
    budget: { maxActions: 50, wallClockMs: 60_000, perActionTimeoutMs: 4_000 },
    shouldContinue: async () => true,
    events: { onViolation: (v) => { violations.push(v); } },
  });
  return { result, violations };
}

describe("R1：发出前阻断越界请求（真实第二接收站）", () => {
  it("302 跳转到 B：B 收到 0 个请求，执行被阻断并记录违规", async () => {
    const before = bRequests.length;
    const plan = buildPlan(aBase, {
      actions: [
        { id: "s1", type: "switchRole", role: "applicant", effect: "READ" },
        { id: "s2", type: "goto", path: "/r302", effect: "READ" },
        { id: "s3", type: "assert", assertionId: "a1", effect: "READ" },
      ],
      assertions: [{ id: "a1", stepId: "s3", required: true, ruleVersionId: "rule-r1", kind: "ui.element", targetRef: "b-msg", operator: "exists" }],
    });
    const { result, violations } = await run(plan);
    expect(bRequests.length - before).toBe(0);
    expect(result.blocked?.reasonCode).toBe("ENVIRONMENT");
    expect(violations.length).toBeGreaterThan(0);
  }, 60_000);

  it("307 与 308 跳转到 B：B 收到 0 个请求", async () => {
    const before = bRequests.length;
    for (const path of ["/r307", "/r308"]) {
      const plan = buildPlan(aBase, {
        actions: [
          { id: "s1", type: "switchRole", role: "applicant", effect: "READ" },
          { id: "s2", type: "goto", path, effect: "READ" },
          { id: "s3", type: "assert", assertionId: "a1", effect: "READ" },
        ],
        assertions: [{ id: "a1", stepId: "s3", required: true, ruleVersionId: "rule-r1", kind: "ui.element", targetRef: "b-msg", operator: "exists" }],
      });
      await run(plan);
    }
    expect(bRequests.length - before).toBe(0);
  }, 60_000);

  it("多级跳转（A→302→A→307→B）：B 收到 0 个请求", async () => {
    const before = bRequests.length;
    const plan = buildPlan(aBase, {
      actions: [
        { id: "s1", type: "switchRole", role: "applicant", effect: "READ" },
        { id: "s2", type: "goto", path: "/chain", effect: "READ" },
        { id: "s3", type: "assert", assertionId: "a1", effect: "READ" },
      ],
      assertions: [{ id: "a1", stepId: "s3", required: true, ruleVersionId: "rule-r1", kind: "ui.element", targetRef: "b-msg", operator: "exists" }],
    });
    await run(plan);
    expect(bRequests.length - before).toBe(0);
  }, 60_000);

  it("凭据外发：表单提交到 B —— B 收到 0 请求、0 凭据", async () => {
    const before = bRequests.length;
    const plan = buildPlan(aBase, {
      actions: [
        { id: "s1", type: "switchRole", role: "applicant", effect: "READ" },
        { id: "s2", type: "goto", path: "/login-form", effect: "READ" },
        { id: "s3", type: "fill", targetRef: "b-user", value: { source: "literal", value: FAKE_USER }, effect: "READ" },
        { id: "s4", type: "fill", targetRef: "b-pass", value: { source: "credential", ref: "applicant.password" }, effect: "READ" },
        { id: "s5", type: "click", targetRef: "b-submit", effect: "WRITE" },
        { id: "s6", type: "waitFor", targetRef: "b-after", condition: { kind: "visible" }, timeoutMs: 2_000, pollMs: 200, maxAttempts: 8, effect: "READ" },
        { id: "s7", type: "assert", assertionId: "a1", effect: "READ" },
      ],
      assertions: [{ id: "a1", stepId: "s7", required: true, ruleVersionId: "rule-r1", kind: "ui.element", targetRef: "b-after", operator: "exists" }],
    });
    const { result } = await run(plan, { resolveCredential: (ref) => ref === "applicant.password" ? FAKE_SECRET : undefined });
    // 结局可以是阻断或断言失败，但越界站不得收到任何请求。
    expect(result.blocked || result.assertions.some((x) => x.result !== "PASS")).toBeTruthy();
    expect(bRequests.length - before).toBe(0);
    const leaked = bRequests.slice(before).find(
      (r) => r.body.includes(FAKE_USER) || r.body.includes(FAKE_SECRET) || JSON.stringify(r.headers).includes(FAKE_SECRET),
    );
    expect(leaked).toBeUndefined();
  }, 60_000);
});

describe("R6：存在性/可见性语义（真实页面）", () => {
  const base = () => [
    { id: "s1", type: "switchRole", role: "applicant", effect: "READ" },
    { id: "s2", type: "goto", path: "/semantics", effect: "READ" },
  ];

  it("exists：目标存在 → PASS", async () => {
    const plan = buildPlan(aBase, {
      actions: [...base(), { id: "s3", type: "assert", assertionId: "a1", effect: "READ" }],
      assertions: [{ id: "a1", stepId: "s3", required: true, ruleVersionId: "rule-r1", kind: "ui.element", targetRef: "b-present", operator: "exists" }],
    });
    const { result } = await run(plan);
    expect(result.assertions[0]!.result).toBe("PASS");
  }, 60_000);

  it("exists：目标不存在 → FAIL（业务缺失，不是 NOT_EVALUATED）", async () => {
    const plan = buildPlan(aBase, {
      actions: [...base(), { id: "s3", type: "assert", assertionId: "a1", effect: "READ" }],
      assertions: [{ id: "a1", stepId: "s3", required: true, ruleVersionId: "rule-r1", kind: "ui.element", targetRef: "b-ghost", operator: "exists" }],
    });
    const { result } = await run(plan);
    expect(result.assertions[0]!.result).toBe("FAIL");
  }, 60_000);

  it("notExists：目标不存在 → PASS", async () => {
    const plan = buildPlan(aBase, {
      actions: [...base(), { id: "s3", type: "assert", assertionId: "a1", effect: "READ" }],
      assertions: [{ id: "a1", stepId: "s3", required: true, ruleVersionId: "rule-r1", kind: "ui.element", targetRef: "b-ghost", operator: "notExists" }],
    });
    const { result } = await run(plan);
    expect(result.assertions[0]!.result).toBe("PASS");
  }, 60_000);

  it("notExists：目标存在 → FAIL", async () => {
    const plan = buildPlan(aBase, {
      actions: [...base(), { id: "s3", type: "assert", assertionId: "a1", effect: "READ" }],
      assertions: [{ id: "a1", stepId: "s3", required: true, ruleVersionId: "rule-r1", kind: "ui.element", targetRef: "b-present", operator: "notExists" }],
    });
    const { result } = await run(plan);
    expect(result.assertions[0]!.result).toBe("FAIL");
  }, 60_000);

  it("waitFor visible：display:none 不算可见（不得立即 PASSED）", async () => {
    const plan = buildPlan(aBase, {
      actions: [
        ...base(),
        { id: "s3", type: "waitFor", targetRef: "b-hidden", condition: { kind: "visible" }, timeoutMs: 1_500, pollMs: 200, maxAttempts: 6, effect: "READ" },
        { id: "s4", type: "assert", assertionId: "a1", effect: "READ" },
      ],
      assertions: [{ id: "a1", stepId: "s4", required: true, ruleVersionId: "rule-r1", kind: "ui.element", targetRef: "b-present", operator: "exists" }],
    });
    const { result } = await run(plan);
    expect(result.blocked?.reasonCode).toBe("TIME_BUDGET");
    expect(result.blocked?.detail).toContain("waitFor");
  }, 60_000);

  it("waitFor hidden：display:none 属于隐藏（应满足）", async () => {
    const plan = buildPlan(aBase, {
      actions: [
        ...base(),
        { id: "s3", type: "waitFor", targetRef: "b-hidden", condition: { kind: "hidden" }, timeoutMs: 2_000, pollMs: 200, maxAttempts: 8, effect: "READ" },
        { id: "s4", type: "assert", assertionId: "a1", effect: "READ" },
      ],
      assertions: [{ id: "a1", stepId: "s4", required: true, ruleVersionId: "rule-r1", kind: "ui.element", targetRef: "b-present", operator: "exists" }],
    });
    const { result } = await run(plan);
    expect(result.blocked).toBeUndefined();
    expect(result.steps.find((s) => s.stepId === "s3")?.status).toBe("PASSED");
  }, 60_000);
});

describe("独立复查：鉴权缺失与硬时间上限", () => {
  it("登录页上业务元素缺失不能让 notExists 假通过", async () => {
    const plan = buildPlan(aBase, {
      actions: [
        { id: "s1", type: "switchRole", role: "applicant", effect: "READ" },
        { id: "s2", type: "goto", path: "/login-form", effect: "READ" },
        { id: "s3", type: "assert", assertionId: "a1", effect: "READ" },
      ],
      assertions: [{ id: "a1", stepId: "s3", required: true, ruleVersionId: "rule-r1", kind: "ui.element", targetRef: "b-ghost", operator: "notExists" }],
    });
    const { result } = await run(plan);
    expect(result.assertions[0]!.result).toBe("NOT_EVALUATED");
    expect(result.blocked?.reasonCode).toBe("AUTH");
  });

  it("goto 响应挂起时也必须被总预算打断", async () => {
    const slow = createServer((_req, res) => {
      const timer = setTimeout(() => res.end("late"), 5_000);
      res.on("close", () => clearTimeout(timer));
    });
    await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(slow.address() as { port: number }).port}`;
    try {
      const plan = buildPlan(base, {
        actions: [
          { id: "s1", type: "switchRole", role: "applicant", effect: "READ" },
          { id: "s2", type: "goto", path: "/", effect: "READ" },
          { id: "s3", type: "assert", assertionId: "a1", effect: "READ" },
        ],
        assertions: [{ id: "a1", stepId: "s3", required: true, ruleVersionId: "rule-r1", kind: "ui.element", targetRef: "b-ghost", operator: "notExists" }],
      });
      const started = Date.now();
      const result = await executePlan({ plan, baseUrl: base,
        policy: { allowedOrigins: [base], dependencyOrigins: [] }, namespace: "deadline-review",
        resolveCredential: () => undefined, shouldContinue: async () => true, sink: memorySink().sink,
        budget: { maxActions: 10, wallClockMs: 1_000, perActionTimeoutMs: 10_000 },
      });
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(result.blocked?.reasonCode).toBe("TIME_BUDGET");
      expect(result.assertions[0]!.result).toBe("NOT_EVALUATED");
    } finally {
      slow.closeAllConnections();
      await new Promise<void>((r) => slow.close(() => r()));
    }
  }, 15_000);
});

describe('有界断言读取，不用业务条件阻塞执行',()=>{
  it.each([['提交成功','PASS'],['错误结果','FAIL']] as const)('结果 %s → %s',async(expected,verdict)=>{
    const plan=buildPlan(aBase,{actions:[
      {id:'role',type:'switchRole',role:'applicant',effect:'READ'},
      {id:'open',type:'goto',path:'/async-ok',effect:'READ'},
      {id:'check',type:'assert',assertionId:'a1',effect:'READ'},
    ],assertions:[{id:'a1',stepId:'check',required:true,ruleVersionId:'rule-r1',kind:'ui.text',targetRef:'b-msg',operator:'equals',expected,timeoutMs:700}]});
    const {result}=await run(plan);expect(result.blocked).toBeUndefined();expect(result.assertions[0]?.result).toBe(verdict);
  },10000);
});
