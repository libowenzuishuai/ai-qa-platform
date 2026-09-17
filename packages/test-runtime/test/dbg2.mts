import { TestCaseVersion, TestPlanV1, computePlanAcceptanceHash } from "@ai-qa/contracts";
import { executePlan } from "../src/index.js";
import { createServer } from "node:http";
const server = createServer((req, res) => { res.writeHead(200, {"content-type":"text/html; charset=utf-8"}); res.end('<input data-testid="amount-input"><button data-testid="submit-btn">提交</button><span data-testid="message">提交成功</span><span data-testid="amount-cents">500001</span><span data-testid="order-id">PO-TEST-001</span>'); });
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const testCase = TestCaseVersion.parse({
  id: "c1", caseId: "c", version: 1, title: "t", ruleVersionIds: ["r"], roles: ["applicant"],
  dataSpec: { strategy: "create", note: "x" }, steps: [{ id: "s", role: "applicant", action: "a" }],
  assertions: [{ id: "a1", description: "d", kind: "ui.text", required: true, ruleVersionId: "r", operator: "equals", expected: "提交成功" }],
  cleanup: { strategy: "namespace" }, origin: "manual", approvalStatus: "APPROVED", approvalHash: "h",
  createdAt: "2026-09-17T00:00:00Z",
});
const draft: any = {
  schemaVersion: "1.0", caseVersionId: "c1", ruleVersionIds: ["r"], roles: ["applicant"],
  bindings: [
    { targetRef: "b-amount", locator: { type: "testId", value: "amount-input" }, observedUrl: baseUrl, observedAt: "2026-09-17T00:00:00Z", evidenceId: "e1" },
    { targetRef: "b-submit", locator: { type: "testId", value: "submit-btn" }, observedUrl: baseUrl, observedAt: "2026-09-17T00:00:00Z", evidenceId: "e2" },
    { targetRef: "b-message", locator: { type: "testId", value: "message" }, observedUrl: baseUrl, observedAt: "2026-09-17T00:00:00Z", evidenceId: "e3" },
    { targetRef: "b-cents", locator: { type: "testId", value: "amount-cents" }, observedUrl: baseUrl, observedAt: "2026-09-17T00:00:00Z", evidenceId: "e4" },
    { targetRef: "b-order-id", locator: { type: "testId", value: "order-id" }, observedUrl: baseUrl, observedAt: "2026-09-17T00:00:00Z", evidenceId: "e5" },
  ],
  actions: [
    { id: "s1", type: "switchRole", role: "applicant", effect: "READ" },
    { id: "s2", type: "goto", path: "/", effect: "READ" },
    { id: "s3", type: "fill", targetRef: "b-amount", value: { source: "literal", value: "5000.01" }, effect: "READ" },
    { id: "s4", type: "click", targetRef: "b-submit", effect: "WRITE" },
    { id: "s5", type: "captureValue", targetRef: "b-order-id", saveAs: "orderId", effect: "READ" },
    { id: "s6", type: "waitFor", targetRef: "b-message", condition: { kind: "text", value: "提交成功" }, timeoutMs: 5000, pollMs: 200, maxAttempts: 20, effect: "READ" },
    { id: "s7", type: "assert", assertionId: "a1", effect: "READ" },
  ],
  assertions: [
    { id: "a1", stepId: "s7", required: true, ruleVersionId: "r", kind: "ui.text", targetRef: "b-message", operator: "equals", expected: "提交成功" },
  ],
};
const plan = TestPlanV1.parse({ ...draft, acceptanceHash: computePlanAcceptanceHash({ testCase, plan: draft }) });
const result = await executePlan({
  plan, baseUrl, policy: { allowedOrigins: [baseUrl], dependencyOrigins: [] },
  namespace: "dbg", resolveCredential: () => undefined,
  sink: { save: async () => ({ artifactId: "a" }) },
  budget: { maxActions: 50, wallClockMs: 60000, perActionTimeoutMs: 8000 },
  shouldContinue: async () => true,
});
console.log("blocked:", JSON.stringify(result.blocked));
console.log("steps:\n  " + result.steps.map(s => `${s.stepId}:${s.status}:${s.error ?? ""}`).join("\n  "));
console.log("assertions:", JSON.stringify(result.assertions));
server.close();
