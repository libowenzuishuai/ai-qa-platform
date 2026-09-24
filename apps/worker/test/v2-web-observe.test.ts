import { beforeAll, afterAll, it, expect } from "vitest";
import Fastify from "fastify";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import cookie from "@fastify/cookie";
import { createTestEnv, type TestEnv } from "../../api/test/helpers/db.js";
import { registerV2CapabilityRoutes } from "../../api/src/routes-v2-capabilities.js";
import { registerAuth } from "../../api/src/auth.js";
import { sendApiError } from "../../api/src/errors.js";
import { invokeCapability } from "../src/v2/capability-invoker.js";
import { registerBuiltinSamples } from "../src/v2/samples.js";
import { WebObserveManifest } from "@ai-qa/adapter-sdk/samples/web-observe";
import { DraftOpsManifest } from "@ai-qa/adapter-sdk/samples/draft-ops";
import { computeManifestHash } from "@ai-qa/contracts";

/**
 * W05（EXE-01/EXE-04）真实浏览器观察 + UI/API 交叉核验：
 * - DOM（data-testid）读取 + 截图落盘（sha256）；
 * - 缺陷构建：API 响应"已改名"而页面仍显示旧标题 → 交叉核验检出（UI 假成功）。
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
let env: TestEnv, app: ReturnType<typeof Fastify>;
let projectId = "";
let draftServer: ReturnType<typeof spawn>, draftBaseUrl = "";
const H = {} as Record<string, string>;

function startDraftServer(envOverrides: Record<string, string> = {}) {
  return new Promise<{ baseUrl: string; stop(): Promise<void>; stats(): Promise<{ drafts: number }> }>((resolve) => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn("node", [join(root, "examples/synthetic/draft-app/server.mjs"), "--port", String(port)], {
      env: { ...process.env, ...envOverrides }, stdio: ["ignore", "pipe", "pipe"],
    });
    const on = (b: Buffer) => {
      if (b.toString().includes("ready")) {
        resolve({
          baseUrl: `http://127.0.0.1:${port}`,
          stop: () => new Promise<void>((r) => { child.kill("SIGTERM"); setTimeout(r, 200); }),
          stats: async () => (await (await fetch(`http://127.0.0.1:${port}/api/__danger_stats`)).json()),
        });
      }
    };
    child.stdout?.on("data", on);
    child.stderr?.on("data", on);
  });
}

beforeAll(async () => {
  env = await createTestEnv("v2webobs");
  const user = await env.prisma.user.create({
    data: { username: randomUUID(), displayName: "lead", passwordHash: "x", platformRole: "LEAD" },
  });
  const project = await env.prisma.project.create({
    data: { name: "观察项目", memberships: { create: { userId: user.id, role: "ADMIN" } } },
  });
  projectId = project.id;
  app = Fastify();
  await app.register(cookie);
  registerAuth(app, env.prisma, 600);
  app.addHook("onRequest", async (req) => {
    req.auth = { userId: user.id, username: user.username, displayName: user.displayName, platformRole: "LEAD" };
  });
  app.setErrorHandler((e, q, r) => sendApiError(q, r, e));
  registerV2CapabilityRoutes(app, env.prisma);
  registerBuiltinSamples();

  for (const manifest of [WebObserveManifest, DraftOpsManifest]) {
    const install = await app.inject({
      method: "POST", url: `/api/v2/projects/${projectId}/capabilities/install`, headers: H,
      payload: { manifest: JSON.parse(JSON.stringify(manifest)) },
    });
    expect(install.statusCode).toBe(202);
    await app.inject({
      method: "POST", url: `/api/v2/installations/${install.json().installationId}/authorize`, headers: H,
      payload: { scope: ["observe:web", "draft:ops"] },
    });
  }
}, 40000);

afterAll(async () => { await app?.close(); await env?.cleanup(); });

async function call(capabilityId: string, input: Record<string, unknown>, artifactsDir?: string) {
  return invokeCapability({
    prisma: env.prisma, projectId,
    capabilityId, capabilityVersion: "1.0.0",
    input, deadline: Date.now() + 30000,
    idempotencyKey: `obs-${randomUUID()}`,
    signal: new AbortController().signal,
    allowedOrigins: [new URL(draftBaseUrl).origin],
    invocationId: `obs-${randomUUID()}`,
    ...(artifactsDir ? {} : {}),
  });
}

it("DOM 观察：testid 文本 + 截图落盘（sha256 一致）；白名单外拒绝", async () => {
  const server = await startDraftServer();
  draftBaseUrl = server.baseUrl;
  // 准备一个草稿。
  const created = await call("synthetic.draft-ops", { op: "create", baseUrl: draftBaseUrl, title: "界面标题甲" });
  expect(created.status).toBe("SUCCEEDED");
  const draftId = (created.output as { draft: { id: string } }).draft.id;

  const observed = await call("platform.web-observe", {
    baseUrl: draftBaseUrl, path: `/ui/drafts/${draftId}`,
    testId: "draft-title", artifactsDir: env.artifactDir, observationRef: "w05-test",
  });
  expect(observed.status).toBe("SUCCEEDED");
  const out = observed.output as { text: string | null; screenshotSha256: string | null; screenshotPath: string | null };
  expect(out.text).toBe("界面标题甲");
  expect(out.screenshotPath).toBeTruthy();
  expect(existsSync(out.screenshotPath!)).toBe(true);
  const { createHash } = await import("node:crypto");
  expect(createHash("sha256").update(readFileSync(out.screenshotPath!)).digest("hex")).toBe(out.screenshotSha256);

  // 白名单外 origin。
  const bad = await call("platform.web-observe", { baseUrl: "http://10.255.255.1:9", path: "/x" });
  expect(bad.status).toBe("FAILED");
  expect(bad.error?.code).toBe("FORBIDDEN");
  await server.stop();
});

it("UI/API 交叉核验：缺陷构建改名响应成功而页面未变 → 检出不一致", async () => {
  const server = await startDraftServer({ DEFECT: "rename_no_persist" });
  draftBaseUrl = server.baseUrl;
  const created = await call("synthetic.draft-ops", { op: "create", baseUrl: draftBaseUrl, title: "旧标题" });
  const draftId = (created.output as { draft: { id: string } }).draft.id;
  // 改名：响应显示成功（defect 构建返回改名后对象）。
  const renamed = await call("synthetic.draft-ops", {
    op: "rename", baseUrl: draftBaseUrl, draftId, title: "新标题",
    renamePath: "/api/drafts/:id/rename",
  });
  expect(renamed.status).toBe("SUCCEEDED");
  expect((renamed.output as { draft: { title: string } }).draft.title).toBe("新标题"); // 响应撒谎
  // UI 观察 + API 重读都显示旧标题 → 交叉核验必检出。
  const ui = await call("platform.web-observe", { baseUrl: draftBaseUrl, path: `/ui/drafts/${draftId}` });
  const api = await call("synthetic.draft-ops", { op: "get", baseUrl: draftBaseUrl, draftId });
  const uiText = (ui.output as { text: string | null }).text;
  const apiTitle = (api.output as { draft: { title: string } }).draft.title;
  expect(uiText).toBe("旧标题");
  expect(apiTitle).toBe("旧标题");
  // 交叉核验结论：响应与实际不一致 = 业务缺陷（UI 假成功检出）。
  expect(uiText === "新标题" && apiTitle === "新标题").toBe(false);
  await server.stop();
});
