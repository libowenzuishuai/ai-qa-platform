import { beforeAll, afterAll, it, expect } from "vitest";
import Fastify from "fastify";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import { createTestEnv, type TestEnv } from "../../api/test/helpers/db.js";
import { registerV2SessionRoutes } from "../../api/src/routes-v2-sessions.js";
import { registerV2CapabilityRoutes } from "../../api/src/routes-v2-capabilities.js";
import { registerAuth } from "../../api/src/auth.js";
import { sendApiError } from "../../api/src/errors.js";
import { processAgentJob } from "../../worker/src/agent-job-processor.js";
import { WorkerConfig } from "../../worker/src/config.js";
import { registerBuiltinSamples } from "../../worker/src/v2/samples.js";
import { DraftOpsManifest } from "@ai-qa/adapter-sdk/samples/draft-ops";
import { computeOracleHash } from "@ai-qa/contracts";
import { registerV2Pages } from "../src/v2-pages.js";
import { api, API_BASE } from "../src/api.js";

/**
 * R3 最小旅程（真实浏览器面之下的一层：真实 API + SSR 页面）：
 * 会话页列表/创建/详情/取消按钮状态全部由 API 真实数据驱动。
 * 页面以 in-process API + 页面路由联合验证（浏览器截图验收列入 R4 清单）。
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
let env: TestEnv, apiApp: ReturnType<typeof Fastify>, webApp: ReturnType<typeof Fastify>;
let projectId = "", environmentId = "", oracleSpecId = "";
let draftPort = 0, draftBaseUrl = "";
let draftServer: ReturnType<typeof spawn>;
const H = {} as Record<string, string>;
let webSid = "web-v2-pages-session";
const queuedJobs: string[] = [];
const queue = { add: async (_n: string, d: { jobId: string }) => { queuedJobs.push(d.jobId); return {} as never; } };

// 页面直接 in-process 调 API（避免跨进程）：改 API_BASE 指向本地实例。
process.env.API_BASE_URL = "";

beforeAll(async () => {
  env = await createTestEnv("v2web");
  const user = await env.prisma.user.create({
    data: { username: randomUUID(), displayName: "lead", passwordHash: "x", platformRole: "LEAD" },
  });
  await env.prisma.session.create({ data: { id: webSid, userId: user.id, expiresAt: new Date(Date.now() + 600000) } });
  const project = await env.prisma.project.create({
    data: { name: "页面项目", memberships: { create: { userId: user.id, role: "ADMIN" } } },
  });
  projectId = project.id;

  draftPort = 20000 + Math.floor(Math.random() * 20000);
  draftBaseUrl = `http://127.0.0.1:${draftPort}`;
  draftServer = spawn("node", [join(root, "examples/synthetic/draft-app/server.mjs"), "--port", String(draftPort)], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("draft timeout")), 8000);
    const on = (b: Buffer) => { if (b.toString().includes("ready")) { clearTimeout(timer); resolve(); } };
    draftServer.stdout?.on("data", on);
    draftServer.stderr?.on("data", on);
  });

  const environment = await env.prisma.environment.create({
    data: { projectId, name: "synthetic", baseUrl: draftBaseUrl, allowedOrigins: [draftBaseUrl] },
  });
  environmentId = environment.id;

  const dims = ["normal", "boundary", "permission", "multi_role", "state", "persistence"] as const;
  const ruleVersionId = `rv-web-${randomUUID().slice(0, 6)}`;
  const assertions = [{
    id: "a-title", ruleVersionId, kind: "deterministic",
    fact: "草稿标题", observationType: "api_field", observationRef: "draft.title",
    operator: "equals", expected: "验收目标名称", precondition: null, unit: null, tolerance: null,
    allowedRoles: [], required: true,
  }];
  const coverageDeclarations = dims.map((dimension) => ({ ruleVersionId, dimension, status: "planned", reason: "web 测试" }));
  const oracleHash = computeOracleHash({ projectId, ruleVersionIds: [ruleVersionId], assertions: assertions as never, semanticCandidates: [], coverageDeclarations });
  const oracle = await env.prisma.v2OracleSpec.create({
    data: {
      projectId, version: 1, status: "APPROVED", ruleVersionIds: [ruleVersionId],
      assertions: assertions as never, semanticCandidates: [], coverageDeclarations,
      oracleHash, createdBy: "t", approvedBy: "t", approvedAt: new Date(),
    },
  });
  oracleSpecId = oracle.id;

  apiApp = Fastify();
  await apiApp.register(cookie);
  registerAuth(apiApp, env.prisma, 600);
  apiApp.addHook("onRequest", async (req) => {
    req.auth = { userId: user.id, username: user.username, displayName: user.displayName, platformRole: "LEAD" };
  });
  apiApp.setErrorHandler((e, q, r) => sendApiError(q, r, e));
  registerV2CapabilityRoutes(apiApp, env.prisma);
  registerV2SessionRoutes(apiApp, env.prisma, queue);
  const apiUrl = await apiApp.listen({ host: "127.0.0.1", port: 0 });
  process.env.API_BASE_URL = apiUrl;

  webApp = Fastify();
  await webApp.register(cookie);
  registerV2Pages(webApp);
  registerBuiltinSamples();

  const install = await apiApp.inject({
    method: "POST", url: `/api/v2/projects/${projectId}/capabilities/install`, headers: H,
    payload: { manifest: JSON.parse(JSON.stringify(DraftOpsManifest)) },
  });
  await apiApp.inject({
    method: "POST", url: `/api/v2/installations/${install.json().installationId}/authorize`, headers: H,
    payload: { scope: ["draft:ops"] },
  });
}, 40000);

afterAll(async () => {
  delete process.env.API_BASE_URL;
  draftServer?.kill("SIGTERM");
  await webApp?.close();
  await apiApp?.close();
  await env?.cleanup();
});

function config() {
  return WorkerConfig.parse({
    databaseUrl: env.databaseUrl, redisUrl: "redis://127.0.0.1:6380/0",
    artifactDir: env.artifactDir, intelligenceBackend: "python",
    intelligenceUrl: "http://127.0.0.1:1", intelligenceToken: "x", intelligenceTimeoutMs: 5000,
  });
}

it("会话列表页：空态真实；创建表单提交后出现会话并驱动作业到完成；详情页展示阶段与账本", async () => {
  const cookie = { cookie: `web_sid=${webSid}` };
  // 空态。
  const empty = await webApp.inject({ method: "GET", url: `/space/${projectId}/autonomous`, headers: cookie });
  expect(empty.statusCode).toBe(200);
  expect(empty.body).toContain("尚无会话");

  // 表单创建（页面路径 → API → 作业 → 循环完成）。
  const created = await webApp.inject({
    method: "POST", url: `/space/${projectId}/autonomous`, headers: cookie,
    payload: {
      goal: "创建草稿→改名→刷新仍保留名称",
      environmentId, targetBaseUrl: draftBaseUrl, oracleSpecId,
    } as never,
  });
  expect(created.statusCode).toBe(302);
  while (queuedJobs.length) await processAgentJob(env.prisma, config(), queuedJobs.shift()!);

  const list = await webApp.inject({ method: "GET", url: `/space/${projectId}/autonomous`, headers: cookie });
  expect(list.body).toContain("COMPLETED");
  expect(list.body).not.toContain("尚无会话");

  // 详情：真实阶段与账本。
  const sessions = await env.prisma.v2ExecutionSession.findMany({ where: { projectId } });
  const detail = await webApp.inject({ method: "GET", url: `/v2/sessions/${sessions[0]!.id}`, headers: cookie });
  expect(detail.statusCode).toBe(200);
  expect(detail.body).toContain("循环阶段");
  expect(detail.body).toContain("验证");
  expect(detail.body).toContain("调用账本");
  expect(detail.body).toContain("目标达成"); // 结束原因（真实 terminationReason）
  // 终态：不出现取消按钮。
  expect(detail.body).not.toContain("取消会话");

  // 未登录重定向。
  expect((await webApp.inject({ method: "GET", url: `/space/${projectId}/autonomous` })).statusCode).toBe(302);
});
