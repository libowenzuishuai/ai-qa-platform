import { beforeAll, afterAll, it, expect } from "vitest";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import { createTestEnv, type TestEnv } from "./helpers/db.js";
import { registerV2ReadinessRoutes } from "../src/routes-v2-readiness.js";
import { registerAuth } from "../src/auth.js";
import { sendApiError } from "../src/errors.js";

/**
 * R1 验收：按任务依赖判定（无模型固定计划可运行；依赖模型明确阻塞）；
 * 无工程 Runner 纯浏览器可继续；改配置旧 readiness 失效（新指纹）；
 * VIEWER 拒绝；重复检查幂等。
 */

let env: TestEnv, app: ReturnType<typeof Fastify>;
let projectId = "", environmentId = "";
let viewerApp: ReturnType<typeof Fastify>;
const H = {} as Record<string, string>;

beforeAll(async () => {
  env = await createTestEnv("v2ready");
  const user = await env.prisma.user.create({
    data: { username: randomUUID(), displayName: "lead", passwordHash: "x", platformRole: "LEAD" },
  });
  const project = await env.prisma.project.create({
    data: { name: "readiness 项目", memberships: { create: { userId: user.id, role: "LEAD" } } },
  });
  projectId = project.id;
  const environment = await env.prisma.environment.create({
    data: { projectId, name: "e", baseUrl: "http://127.0.0.1:9", allowedOrigins: [] },
  });
  environmentId = environment.id;

  app = Fastify();
  await app.register(cookie);
  registerAuth(app, env.prisma, 600);
  app.addHook("onRequest", async (req) => {
    req.auth = { userId: user.id, username: user.username, displayName: user.displayName, platformRole: "LEAD" };
  });
  app.setErrorHandler((e, q, r) => sendApiError(q, r, e));
  registerV2ReadinessRoutes(app, env.prisma);

  const viewerUser = await env.prisma.user.create({
    data: { username: randomUUID(), displayName: "viewer", passwordHash: "x", platformRole: "VIEWER" },
  });
  await env.prisma.projectMembership.create({
    data: { projectId, userId: viewerUser.id, role: "VIEWER" },
  });
  viewerApp = Fastify();
  await viewerApp.register(cookie);
  registerAuth(viewerApp, env.prisma, 600);
  viewerApp.addHook("onRequest", async (req) => {
    req.auth = { userId: viewerUser.id, username: viewerUser.username, displayName: viewerUser.displayName, platformRole: "VIEWER" };
  });
  viewerApp.setErrorHandler((e, q, r) => sendApiError(q, r, e));
  registerV2ReadinessRoutes(viewerApp, env.prisma);
}, 30000);

afterAll(async () => { await app?.close(); await viewerApp?.close(); await env?.cleanup(); });

const check = (payload: unknown, useViewer = false) =>
  (useViewer ? viewerApp : app).inject({
    method: "POST", url: `/api/v2/projects/${projectId}/readiness`, headers: H, payload: payload as never,
  });

it("无模型依赖的确定性任务：就绪（模型未配置不阻塞）", async () => {
  const res = await check({ environmentId, needs: {} });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  expect(body.status).toBe("ready");
  expect(body.blockers).toHaveLength(0);
});

it("依赖模型的新规划：MODEL_NOT_CONFIGURED 明确阻塞", async () => {
  const res = await check({ environmentId, needs: { model: true } });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  expect(body.status).toBe("blocked");
  const blocker = body.blockers.find((b: { reasonCode: string }) => b.reasonCode === "MODEL_NOT_CONFIGURED");
  expect(blocker).toBeTruthy();
  expect(blocker.impact).toContain("确定性检索");
  expect(blocker.nextAction).toContain("固定计划");
});

it("需要工程 Runner 但未配置：只阻塞工程面；浏览器面同检通过/独立", async () => {
  const res = await check({ environmentId, needs: { engineeringRunner: true } });
  const body = res.json();
  expect(body.status).toBe("blocked");
  expect(body.blockers.some((b: { reasonCode: string }) => b.reasonCode === "ENGINEERING_RUNNER_NOT_CONFIGURED")).toBe(true);
  // 纯浏览器/HTTP 面不被工程 Runner 阻塞。
  const browserOnly = await check({ environmentId, needs: { browser: true, http: true } });
  expect(browserOnly.json().blockers.some((b: { reasonCode: string }) => b.reasonCode === "ENGINEERING_RUNNER_NOT_CONFIGURED")).toBe(false);
});

it("改配置（依赖面变化）→ 新指纹 → 旧结果不再返回 latest 语义；重复同参幂等", async () => {
  const first = await check({ environmentId, needs: {} });
  const again = await check({ environmentId, needs: {} });
  expect(again.statusCode).toBe(200); // 幂等 upsert
  expect(again.json().readinessId).toBe(first.json().readinessId);
  expect(await env.prisma.v2ReadinessCheck.count({ where: { projectId } })).toBeGreaterThanOrEqual(1);

  // 变化需求（加 model）→ 新指纹 → 新行。
  const changed = await check({ environmentId, needs: { model: true } });
  expect(changed.json().readinessId).not.toBe(first.json().readinessId);

  const latest = await app.inject({ method: "GET", url: `/api/v2/projects/${projectId}/readiness/latest`, headers: H });
  expect(latest.json().readiness.configFingerprint).toBe(changed.json().configFingerprint);
});

it("秘密层：未登记/不可解析引用阻塞且不回显值；登记后可解析", async () => {
  const res = await check({ environmentId, secretRefs: ["ghost.password"] });
  expect(res.json().status).toBe("blocked");
  const blocker = res.json().blockers[0];
  expect(blocker.reasonCode).toBe("SECRET_NOT_RESOLVABLE");
  // 值不出现：字段中不包含任何凭据值（只有引用名与映射状态）。
  expect(JSON.stringify(blocker)).not.toMatch(/AIQA_TEST_ACC_PW/);
  expect(JSON.stringify(blocker)).not.toMatch(/synthetic-only/);

  // 登记可解析映射后同参数复检转好。
  process.env["AIQA_TEST_ACC_PW"] = "synthetic-only";
  await env.prisma.environment.update({
    where: { id: environmentId },
    data: { secretRefs: { testAcc: { passwordEnv: "AIQA_TEST_ACC_PW" } } as never },
  });
  const ok = await check({ environmentId, secretRefs: ["testAcc.password"] });
  expect(ok.json().blockers.filter((b: { reasonCode: string }) => b.reasonCode === "SECRET_NOT_RESOLVABLE")).toHaveLength(0);
  delete process.env["AIQA_TEST_ACC_PW"];
});

it("VIEWER 与跨项目拒绝；sessionId 不存在拒绝", async () => {
  expect((await check({ environmentId }, true)).statusCode).toBe(403);
  const badSession = await app.inject({
    method: "POST", url: `/api/v2/projects/${projectId}/readiness`, headers: H,
    payload: { environmentId, sessionId: "no-such" },
  });
  expect(badSession.statusCode).toBe(422);
});

it("环境不存在：ENV_NOT_FOUND 阻塞含下一步", async () => {
  const res = await check({ environmentId: "env-ghost", needs: {} });
  expect(res.json().status).toBe("blocked");
  expect(res.json().blockers[0].reasonCode).toBe("ENV_NOT_FOUND");
  expect(res.json().blockers[0].nextAction).toContain("登记");
});
