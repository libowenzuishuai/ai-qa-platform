import { beforeAll, afterAll, it, expect } from "vitest";
import Fastify from "fastify";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import { createTestEnv, type TestEnv } from "../../api/test/helpers/db.js";
import { registerV2CapabilityRoutes } from "../../api/src/routes-v2-capabilities.js";
import { registerAuth } from "../../api/src/auth.js";
import { sendApiError } from "../../api/src/errors.js";
import { runDraftSessionLoop } from "../src/v2/session-loop.js";
import { registerBuiltinSamples } from "../src/v2/samples.js";
import { DraftOpsManifest } from "@ai-qa/adapter-sdk/samples/draft-ops";
import { computeOracleHash, computeManifestHash } from "@ai-qa/contracts";

/**
 * W04 最小闭环（真实组件；synthetic 显式标记）：
 * - 正常构建：创建→改名→刷新核验 PASS；资源恰好 1 个；
 * - 缺陷构建（改名不落库）：业务 FAIL 不自修复（三次等价无进展出口）；
 * - 运行中定位变化（rename→title）：重新观察后选新入口，PASS，标准不变；
 * - 写后回执前 SIGKILL 真实 worker 子进程：重启恢复按幂等键对账，资源仍 1 个。
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
let env: TestEnv, app: ReturnType<typeof Fastify>;
let projectId = "", environmentId = "";
let sessionCounter = 0;

interface DraftServer {
  process: ChildProcess;
  port: number;
  baseUrl: string;
  stop(): Promise<void>;
  stats(): Promise<{ drafts: number; renameRequests: number }>;
  reset(): Promise<void>;
}

async function startDraftServer(envOverrides: Record<string, string> = {}): Promise<DraftServer> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn("node", [join(root, "examples/synthetic/draft-app/server.mjs"), "--port", String(port)], {
    env: { ...process.env, ...envOverrides },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("draft server timeout")), 8000);
    const on = (b: Buffer) => {
      if (b.toString().includes("ready")) { clearTimeout(timer); resolve(); }
    };
    child.stdout?.on("data", on);
    child.stderr?.on("data", on);
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    process: child, port, baseUrl,
    stop: () => new Promise<void>((r) => { child.kill("SIGTERM"); setTimeout(r, 200); }),
    stats: async () => (await (await fetch(`${baseUrl}/api/__danger_stats`)).json()),
    reset: async () => { await fetch(`${baseUrl}/api/__danger_reset`, { method: "POST" }); },
  };
}

beforeAll(async () => {
  env = await createTestEnv("v2loop");
  const user = await env.prisma.user.create({
    data: { username: randomUUID(), displayName: "lead", passwordHash: "x", platformRole: "LEAD" },
  });
  const project = await env.prisma.project.create({
    data: { name: "循环项目", memberships: { create: { userId: user.id, role: "ADMIN" } } },
  });
  projectId = project.id;
  const environment = await env.prisma.environment.create({
    data: { projectId, name: "synthetic", baseUrl: "http://127.0.0.1:1", allowedOrigins: [] },
  });
  environmentId = environment.id;

  app = Fastify();
  await app.register(cookie);
  registerAuth(app, env.prisma, 600);
  app.addHook("onRequest", async (req) => {
    req.auth = { userId: user.id, username: user.username, displayName: user.displayName, platformRole: "LEAD" };
  });
  app.setErrorHandler((e, q, r) => sendApiError(q, r, e));
  registerV2CapabilityRoutes(app, env.prisma);
  registerBuiltinSamples();

  // 安装+授权 synthetic.draft-ops。
  const install = await app.inject({
    method: "POST", url: `/api/v2/projects/${projectId}/capabilities/install`, headers: {},
    payload: { manifest: JSON.parse(JSON.stringify(DraftOpsManifest)) },
  });
  expect(install.statusCode).toBe(202);
  await app.inject({
    method: "POST", url: `/api/v2/installations/${install.json().installationId}`, headers: {},
    // authorize 端点
  }).catch(() => undefined);
  await app.inject({
    method: "POST", url: `/api/v2/installations/${install.json().installationId}/authorize`, headers: {},
    payload: { scope: ["draft:ops"] },
  });
}, 40000);

afterAll(async () => { await app?.close(); await env?.cleanup(); });

const TARGET_TITLE = "验收目标名称";

/** 建一个带 Oracle 的会话（每次场景独立）。 */
async function createSession(): Promise<string> {
  sessionCounter += 1;
  const assertions = [{
    id: "a-draft-title-1", ruleVersionId: `rv-synthetic-${sessionCounter}`, kind: "deterministic",
    fact: "草稿标题", observationType: "api_field", observationRef: "draft.title",
    operator: "equals", expected: TARGET_TITLE, precondition: null, unit: null, tolerance: null,
    allowedRoles: [], required: true,
  }];
  const dims = ["normal", "boundary", "permission", "multi_role", "state", "persistence"] as const;
  const coverageDeclarations = dims.map((dimension) => ({
    ruleVersionId: assertions[0]!.ruleVersionId, dimension,
    status: "planned" as const, reason: "合成循环初始声明",
  }));
  const oracleHash = computeOracleHash({
    projectId, ruleVersionIds: [assertions[0]!.ruleVersionId],
    assertions: assertions as never, semanticCandidates: [], coverageDeclarations,
  });
  const oracle = await env.prisma.v2OracleSpec.create({
    data: {
      projectId, version: sessionCounter, status: "APPROVED",
      ruleVersionIds: [assertions[0]!.ruleVersionId], assertions: assertions as never,
      semanticCandidates: [], coverageDeclarations,
      oracleHash, createdBy: "test", approvedBy: "test", approvedAt: new Date(),
    },
  });
  const session = await env.prisma.v2ExecutionSession.create({
    data: {
      projectId, goal: "创建草稿→改名→刷新仍保留名称",
      oracleSpecId: oracle.id, oracleHash,
      profileId: "profile-script", profileHash: "0".repeat(64),
      definitionId: "def-draft-loop", definitionVersion: 1,
      environmentId, buildId: "synthetic",
      budget: { maxWallClockMs: 120000, maxActiveMs: 120000, maxModelCalls: 0, maxTokens: 0, maxToolCalls: 100, maxResources: 5, maxCostMicros: null },
      usage: {},
    },
  });
  return session.id;
}

it("正常构建：PASS，资源恰好 1 个，观察/计划/执行/验证全留痕", async () => {
  const server = await startDraftServer();
  const sessionId = await createSession();
  const result = await runDraftSessionLoop({
    prisma: env.prisma, sessionId, baseUrl: server.baseUrl, planner: "script",
  });
  expect(result.status).toBe("COMPLETED");
  expect(result.verdict).toBe("pass");
  expect(result.finalTitle).toBe(TARGET_TITLE);
  const stats = await server.stats();
  expect(stats.drafts).toBe(1);
  // 留痕：观察 + 阶段记录 + intent/invocation。
  expect(await env.prisma.v2Observation.count({ where: { sessionId } })).toBeGreaterThanOrEqual(2);
  expect(await env.prisma.v2ActionIntent.count({ where: { sessionId } })).toBeGreaterThanOrEqual(2);
  expect(await env.prisma.v2Invocation.count({ where: { intentId: { in: (await env.prisma.v2ActionIntent.findMany({ where: { sessionId } })).map((i) => i.id) } } })).toBeGreaterThanOrEqual(2);
  await server.stop();
});

it("缺陷构建（改名不落库）：业务 FAIL 不自修复，三次等价无进展出口", async () => {
  const server = await startDraftServer({ DEFECT: "rename_no_persist" });
  const sessionId = await createSession();
  const result = await runDraftSessionLoop({
    prisma: env.prisma, sessionId, baseUrl: server.baseUrl, planner: "script", maxRounds: 12,
  });
  expect(result.status).toBe("FAILED");
  expect(result.verdict).toBe("fail");
  expect(result.reason).toContain("不自修复");
  // 缺陷语义：服务端资源只有 1 个（重试改名不新建资源）。
  expect((await server.stats()).drafts).toBe(1);
  await server.stop();
});

it("运行中定位变化（rename→title 入口切换）：重新观察选新入口后 PASS，oracleHash 不变", async () => {
  // SWITCH_AFTER=1：第一次 rename 走旧入口，之后切到 /title。
  const server = await startDraftServer({ SWITCH_AFTER: "1" });
  const sessionId = await createSession();
  const sessionBefore = await env.prisma.v2ExecutionSession.findUniqueOrThrow({ where: { id: sessionId } });
  const result = await runDraftSessionLoop({
    prisma: env.prisma, sessionId, baseUrl: server.baseUrl, planner: "script", maxRounds: 12,
  });
  expect(result.status).toBe("COMPLETED");
  expect(result.verdict).toBe("pass");
  // 标准未变。
  const sessionAfter = await env.prisma.v2ExecutionSession.findUniqueOrThrow({ where: { id: sessionId } });
  expect(sessionAfter.oracleHash).toBe(sessionBefore.oracleHash);
  // 确实发生了入口切换与自适应记录。
  const adapt = await env.prisma.v2StepAttempt.findFirst({ where: { sessionId, phase: "adapt" } });
  expect(adapt?.rationale).toContain("定位");
  await server.stop();
});

it("写后回执前 SIGKILL 真实子进程：重启恢复对账，资源仍 1 个，最终 PASS", async () => {
  const server = await startDraftServer();
  const sessionId = await createSession();
  const marker = join(tmpdir(), `loop-kill-${randomUUID()}.marker`);

  // 子进程跑循环（真实进程），在写后回执前写标记并挂起。
  const childScript = `
    process.env.DATABASE_URL = ${JSON.stringify(env.databaseUrl)};
    const { PrismaClient } = require("@prisma/client");
    import("tsx").then(() => {});
  `;
  void childScript;
  const childScriptFile = join(root, "apps/worker/test", `.tmp-loop-child-${randomUUID()}.mts`); // 仓库内：模块可解析
  const { writeFileSync: wf } = await import("node:fs");
  wf(childScriptFile, `
    import { runDraftSessionLoop } from ${JSON.stringify(join(root, "apps/worker/src/v2/session-loop.ts"))};
    import { registerBuiltinSamples } from ${JSON.stringify(join(root, "apps/worker/src/v2/samples.ts"))};
    import { PrismaClient } from "@prisma/client";
    registerBuiltinSamples();
    const prisma = new PrismaClient({ datasources: { db: { url: ${JSON.stringify(env.databaseUrl)} } } });
    const r = await runDraftSessionLoop({
      prisma, sessionId: ${JSON.stringify(sessionId)}, baseUrl: ${JSON.stringify(server.baseUrl)},
      planner: "script", killAt: "after_write_before_receipt", killMarkerFile: ${JSON.stringify(marker)},
    }).catch((e) => { console.error("LOOP-ERR", e?.message, e?.code); process.exit(1); });
    console.error("LOOP-RESULT", JSON.stringify(r));
  `);
  const child = spawn(join(root, "apps/worker/node_modules/.bin/tsx"), [childScriptFile], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });

  // 等标记出现（写已发生）→ SIGKILL 真实进程。
  const deadline = Date.now() + 30000;
  let childExited: number | null = null;
  child.on("exit", (code) => { childExited = code; });
  while (!existsSync(marker) && Date.now() < deadline && childExited === null) {
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(existsSync(marker)).toBe(true);
  child.kill("SIGKILL");
  await new Promise<void>((r) => { if (childExited !== null) r(); else child.on("exit", () => r()); });
  // 子进程死亡：写已发生（服务端资源 ≥1），回执未落库。
  const statsAfterKill = await server.stats();
  expect(statsAfterKill.drafts).toBeGreaterThanOrEqual(1);
  const intentsWithoutReceipt = await countPendingIntents(sessionId);
  expect(intentsWithoutReceipt).toBeGreaterThanOrEqual(1);

  // 重启恢复（新进程语义 = 测试内重入循环）：对账 + 继续到 PASS。
  const result = await runDraftSessionLoop({
    prisma: env.prisma, sessionId, baseUrl: server.baseUrl, planner: "script",
  });
  expect(result.status).toBe("COMPLETED");
  expect(result.verdict).toBe("pass");
  // 关键验收：资源仍只有 1 个（幂等键对账，不重复创建）。
  expect((await server.stats()).drafts).toBe(1);
  rmSync(marker, { force: true });
  rmSync(childScriptFile, { force: true });
  await server.stop();

  async function countPendingIntents(sid: string): Promise<number> {
    const intents = await env.prisma.v2ActionIntent.findMany({ where: { sessionId: sid } });
    const receipts = new Set((await env.prisma.v2Invocation.findMany()).map((i) => i.intentId));
    return intents.filter((i) => !receipts.has(i.id)).length;
  }
}, 60000);

it("轮次上限（预算）耗尽有界停止；未支持规划器显式拒绝", async () => {
  const server = await startDraftServer();
  const sessionId = await createSession();
  // 用不可达标题制造持续失败？正常系统会改名成功——直接用极小轮次让它有界停止：
  // 圆 1 只能 create。maxRounds=1 → NO/FAIL 出口（轮次上限）。
  const result = await runDraftSessionLoop({
    prisma: env.prisma, sessionId, baseUrl: server.baseUrl, planner: "script", maxRounds: 1,
  });
  expect(["FAILED", "NO_PROGRESS"]).toContain(result.status);
  await expect(runDraftSessionLoop({
    prisma: env.prisma, sessionId: await createSession(), baseUrl: server.baseUrl,
    planner: "python-real" as never,
  })).rejects.toMatchObject({ message: expect.stringContaining("script") });
  await server.stop();
});
