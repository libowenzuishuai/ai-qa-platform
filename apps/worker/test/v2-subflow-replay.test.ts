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
import { computeAstHash, type WorkflowDefinitionContent } from "@ai-qa/contracts";

/**
 * W02 剩余（HAR-02/04）：子流程运行时 + dry-run + 回放。
 * - 子流程：已发布固定版本内联展开（前缀命名空间、深度上限、未发布拒绝）；
 * - dry-run：零外部调用（目标服务器 0 请求）；
 * - replay：缺记录失败不回退真实调用；有记录完整回放。
 */

let env: TestEnv, app: ReturnType<typeof Fastify>;
let server: ReturnType<typeof createServer>, port = 0, hits = 0;
let projectId = "";
const H = {} as Record<string, string>;

beforeAll(async () => {
  env = await createTestEnv("v2sub");
  const user = await env.prisma.user.create({
    data: { username: randomUUID(), displayName: "lead", passwordHash: "x", platformRole: "LEAD" },
  });
  const project = await env.prisma.project.create({
    data: { name: "子流程项目", memberships: { create: { userId: user.id, role: "ADMIN" } } },
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

  server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200).end("sub");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;

  const install = await app.inject({
    method: "POST", url: `/api/v2/projects/${projectId}/capabilities/install`, headers: H,
    payload: { manifest: HttpReadManifest },
  });
  await app.inject({
    method: "POST", url: `/api/v2/installations/${install.json().installationId}/authorize`, headers: H,
    payload: { scope: ["read:http"] },
  });
}, 30000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await app?.close();
  await env?.cleanup();
});

const readNode = (nodeId: string, over: Record<string, unknown> = {}) => ({
  nodeId, capabilityId: "example.http-read", capabilityVersion: "1.0.0",
  dependsOn: [], onFailure: "fail", bindings: {
    baseUrl: { source: "input", path: "baseUrl", type: "string" },
    resourcePath: { source: "constant", value: "/res", type: "string" },
  }, ...over,
});

const run = (definition: WorkflowDefinitionContent, over: Record<string, unknown> = {}) =>
  executeGraph({
    prisma: env.prisma, projectId, definition,
    taskInput: { baseUrl: `http://127.0.0.1:${port}` },
    deadline: Date.now() + 20000, signal: new AbortController().signal,
    allowedOrigins: [`http://127.0.0.1:${port}`], executionKey: `test-${randomUUID().slice(0, 6)}`,
    ...over,
  } as never);

it("子流程：已发布固定版本内联执行；未发布拒绝", async () => {
  // 创建并发布子流程定义（单读节点）。
  const inner = { name: "inner-read", description: "", maxSubflowDepth: 4, nodes: [readNode("read-inner")] } as never;
  const innerRow = await env.prisma.v2WorkflowDefinition.create({
    data: {
      projectId, name: "inner-read", version: 1, status: "PUBLISHED",
      content: inner, astHash: computeAstHash(inner as WorkflowDefinitionContent),
      createdBy: "t", publishedAt: new Date(),
    },
  });
  const outer = {
    name: "outer", description: "", maxSubflowDepth: 4,
    nodes: [
      readNode("pre"),
      { nodeId: "sub", capabilityId: "example.http-read", capabilityVersion: "1.0.0", dependsOn: ["pre"], bindings: {}, onFailure: "fail", subflow: { definitionId: innerRow.id, version: 1 } },
    ],
  } as never;
  const hitsBefore = hits;
  const result = await run(outer as WorkflowDefinitionContent);
  expect(result.status).toBe("completed");
  // pre + 内联 read-inner 都真实执行。
  expect(hits - hitsBefore).toBe(2);
  expect(result.nodes.some((n) => n.nodeId === "sub__read-inner")).toBe(true);

  // 未发布版本拒绝。
  await env.prisma.v2WorkflowDefinition.update({ where: { id: innerRow.id }, data: { status: "DEPRECATED" } });
  const bad = await run(outer as WorkflowDefinitionContent);
  expect(bad.status).toBe("failed");
  expect(bad.firstFailure?.error?.message).toContain("未发布");
  await env.prisma.v2WorkflowDefinition.update({ where: { id: innerRow.id }, data: { status: "PUBLISHED" } });
});

it("dry-run：零外部调用，记录将执行的能力", async () => {
  const hitsBefore = hits;
  const result = await run({ name: "dr", description: "", maxSubflowDepth: 4, nodes: [readNode("a"), readNode("b", { dependsOn: ["a"] })] } as never, { mode: "dry-run" });
  expect(result.status).toBe("completed");
  expect(hits - hitsBefore).toBe(0);
  expect((result.nodes[0]!.output as { dryRun: boolean }).dryRun).toBe(true);
  expect((result.nodes[0]!.output as { capabilityId: string }).capabilityId).toBe("example.http-read");
});

it("replay：缺记录失败零外部调用；有记录完整回放", async () => {
  // 先真实执行拿记录。
  const key = `replay-${randomUUID().slice(0, 6)}`;
  const graph = { name: "rp", description: "", maxSubflowDepth: 4, nodes: [readNode("a")] } as never;
  const real = await run(graph, {});
  expect(real.status).toBe("completed");
  const recordedOutput = real.nodes[0]!.output;

  // 缺记录：失败且 0 新请求。
  const hitsBefore = hits;
  const miss = await run(graph, { mode: "replay", executionKey: key, replayLog: {} });
  expect(miss.status).toBe("failed");
  expect(miss.firstFailure?.error?.code).toBe("REPLAY_MISS");
  expect(hits - hitsBefore).toBe(0);

  // 有记录：回放成功，输出与录制一致，仍 0 新请求。
  const replay = await run(graph, { mode: "replay", executionKey: key, replayLog: { [`${key}:a`]: recordedOutput } });
  expect(replay.status).toBe("completed");
  expect(replay.nodes[0]!.output).toEqual(recordedOutput);
  expect(hits - hitsBefore).toBe(0);
});
