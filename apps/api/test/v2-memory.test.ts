import { beforeAll, afterAll, it, expect } from "vitest";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import { createTestEnv, type TestEnv } from "./helpers/db.js";
import { registerV2MemoryRoutes } from "../src/routes-v2-memory.js";
import { registerAuth } from "../src/auth.js";
import { sendApiError } from "../src/errors.js";
import { computeOracleHash } from "@ai-qa/contracts";

/** W07 INT-04 记忆消费闭环：跨项目拒绝、过期/失效不能 used、账本可查。 */

let env: TestEnv, app: ReturnType<typeof Fastify>;
let projectId = "", otherProjectId = "", sessionId = "";
let freshMemoryId = "", expiredMemoryId = "", invalidatedMemoryId = "", crossMemoryId = "";
const H = {} as Record<string, string>;

beforeAll(async () => {
  env = await createTestEnv("v2mem");
  const user = await env.prisma.user.create({
    data: { username: randomUUID(), displayName: "lead", passwordHash: "x", platformRole: "LEAD" },
  });
  const project = await env.prisma.project.create({
    data: { name: "记忆项目", memberships: { create: { userId: user.id, role: "ADMIN" } } },
  });
  projectId = project.id;
  otherProjectId = (await env.prisma.project.create({ data: { name: "他项目" } })).id;

  const oracleHash = computeOracleHash({ projectId, ruleVersionIds: ["rv-m"], assertions: [] as never, semanticCandidates: [], coverageDeclarations: [] });
  const oracle = await env.prisma.v2OracleSpec.create({
    data: { projectId, version: 1, status: "APPROVED", ruleVersionIds: ["rv-m"], assertions: [], semanticCandidates: [], coverageDeclarations: [], oracleHash, createdBy: "t", approvedBy: "t", approvedAt: new Date() },
  });
  const environment = await env.prisma.environment.create({
    data: { projectId, name: "e", baseUrl: "http://127.0.0.1:1", allowedOrigins: [] },
  });
  sessionId = (await env.prisma.v2ExecutionSession.create({
    data: {
      projectId, goal: "g", oracleSpecId: oracle.id, oracleHash,
      profileId: "p", profileHash: "0".repeat(64), definitionId: "d", definitionVersion: 1,
      environmentId: environment.id, buildId: "b", budget: {}, usage: {},
    },
  })).id;

  const mkMemory = async (pid: string, over: Record<string, unknown> = {}) =>
    (await env.prisma.projectMemory.create({
      data: {
        projectId: pid, content: "改名入口常在详情页", source: { kind: "observation" } as never,
        validUntil: null, invalidated: false, ...over,
      } as never,
    })).id;
  freshMemoryId = await mkMemory(projectId);
  expiredMemoryId = await mkMemory(projectId, { validUntil: new Date(Date.now() - 1000) });
  invalidatedMemoryId = await mkMemory(projectId, { invalidated: true, invalidatedReason: "来源版本已过" });
  crossMemoryId = await mkMemory(otherProjectId);

  app = Fastify();
  await app.register(cookie);
  registerAuth(app, env.prisma, 600);
  app.addHook("onRequest", async (req) => {
    req.auth = { userId: user.id, username: user.username, displayName: user.displayName, platformRole: "LEAD" };
  });
  app.setErrorHandler((e, q, r) => sendApiError(q, r, e));
  registerV2MemoryRoutes(app, env.prisma);
}, 30000);

afterAll(async () => { await app?.close(); await env?.cleanup(); });

const record = (memoryRecordId: string, decision: "used" | "rejected", over: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: `/api/v2/sessions/${sessionId}/memory-usages`, headers: H, payload: { memoryRecordId, decision, reason: "复用定位习惯", ...over } as never });

it("跨项目记忆拒绝", async () => {
  const res = await record(crossMemoryId, "used");
  expect(res.statusCode).toBe(422);
  expect(res.json().message).toContain("跨项目");
});

it("过期/失效记忆不能 used；可 rejected 并留账", async () => {
  expect((await record(expiredMemoryId, "used")).statusCode).toBe(409);
  expect((await record(invalidatedMemoryId, "used")).statusCode).toBe(409);
  const rejected = await record(expiredMemoryId, "rejected", { reason: "validUntil 已过，不覆盖当前预期" });
  expect(rejected.statusCode).toBe(201);
});

it("有效记忆 used + outcome 落账；账本可查且含完整决策", async () => {
  const used = await record(freshMemoryId, "used", { outcome: "helped" });
  expect(used.statusCode).toBe(201);
  const list = await app.inject({ method: "GET", url: `/api/v2/sessions/${sessionId}/memory-usages`, headers: H });
  const usages = list.json().memoryUsages as Array<{ decision: string; outcome: string | null; reason: string }>;
  expect(usages.length).toBeGreaterThanOrEqual(2);
  expect(usages.some((u) => u.decision === "used" && u.outcome === "helped")).toBe(true);
  expect(usages.some((u) => u.decision === "rejected")).toBe(true);
});
