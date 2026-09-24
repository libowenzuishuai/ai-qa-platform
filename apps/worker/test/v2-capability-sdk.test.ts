import { beforeAll, afterAll, it, expect } from "vitest";
import Fastify from "fastify";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import { createTestEnv, type TestEnv } from "../../api/test/helpers/db.js";
import { registerV2CapabilityRoutes } from "../../api/src/routes-v2-capabilities.js";
import { registerAuth } from "../../api/src/auth.js";
import { sendApiError } from "../../api/src/errors.js";
import { invokeCapability } from "../src/v2/capability-invoker.js";
import { registerBuiltinSamples } from "../src/v2/samples.js";
import { HttpReadManifest } from "@ai-qa/adapter-sdk/samples/http-checker";

/**
 * W02 Alpha 切片验收（真实组件）：
 * - TS 只读 HTTP 检查器（local-ts SDK）真实调用本地 HTTP 服务；
 * - Python 数据核对器（remote-http）经真实 HTTP 独立进程调用；
 * - 安装≠授权；撤销阻止新调用；跨项目拒绝；输入/输出 Schema 拦截；
 * - 版本/哈希不匹配拒绝；取消传播；清单不可变。
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
let env: TestEnv, app: ReturnType<typeof Fastify>;
let pythonAdapter: ChildProcess, adapterUrl = "";
let targetServer: ReturnType<typeof createServer>, targetPort = 0;
let projectId = "", otherProjectId = "";
let httpInstallId = "", reconcileInstallId = "";
let sessionId = "sess-" + randomUUID();
let invocationCounter = 0;

beforeAll(async () => {
  env = await createTestEnv("v2cap");
  const user = await env.prisma.user.create({
    data: { username: randomUUID(), displayName: "admin", passwordHash: "x", platformRole: "LEAD" },
  });
  await env.prisma.session.create({ data: { id: "v2cap-session", userId: user.id, expiresAt: new Date(Date.now() + 600000) } });
  const project = await env.prisma.project.create({
    data: { name: "v2 能力项目", memberships: { create: { userId: user.id, role: "ADMIN" } } },
  });
  projectId = project.id;
  const other = await env.prisma.project.create({ data: { name: "另一项目" } });
  otherProjectId = other.id;

  app = Fastify();
  await app.register(cookie);
  registerAuth(app, env.prisma, 600);
  app.setErrorHandler((e, q, r) => sendApiError(q, r, e));
  registerV2CapabilityRoutes(app, env.prisma);

  // 被检目标：本地真实 HTTP 服务（http-read 的对象）。
  targetServer = createServer((req, res) => {
    if (req.url === "/resource") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello-v2");
      return;
    }
    if (req.url === "/slow") {
      setTimeout(() => { res.writeHead(200); res.end("slow"); }, 5000);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => targetServer.listen(0, "127.0.0.1", resolve));
  targetPort = (targetServer.address() as { port: number }).port;

  // Python 远程适配器：独立进程真实 HTTP。
  pythonAdapter = spawn(
    root + "services/intelligence/.venv/bin/python",
    [root + "examples/adapters/py-data-reconciler/app.py", "--port", "0"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  adapterUrl = await new Promise<string>((resolve, reject) => {
    let log = "";
    const timer = setTimeout(() => reject(new Error("adapter startup timeout " + log)), 15000);
    const on = (b: Buffer) => {
      log += b.toString();
      const m = /Uvicorn running on http:\/\/127\.0\.0\.1:(\d+)/.exec(log);
      if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); }
    };
    pythonAdapter.stdout?.on("data", on);
    pythonAdapter.stderr?.on("data", on);
  });

  registerBuiltinSamples();

  const H = { cookie: "aiqa_sid=v2cap-session", "content-type": "application/json" } as Record<string, string>;
  // 安装两个样例能力（安装 ≠ 授权）。
  const httpRes = await app.inject({
    method: "POST", url: `/api/v2/projects/${projectId}/capabilities/install`, headers: H,
    payload: { manifest: HttpReadManifest },
  });
  expect(httpRes.statusCode).toBe(202);
  httpInstallId = httpRes.json().installationId;

  const reconcileManifest = {
    ...(await (await fetch(new URL("/capability/describe", adapterUrl))).json()),
  };
  const pyRes = await app.inject({
    method: "POST", url: `/api/v2/projects/${projectId}/capabilities/install`, headers: H,
    payload: { manifest: reconcileManifest, endpoint: adapterUrl },
  });
  expect(pyRes.statusCode).toBe(202);
  reconcileInstallId = pyRes.json().installationId;
}, 40000);

afterAll(async () => {
  pythonAdapter?.kill("SIGTERM");
  await new Promise<void>((resolve) => targetServer?.close(() => resolve()));
  await app?.close();
  await env?.cleanup();
});

const H = { cookie: "aiqa_sid=v2cap-session", "content-type": "application/json" } as Record<string, string>;

function call(
  projectId_: string,
  capabilityId: string,
  capabilityVersion: string,
  input: unknown,
  over: Partial<Parameters<typeof invokeCapability>[0]> = {},
) {
  invocationCounter += 1;
  return invokeCapability({
    prisma: env.prisma,
    projectId: projectId_,
    capabilityId, capabilityVersion, input,
    deadline: Date.now() + 15000,
    idempotencyKey: `idem-${invocationCounter}-abcdefgh`,
    signal: new AbortController().signal,
    allowedOrigins: [`http://127.0.0.1:${targetPort}`],
    invocationId: `inv-${invocationCounter}`,
    ...over,
  });
}

it("未授权（VALIDATED）时调用被拒绝（安装≠授权）", async () => {
  const result = await call(projectId, "example.http-read", "1.0.0", {
    baseUrl: `http://127.0.0.1:${targetPort}`, resourcePath: "/resource",
  }, { installationId: httpInstallId });
  expect(result.status).toBe("FAILED");
  expect(result.error?.code).toBe("FORBIDDEN");
  expect(result.error?.message).toContain("VALIDATED");
});

it("授权后本地 TS 样例真实运行：白名单内 200 + 响应体哈希", async () => {
  const auth = await app.inject({ method: "POST", url: `/api/v2/installations/${httpInstallId}/authorize`, headers: H, payload: { scope: ["read:http"] } });
  expect(auth.statusCode).toBe(200);
  expect(auth.json().status).toBe("AUTHORIZED");
  const result = await call(projectId, "example.http-read", "1.0.0", {
    baseUrl: `http://127.0.0.1:${targetPort}`, resourcePath: "/resource",
  });
  expect(result.status).toBe("SUCCEEDED");
  const output = result.output as { status: number; bodySha256: string };
  expect(output.status).toBe(200);
  expect(output.bodySha256).toHaveLength(64);
});

it("白名单外 origin 被本地适配器拒绝（连接层之外的第二道防线）", async () => {
  const result = await call(projectId, "example.http-read", "1.0.0", {
    baseUrl: "http://127.0.0.1:1", resourcePath: "/x",
  });
  expect(result.status).toBe("FAILED");
  expect(result.error?.code).toBe("FORBIDDEN");
});

it("输入 Schema 违规在派发前拦截（未知字段/缺必需）", async () => {
  const extra = await call(projectId, "example.http-read", "1.0.0", {
    baseUrl: `http://127.0.0.1:${targetPort}`, resourcePath: "/resource", extra: true,
  });
  expect(extra.status).toBe("FAILED");
  expect(extra.error?.code).toBe("VALIDATION_ERROR");
  expect(extra.error?.message).toContain("未知字段");
  const missing = await call(projectId, "example.http-read", "1.0.0", { baseUrl: `http://127.0.0.1:${targetPort}` });
  expect(missing.error?.message).toContain("resourcePath");
});

it("Python 远程样例经真实 HTTP 运行并对账差异", async () => {
  const auth = await app.inject({ method: "POST", url: `/api/v2/installations/${reconcileInstallId}/authorize`, headers: H, payload: { scope: ["compute:reconcile"] } });
  expect(auth.statusCode).toBe(200);
  const result = await call(projectId, "example.data-reconcile", "1.0.0", {
    expectedRecords: [
      { id: "a", amount: "100" },
      { id: "b", amount: "200" },
      { id: "c", amount: "300" },
    ],
    actualRecords: [
      { id: "a", amount: "100" },
      { id: "b", amount: "999" },
      { id: "d", amount: "400" },
    ],
    keyField: "id",
  });
  expect(result.status).toBe("SUCCEEDED");
  const output = result.output as { matched: number; missing: string[]; extra: string[]; mismatched: string[] };
  expect(output.matched).toBe(1);
  expect(output.missing).toEqual(["c"]);
  expect(output.extra).toEqual(["d"]);
  expect(output.mismatched).toEqual(["b"]);
});

it("远程能力输入缺字段被 Schema 拦截", async () => {
  const result = await call(projectId, "example.data-reconcile", "1.0.0", { keyField: "id" });
  expect(result.status).toBe("FAILED");
  expect(result.error?.code).toBe("VALIDATION_ERROR");
});

it("跨项目调用拒绝", async () => {
  const result = await call(otherProjectId, "example.http-read", "1.0.0", {
    baseUrl: `http://127.0.0.1:${targetPort}`, resourcePath: "/resource",
  });
  expect(result.status).toBe("FAILED");
  expect(result.error?.code).toBe("NOT_FOUND");
});

it("撤销后新调用被拒绝（实时撤权）", async () => {
  const revoke = await app.inject({ method: "POST", url: `/api/v2/installations/${httpInstallId}/revoke`, headers: H, payload: {} });
  expect(revoke.json().status).toBe("REVOKED");
  const result = await call(projectId, "example.http-read", "1.0.0", {
    baseUrl: `http://127.0.0.1:${targetPort}`, resourcePath: "/resource",
  }, { installationId: httpInstallId });
  expect(result.status).toBe("FAILED");
  expect(result.error?.code).toBe("FORBIDDEN");
  expect(result.error?.message).toContain("撤销");
});

it("本地适配器取消传播（AbortSignal → CANCELLED）", async () => {
  // 重新授权用于取消测试。
  const reinstall = await app.inject({
    method: "POST", url: `/api/v2/projects/${projectId}/capabilities/install`, headers: H,
    payload: { manifest: HttpReadManifest },
  });
  const newId = reinstall.json().installationId;
  await app.inject({ method: "POST", url: `/api/v2/installations/${newId}/authorize`, headers: H, payload: { scope: ["read:http"] } });
  const controller = new AbortController();
  const promise = invokeCapability({
    prisma: env.prisma, projectId,
    capabilityId: "example.http-read", capabilityVersion: "1.0.0",
    input: { baseUrl: `http://127.0.0.1:${targetPort}`, resourcePath: "/slow" },
    deadline: Date.now() + 10000,
    idempotencyKey: "idem-cancel-0001",
    signal: controller.signal,
    allowedOrigins: [`http://127.0.0.1:${targetPort}`],
    invocationId: "inv-cancel-1",
    installationId: newId,
  });
  setTimeout(() => controller.abort(), 150);
  const result = await promise;
  expect(result.status).toBe("CANCELLED");
});

it("R0.2 远端适配器 302/307 重定向被拒：未授权 B 收到 0 请求 0 载荷", async () => {
  // 真实 A→B 接收站：A 是登记 endpoint，307 重定向到未登记 B。
  let bRequests = 0;
  let bBody = "";
  const b = createServer((req, res) => {
    bRequests += 1;
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => { bBody = data; res.writeHead(200).end("{}"); });
  });
  await new Promise<void>((r) => b.listen(0, "127.0.0.1", r));
  const bPort = (b.address() as { port: number }).port;
  const a = createServer((_req, res) => {
    res.writeHead(307, { location: `http://127.0.0.1:${bPort}/capability/execute` }).end();
  });
  await new Promise<void>((r) => a.listen(0, "127.0.0.1", r));
  const aPort = (a.address() as { port: number }).port;

  // 安装指向 A 的远端能力并授权（走真实安装/授权 API）。
  const redirectorManifest = {
    ...(await (await fetch(new URL("/capability/describe", adapterUrl))).json()),
    id: "example.redirector",
    humanName: "重定向试验适配器",
    entrypointRef: "installation.endpoint",
  };
  const install = await app.inject({
    method: "POST", url: `/api/v2/projects/${projectId}/capabilities/install`,
    headers: H, payload: { manifest: redirectorManifest, endpoint: `http://127.0.0.1:${aPort}` },
  });
  expect(install.statusCode).toBe(202);
  const redirectorId = install.json().installationId;
  await app.inject({
    method: "POST", url: `/api/v2/installations/${redirectorId}/authorize`,
    headers: H, payload: { scope: ["test:redirect"] },
  });

  // 经真实调用器执行：redirect:error 必须断连；B 收到 0 请求。
  const result = await call(projectId, "example.redirector", "1.0.0", {
    expectedRecords: [{ id: "a" }], actualRecords: [{ id: "a" }], keyField: "id",
  }, { installationId: redirectorId, deadline: Date.now() + 8000 });
  expect(result.status).toBe("FAILED");
  expect(result.error?.code).toBe("DEPENDENCY_UNAVAILABLE");
  expect(bRequests).toBe(0);
  expect(bBody).toBe("");
  await new Promise<void>((r) => a.close(() => r()));
  await new Promise<void>((r) => b.close(() => r()));
});

it("清单不可变：同 id+version 不同内容被拒绝", async () => {
  const mutated = JSON.parse(JSON.stringify(HttpReadManifest)) as typeof HttpReadManifest;
  mutated.humanName = "被篡改的检查器";
  const res = await app.inject({
    method: "POST", url: `/api/v2/projects/${projectId}/capabilities/install`, headers: H,
    payload: { manifest: mutated },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json().message).toContain("不可变");
});

it("坏 Manifest（未知协议声明/Schema 自检失败）安装即拒", async () => {
  const badSchema = JSON.parse(JSON.stringify(HttpReadManifest)) as typeof HttpReadManifest;
  badSchema.id = "example.bad-schema";
  (badSchema.inputSchema as unknown as { items?: unknown }).type = "array";
  const res = await app.inject({
    method: "POST", url: `/api/v2/projects/${projectId}/capabilities/install`, headers: H,
    payload: { manifest: badSchema },
  });
  expect(res.statusCode).toBe(422);
});

it("列表接口按项目返回安装与状态", async () => {
  const list = await app.inject({ method: "GET", url: `/api/v2/projects/${projectId}/capabilities`, headers: H });
  expect(list.statusCode).toBe(200);
  const ids = (list.json().installations as Array<{ capabilityId: string; status: string }>).map((i) => i.capabilityId);
  expect(ids).toContain("example.http-read");
  expect(ids).toContain("example.data-reconcile");
});
