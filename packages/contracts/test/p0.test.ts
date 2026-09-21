import { it, expect } from "vitest";
import {
  LoginPreparationConfig,
  HttpDataPluginDefinition,
  PrepareRequest,
  CleanupRequest,
  WorkflowRunRequest,
} from "../src/index.js";
const plugin = {
  prepare: { method: "POST", path: "/test-resources" },
  inspect: { method: "GET", path: "/test-resources/{resourceId}" },
  cleanup: {
    method: "DELETE",
    path: "/test-resources/{resourceId}",
    allow404: true,
  },
};
it.each([
  "/test-resources",
  "https://example.com/{resourceId}",
  "//example.com/{resourceId}",
  "/test/{resourceId}/..",
  "/test/{resourceId}/%2e%2e",
  "/test/{resourceId}/%252e%252e",
  "/test/{resourceId}?all=true",
])("拒绝危险清理路径 %s", (path) => {
  expect(
    HttpDataPluginDefinition.safeParse({
      ...plugin,
      cleanup: { method: "DELETE", path },
    }).success,
  ).toBe(false);
});
it.each([
  { url: "https://example.com" },
  { method: "DELETE" },
  { namespace: "all" },
  { scope: "all" },
  { script: "delete everything" },
])("参数不能覆盖操作范围 %j", (params) => {
  expect(
    PrepareRequest.safeParse({ idempotencyKey: "k", params }).success,
  ).toBe(false);
});
it("清理资源集合不能为空，HTTP 注册协议要求显式资源标识", () => {
  expect(CleanupRequest.safeParse({ resourceIds: [] }).success).toBe(false);
  expect(HttpDataPluginDefinition.parse(plugin).cleanup.allow404).toBe(true);
});
it("登录拒绝脚本和明文凭据", () => {
  const base = {
    environmentId: "env",
    role: "tester",
    credentialRef: "tester",
    successIndicator: { locator: { type: "testId", value: "welcome" } },
  };
  for (const step of [
    { type: "eval", script: "anything" },
    {
      type: "fill",
      locator: { type: "testId", value: "password" },
      value: { source: "literal", value: "secret" },
    },
  ])
    expect(
      LoginPreparationConfig.safeParse({ ...base, steps: [step] }).success,
    ).toBe(false);
});
it("工作流必须有幂等键，预算不能超上限", () => {
  const base = {
    templateVersion: "v1",
    inputs: { environmentId: "env", baselineId: "base" },
  };
  expect(WorkflowRunRequest.safeParse(base).success).toBe(false);
  expect(
    WorkflowRunRequest.safeParse({
      ...base,
      idempotencyKey: "k",
      budget: { maxWallClockMs: 999999999 },
    }).success,
  ).toBe(false);
});
