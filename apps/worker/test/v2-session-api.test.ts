import { beforeAll, afterAll, it, expect } from "vitest";
import Fastify from "fastify";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import { createTestEnv, type TestEnv } from "../../api/test/helpers/db.js";
import { registerV2CapabilityRoutes } from "../../api/src/routes-v2-capabilities.js";
import { registerV2SessionRoutes } from "../../api/src/routes-v2-sessions.js";
import { registerAuth } from "../../api/src/auth.js";
import { sendApiError } from "../../api/src/errors.js";
import { processAgentJob } from "../src/agent-job-processor.js";
import { WorkerConfig } from "../src/config.js";
import { registerBuiltinSamples } from "../src/v2/samples.js";
import { DraftOpsManifest } from "@ai-qa/adapter-sdk/samples/draft-ops";
import { computeOracleHash } from "@ai-qa/contracts";

/**
 * R3 最小旅程（API 层，真实 DB + 真实合成系统 + worker 作业）：
 * 创建会话（固定 Oracle/环境白名单校验）→ V2_SESSION_LOOP 作业驱动循环 →
 * 会话终态 + 详情含全阶段留痕 → 取消终态拒绝 → 幂等创建。
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
let env: TestEnv, app: ReturnType<typeof Fastify>;
let projectId = "", environmentId = "", oracleSpecId = "";
let draftPort = 0, draftBaseUrl = "";
let draftServer: ReturnType<typeof spawn>;
const H = {} as Record<string, string>;
let jobCounter = 0;
const queuedJobs: string[] = [];
const queue = { add: async (_n: string, d: { jobId: string }) => { queuedJobs.push(d.jobId); return {} as never; } };

function config() {
  return WorkerConfig.parse({
    databaseUrl: env.databaseUrl,
    redisUrl: "redis://127.0.0.1:6380/0",
    artifactDir: env.artifactDir,
    intelligenceBackend: "python",
    intelligenceUrl: "http://127.0.0.1:1",
    intelligenceToken: "unused",
    intelligenceTimeoutMs: 5000,
  });
}

beforeAll(async () => {
  env = await createTestEnv("v2api");
  const user = await env.prisma.user.create({
    data: { username: randomUUID(), displayName: "lead", passwordHash: "x", platformRole: "LEAD" },
  });
  const project = await env.prisma.project.create({
    data: { name: "会话项目", memberships: { create: { userId: user.id, role: "ADMIN" } } },
  });
  projectId = project.id;

  // 合成草稿系统。
  draftPort = 20000 + Math.floor(Math.random() * 20000);
  draftBaseUrl = `http://127.0.0.1:${draftPort}`;
  draftServer = spawn("node", [join(root, "examples/synthetic/draft-app/server.mjs"), "--port", String(draftPort)], {
    env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("draft server timeout")), 8000);
    const on = (b: Buffer) => { if (b.toString().includes("ready")) { clearTimeout(timer); resolve(); } };
    draftServer.stdout?.on("data", on);
    draftServer.stderr?.on("data", on);
  });

  const environment = await env.prisma.environment.create({
    data: { projectId, name: "synthetic", baseUrl: draftBaseUrl, allowedOrigins: [draftBaseUrl] },
  });
  environmentId = environment.id;

  // Oracle（六维声明 + 结构化映射）。
  const dims = ["normal", "boundary", "permission", "multi_role", "state", "persistence"] as const;
  const ruleVersionId = `rv-api-${randomUUID().slice(0, 8)}`;
  const assertions = [{
    id: "a-title", ruleVersionId, kind: "deterministic",
    fact: "草稿标题", observationType: "api_field", observationRef: "draft.title",
    operator: "equals", expected: "验收目标名称", precondition: null, unit: null, tolerance: null,
    allowedRoles: [], required: true,
  }];
  const coverageDeclarations = dims.map((dimension) => ({ ruleVersionId, dimension, status: "planned", reason: "api 测试" }));
  const oracleHash = computeOracleHash({ projectId, ruleVersionIds: [ruleVersionId], assertions: assertions as never, semanticCandidates: [], coverageDeclarations });
  const oracle = await env.prisma.v2OracleSpec.create({
    data: {
      projectId, version: 1, status: "APPROVED", ruleVersionIds: [ruleVersionId],
      assertions: assertions as never, semanticCandidates: [], coverageDeclarations,
      oracleHash, createdBy: "t", approvedBy: "t", approvedAt: new Date(),
    },
  });
  oracleSpecId = oracle.id;

  app = Fastify();
  await app.register(cookie);
  registerAuth(app, env.prisma, 600);
  app.addHook("onRequest", async (req) => {
    req.auth = { userId: user.id, username: user.username, displayName: user.displayName, platformRole: "LEAD" };
  });
  app.setErrorHandler((e, q, r) => sendApiError(q, r, e));
  registerV2CapabilityRoutes(app, env.prisma);
  registerV2SessionRoutes(app, env.prisma, queue);
  registerBuiltinSamples();

  // 安装+授权合成能力。
  const install = await app.inject({
    method: "POST", url: `/api/v2/projects/${projectId}/capabilities/install`, headers: H,
    payload: { manifest: JSON.parse(JSON.stringify(DraftOpsManifest)) },
  });
  await app.inject({
    method: "POST", url: `/api/v2/installations/${install.json().installationId}/authorize`, headers: H,
    payload: { scope: ["draft:ops"] },
  });
}, 40000);

afterAll(async () => {
  draftServer?.kill("SIGTERM");
  await app?.close();
  await env?.cleanup();
});

async function processQueued() {
  while (queuedJobs.length) {
    jobCounter += 1;
    const jobId = queuedJobs.shift()!;
    await processAgentJob(env.prisma, config(), jobId);
  }
}

it("创建会话：白名单外目标拒绝；合法创建入队，作业驱动循环到 COMPLETED，详情全留痕", async () => {
  const bad = await app.inject({
    method: "POST", url: `/api/v2/projects/${projectId}/sessions`, headers: H,
    payload: { goal: "闭环", oracleSpecId, environmentId, targetBaseUrl: "http://10.255.255.1:9", idempotencyKey: "idem-bad-0001" },
  });
  expect(bad.statusCode).toBe(422);
  expect(bad.json().message).toContain("白名单");

  const created = await app.inject({
    method: "POST", url: `/api/v2/projects/${projectId}/sessions`, headers: H,
    payload: { goal: "创建草稿→改名→刷新仍保留名称", oracleSpecId, environmentId, targetBaseUrl: draftBaseUrl, idempotencyKey: "idem-ok-0001" },
  });
  expect(created.statusCode).toBe(202);
  const { sessionId, jobId } = created.json();
  expect(queuedJobs).toContain(jobId);

  await processQueued();
  const job = await env.prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  expect(job.status).toBe("SUCCEEDED");
  const result = job.result as { status: string; verdict: string };
  expect(result.status).toBe("COMPLETED");
  expect(result.verdict).toBe("pass");

  const session = await env.prisma.v2ExecutionSession.findUniqueOrThrow({ where: { id: sessionId } });
  expect(session.status).toBe("COMPLETED");

  const detail = await app.inject({ method: "GET", url: `/api/v2/sessions/${sessionId}`, headers: H });
  expect(detail.statusCode).toBe(200);
  const body = detail.json();
  expect(body.attempts.length).toBeGreaterThanOrEqual(3);
  expect(body.intents.length).toBeGreaterThanOrEqual(2);
  expect(body.invocations.length).toBeGreaterThanOrEqual(2);
  expect(body.observations.length).toBeGreaterThanOrEqual(2);
  const verify = body.attempts.find((a: { phase: string }) => a.phase === "verify");
  expect(verify?.rationale).toContain("验收目标名称");

  // 资源恰好 1 个（真实合成系统计数）。
  const stats = await (await fetch(`${draftBaseUrl}/api/__danger_stats`)).json();
  expect(stats.drafts).toBe(1);
});

it("幂等创建：同参返回原会话；终态取消拒绝", async () => {
  const again = await app.inject({
    method: "POST", url: `/api/v2/projects/${projectId}/sessions`, headers: H,
    payload: { goal: "创建草稿→改名→刷新仍保留名称", oracleSpecId, environmentId, targetBaseUrl: draftBaseUrl, idempotencyKey: "idem-ok-0002" },
  });
  // 不同幂等键但同 goal → fingerprint 相同 → 返回已有会话。
  expect(again.json().existed).toBe(true);

  const sessions = await app.inject({ method: "GET", url: `/api/v2/projects/${projectId}/sessions`, headers: H });
  const list = sessions.json().sessions as Array<{ id: string; status: string }>;
  const completed = list.find((s) => s.status === "COMPLETED")!;
  const cancel = await app.inject({ method: "POST", url: `/api/v2/sessions/${completed.id}/cancel`, headers: H, payload: {} });
  expect(cancel.statusCode).toBe(409);
});
