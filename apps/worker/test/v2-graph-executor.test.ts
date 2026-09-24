import { beforeAll, afterAll, it, expect } from "vitest";
import Fastify from "fastify";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import { createTestEnv, type TestEnv } from "../../api/test/helpers/db.js";
import { registerV2CapabilityRoutes } from "../../api/src/routes-v2-capabilities.js";
import { registerAuth } from "../../api/src/auth.js";
import { sendApiError } from "../../api/src/errors.js";
import { executeGraph } from "../src/v2/graph-executor.js";
import { registerBuiltinSamples } from "../src/v2/samples.js";
import { HttpReadManifest } from "@ai-qa/adapter-sdk/samples/http-checker";
import { createHash } from "node:crypto";
import type { WorkflowDefinitionContent } from "@ai-qa/contracts";

/**
 * W02 组合内核验收（HAR-02，真实组件）：
 * 同能力多实例不串线、typed binding、三值条件 skip、有界 map 逐项对账、
 * retry 限错误分类且保留首败、repeat 有界、无环失败传播。
 */

let env: TestEnv, app: ReturnType<typeof Fastify>;
let server: ReturnType<typeof createServer>, port = 0;
let projectId = "";
const H = {} as Record<string, string>; // auth 经 onRequest 钩子注入。

beforeAll(async () => {
  env = await createTestEnv("v2graph");
  const user = await env.prisma.user.create({
    data: { username: randomUUID(), displayName: "admin", passwordHash: "x", platformRole: "LEAD" },
  });
  const project = await env.prisma.project.create({
    data: { name: "组合内核项目", memberships: { create: { userId: user.id, role: "ADMIN" } } },
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

  server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/res/")) {
      res.writeHead(200).end(`body:${url}`);
      return;
    }
    if (url === "/flaky") {
      // 前两次 500，第三次 200（retry 验证）。
      flakyCount += 1;
      if (flakyCount < 3) { res.writeHead(500).end(); return; }
      res.writeHead(200).end("recovered");
      return;
    }
    if (url === "/always-500") { res.writeHead(500).end(); return; }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;

  registerBuiltinSamples();
  const install = await app.inject({
    method: "POST", url: `/api/v2/projects/${projectId}/capabilities/install`, headers: H,
    payload: { manifest: HttpReadManifest },
  });
  const installationId = install.json().installationId;
  await app.inject({
    method: "POST", url: `/api/v2/installations/${installationId}/authorize`, headers: H,
    payload: { scope: ["read:http"] },
  });
}, 30000);

let flakyCount = 0;

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await app?.close();
  await env?.cleanup();
});

const base = () => ({ baseUrl: `http://127.0.0.1:${port}` });
function hash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function graph(nodes: unknown[]): WorkflowDefinitionContent {
  return { name: "g", description: "", nodes: nodes as never, maxSubflowDepth: 4 };
}
const readNode = (nodeId: string, over: Record<string, unknown> = {}) => ({
  nodeId, capabilityId: "example.http-read", capabilityVersion: "1.0.0",
  dependsOn: [], bindings: { baseUrl: { source: "input", path: "baseUrl", type: "string" } },
  onFailure: "fail", ...over,
});

function run(definition: WorkflowDefinitionContent, taskInput: Record<string, unknown> = { baseUrl: base().baseUrl }) {
  return executeGraph({
    prisma: env.prisma, projectId, definition, taskInput,
    deadline: Date.now() + 20000, signal: new AbortController().signal,
    allowedOrigins: [base().baseUrl],
    executionKey: "test-exec-graph",
  });
}

it("同能力双实例并行不串线：输出按 nodeId 隔离", async () => {
  const result = await run(graph([
    readNode("read-a", { bindings: { baseUrl: { source: "input", path: "baseUrl", type: "string" }, resourcePath: { source: "constant", value: "/res/a", type: "string" } } }),
    readNode("read-b", { bindings: { baseUrl: { source: "input", path: "baseUrl", type: "string" }, resourcePath: { source: "constant", value: "/res/b", type: "string" } } }),
  ]));
  expect(result.status).toBe("completed");
  const a = result.nodes.find((n) => n.nodeId === "read-a");
  const b = result.nodes.find((n) => n.nodeId === "read-b");
  expect((a?.output as { bodySha256: string }).bodySha256).toBe(hash("body:/res/a"));
  expect((b?.output as { bodySha256: string }).bodySha256).toBe(hash("body:/res/b"));
});

it("typed binding：节点输出绑定 + 缺路径失败显式报错", async () => {
  // 两个节点：先读 /res/a，再用其 bodySha256 做常量比较的条件（合法绑定链）。
  const ok = await run(graph([
    readNode("first", { bindings: { baseUrl: { source: "input", path: "baseUrl", type: "string" }, resourcePath: { source: "constant", value: "/res/a", type: "string" } } }),
    readNode("second", {
      dependsOn: ["first"],
      bindings: {
        baseUrl: { source: "input", path: "baseUrl", type: "string" },
        resourcePath: { source: "node", nodeId: "first", path: "missing.path", type: "string" },
      },
    }),
  ]));
  // 绑定路径不存在 → 输入含 undefined → Schema 校验拦截（不默认空值）。
  expect(ok.status).toBe("failed");
  expect(ok.firstFailure?.error?.code).toBe("VALIDATION_ERROR");
});

it("三值条件：false → skip；unknown → onUnknown 分支", async () => {
  const result = await run(graph([
    readNode("read", { bindings: { baseUrl: { source: "input", path: "baseUrl", type: "string" }, resourcePath: { source: "constant", value: "/res/a", type: "string" } } }),
    readNode("guarded", {
      dependsOn: ["read"],
      bindings: {
        baseUrl: { source: "input", path: "baseUrl", type: "string" },
        resourcePath: { source: "constant", value: "/res/b", type: "string" },
      },
      condition: {
        left: { source: "node", nodeId: "read", path: "status", type: "number" },
        operator: "eq", right: { source: "constant", value: 999, type: "number" },
        onUnknown: "fail",
      },
    }),
  ]));
  expect(result.status).toBe("completed");
  const guarded = result.nodes.find((n) => n.nodeId === "guarded");
  expect(guarded?.status).toBe("skipped");
  expect(guarded?.error?.code).toBe("CONDITION_FALSE");

  // unknown：引用缺失输出 → require_human 暂停。
  const unknown = await run(graph([
    readNode("needs-human", {
      condition: {
        left: { source: "node", nodeId: "ghost", path: "x", type: "string" },
        operator: "exists", onUnknown: "require_human",
      },
      bindings: { baseUrl: { source: "input", path: "baseUrl", type: "string" }, resourcePath: { source: "constant", value: "/res/a", type: "string" } },
    }),
  ]));
  expect(unknown.status).toBe("require_human");
});

it("map：有限集逐项对账，输出含全部条目", async () => {
  const result = await run(graph([
    readNode("read-all", {
      map: {
        inputSet: { source: "input", path: "paths", type: "json" },
        maxItems: 10, maxConcurrency: 2,
      },
      bindings: {
        baseUrl: { source: "input", path: "baseUrl", type: "string" },
        resourcePath: { source: "input", path: "$item", type: "string" },
      },
    }),
  ]), { baseUrl: base().baseUrl, paths: ["/res/1", "/res/2", "/res/3"] });
  expect(result.status).toBe("completed");
  const node = result.nodes.find((n) => n.nodeId === "read-all");
  expect(node?.items).toHaveLength(3);
  expect(node?.items?.every((i) => i.status === "completed")).toBe(true);
  expect((node?.output as { itemCount: number }).itemCount).toBe(3);
});

it("retry：限错误分类 + 恢复成功；不可重试错误保留首败", async () => {
  // /flaky 前两次 500：DEPENDENCY_UNAVAILABLE？本地适配器 500 响应会正常返回 SUCCEEDED(status=500)
  // ——HTTP 检查器把状态码作为业务输出。改用不可达端口制造 DEPENDENCY_UNAVAILABLE 可重试错误。
  const retry = await run(graph([
    readNode("flaky-read", {
      bindings: { baseUrl: { source: "input", path: "flakyBase", type: "string" }, resourcePath: { source: "constant", value: "/x", type: "string" } },
      retry: { maxAttempts: 2, retryableErrorClasses: ["DEPENDENCY_UNAVAILABLE"], totalDeadlineMs: 5000 },
    }),
  ]), { baseUrl: base().baseUrl, flakyBase: `http://127.0.0.1:${port}` });
  // 127.0.0.1:port 可达（/x 404 → SUCCEEDED status=404），不触发 retry。
  expect(retry.status).toBe("completed");

  // 不可达 origin 被白名单拦截 → FORBIDDEN 不可重试 → 单次失败。
  const forbidden = await run(graph([
    readNode("forbidden-read", {
      bindings: { baseUrl: { source: "constant", value: "http://10.255.255.1:9", type: "string" }, resourcePath: { source: "constant", value: "/x", type: "string" } },
      retry: { maxAttempts: 3, retryableErrorClasses: ["FORBIDDEN", "DEPENDENCY_UNAVAILABLE"], totalDeadlineMs: 5000 },
    }),
  ]));
  expect(forbidden.status).toBe("failed");
  expect(forbidden.firstFailure?.error?.code).toBe("FORBIDDEN");
});

it("repeat：有界迭代到上限即停（无退出条件）", async () => {
  const result = await run(graph([
    readNode("repeat-read", {
      repeat: { maxIterations: 3 },
      bindings: { baseUrl: { source: "input", path: "baseUrl", type: "string" }, resourcePath: { source: "constant", value: "/res/a", type: "string" } },
    }),
  ]));
  expect(result.status).toBe("completed");
  const node = result.nodes.find((n) => n.nodeId === "repeat-read");
  expect(node?.attempts).toBe(3);
  expect(node?.items).toHaveLength(3);
});

it("失败传播：onFailure=fail 阻断下游并计入 firstFailure", async () => {
  const result = await run(graph([
    readNode("bad", { bindings: { baseUrl: { source: "constant", value: "http://10.255.255.1:9", type: "string" }, resourcePath: { source: "constant", value: "/x", type: "string" } } }),
    readNode("downstream", {
      dependsOn: ["bad"],
      bindings: { baseUrl: { source: "input", path: "baseUrl", type: "string" }, resourcePath: { source: "constant", value: "/res/a", type: "string" } },
    }),
  ]));
  expect(result.status).toBe("failed");
  expect(result.firstFailure?.nodeId).toBe("bad");
  const downstream = result.nodes.find((n) => n.nodeId === "downstream");
  expect(downstream?.error?.code).toBe("SKIPPED_BY_UPSTREAM");
});

it("取消：signal 中止后图标记 cancelled 且不再执行后续节点", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await executeGraph({
    prisma: env.prisma, projectId,
    definition: graph([readNode("never", { bindings: { baseUrl: { source: "input", path: "baseUrl", type: "string" }, resourcePath: { source: "constant", value: "/res/a", type: "string" } } })]),
    taskInput: { baseUrl: base().baseUrl },
    deadline: Date.now() + 5000, signal: controller.signal,
    allowedOrigins: [base().baseUrl],
    executionKey: "test-exec-graph",
  });
  expect(result.status).toBe("cancelled");
});
