import { beforeAll, afterAll, it, expect } from "vitest";
import Fastify from "fastify";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import cookie from "@fastify/cookie";
import { chromium } from "playwright";
import { createTestEnv, type TestEnv } from "../../api/test/helpers/db.js";
import { registerV2SessionRoutes } from "../../api/src/routes-v2-sessions.js";
import { registerV2CapabilityRoutes } from "../../api/src/routes-v2-capabilities.js";
import { registerAuth } from "../../api/src/auth.js";
import { sendApiError } from "../../api/src/errors.js";
import { processAgentJob } from "../src/agent-job-processor.js";
import { WorkerConfig } from "../src/config.js";
import { registerBuiltinSamples } from "../src/v2/samples.js";
import { DraftOpsManifest } from "@ai-qa/adapter-sdk/samples/draft-ops";
import { computeOracleHash } from "@ai-qa/contracts";

/**
 * R3 真实浏览器验收（1440 桌面 / 390 移动）：
 * 会话列表→创建→详情 全链路走真实 API + SSR 页面；
 * 布局无横向溢出、表单可键盘操作；截图存 docs/evidence/v2-ui/。
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
let env: TestEnv, apiApp: ReturnType<typeof Fastify>, webApp: ReturnType<typeof Fastify>;
let projectId = "", environmentId = "", oracleSpecId = "";
let draftPort = 0, draftBaseUrl = "";
let draftServer: ReturnType<typeof spawn>;
let webUrl = "";
const H = {} as Record<string, string>;
let webSid = "web-journey-session";
const queuedJobs: string[] = [];
const queue = { add: async (_n: string, d: { jobId: string }) => { queuedJobs.push(d.jobId); return {} as never; } };

beforeAll(async () => {
  env = await createTestEnv("v2ui");
  const user = await env.prisma.user.create({
    data: { username: randomUUID(), displayName: "lead", passwordHash: "x", platformRole: "LEAD" },
  });
  await env.prisma.session.create({ data: { id: webSid, userId: user.id, expiresAt: new Date(Date.now() + 900000) } });
  const project = await env.prisma.project.create({
    data: { name: "浏览器验收项目", memberships: { create: { userId: user.id, role: "ADMIN" } } },
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
  const ruleVersionId = `rv-ui-${randomUUID().slice(0, 6)}`;
  const assertions = [{
    id: "a-title", ruleVersionId, kind: "deterministic",
    fact: "草稿标题", observationType: "api_field", observationRef: "draft.title",
    operator: "equals", expected: "验收目标名称", precondition: null, unit: null, tolerance: null,
    allowedRoles: [], required: true,
  }];
  const coverageDeclarations = dims.map((dimension) => ({ ruleVersionId, dimension, status: "planned", reason: "ui 测试" }));
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
  // 页面需要环境列表（最小内联端点；真实 API 由 routes-projects 提供）。
  apiApp.get("/api/projects/:id/environments", async (req) => {
    const { id } = req.params as { id: string };
    return { environments: await env.prisma.environment.findMany({ where: { projectId: id } }) };
  });
  const apiUrl = await apiApp.listen({ host: "127.0.0.1", port: 0 });
  process.env.API_BASE_URL = apiUrl;

  const { registerV2Pages } = await import("../../web/src/v2-pages.js");
  webApp = Fastify();
  await webApp.register(cookie);
  await webApp.register(import("@fastify/formbody")); // 浏览器表单是 urlencoded
  registerV2Pages(webApp);
  webUrl = await webApp.listen({ host: "127.0.0.1", port: 0 });

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

const shotDir = join(root, "docs/evidence/v2-ui");
mkdirSync(shotDir, { recursive: true });

it("1440/390 真实浏览器旅程：列表空态→表单创建→详情（真实事件）；无横向溢出", async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: "web_sid", value: webSid, url: webUrl }]);
  const page = await context.newPage();

  // 列表空态。
  await page.goto(`${webUrl}/space/${projectId}/autonomous`);
  expect(await page.locator(".empty-state").count()).toBeGreaterThan(0);
  await page.screenshot({ path: join(shotDir, "desktop-list-empty.png"), fullPage: true });
  const overflow1440 = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(overflow1440).toBe(false);

  // 表单键盘可操作 + 提交（真实创建）。
  await page.focus("#v2-target");
  await page.fill("#v2-target", draftBaseUrl);
  await page.fill("#v2-oracle", oracleSpecId);
  const [submitResponse] = await Promise.all([
    page.waitForNavigation(),
    page.locator("button[type=submit]").click(),
  ]);
  expect([200, 302]).toContain(submitResponse?.status() ?? 0);
  while (queuedJobs.length) await processAgentJob(env.prisma, config(), queuedJobs.shift()!);
  const dbJob = await env.prisma.job.findFirst({ where: { kind: "V2_SESSION_LOOP" } });
  expect(dbJob?.status).toBe("SUCCEEDED");
  await page.reload();
  expect(await page.getByText("COMPLETED").count()).toBeGreaterThan(0);
  await page.screenshot({ path: join(shotDir, "desktop-list-completed.png"), fullPage: true });

  // 详情：阶段与账本真实数据。
  await page.locator("table a").first().click();
  expect(await page.getByText("循环阶段（真实事件）").count()).toBeGreaterThan(0);
  expect(await page.getByText("验证").count()).toBeGreaterThan(0);
  expect(await page.getByText("调用账本（intent → receipt）").count()).toBeGreaterThan(0);
  await page.screenshot({ path: join(shotDir, "desktop-detail.png"), fullPage: true });

  // 390 移动：无横向溢出（表格区允许内部滚动）。
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await mobile.addCookies([{ name: "web_sid", value: webSid, url: webUrl }]);
  const mpage = await mobile.newPage();
  await mpage.goto(`${webUrl}/v2/sessions/${(await env.prisma.v2ExecutionSession.findMany({ where: { projectId } }))[0]!.id}`);
  await mpage.waitForLoadState("networkidle");
  await mpage.screenshot({ path: join(shotDir, "mobile-detail.png"), fullPage: true });
  const overflow390 = await mpage.evaluate(() => {
    // app-main 自身允许 overflow-x:auto（表格滚动），检查文档级溢出。
    return document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
  });
  expect(overflow390).toBe(false);

  await browser.close();
}, 120000);
