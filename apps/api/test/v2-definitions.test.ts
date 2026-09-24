import { beforeAll, afterAll, it, expect } from "vitest";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import { createTestEnv, type TestEnv } from "./helpers/db.js";
import { registerV2DefinitionRoutes } from "../src/routes-v2-definitions.js";
import { registerAuth } from "../src/auth.js";
import { sendApiError } from "../src/errors.js";

/** W06（HAR-05）：定义 CRUD——AST 权威、静态校验门、发布不可变。 */

let env: TestEnv, app: ReturnType<typeof Fastify>;
let projectId = "";
const H = {} as Record<string, string>;

const node = (nodeId: string, over: Record<string, unknown> = {}) => ({
  nodeId, capabilityId: "example.http-read", capabilityVersion: "1.0.0",
  dependsOn: [], bindings: {}, onFailure: "fail", ...over,
});

beforeAll(async () => {
  env = await createTestEnv("v2def");
  const user = await env.prisma.user.create({
    data: { username: randomUUID(), displayName: "lead", passwordHash: "x", platformRole: "LEAD" },
  });
  const project = await env.prisma.project.create({
    data: { name: "定义项目", memberships: { create: { userId: user.id, role: "ADMIN" } } },
  });
  projectId = project.id;
  app = Fastify();
  await app.register(cookie);
  registerAuth(app, env.prisma, 600);
  app.addHook("onRequest", async (req) => {
    req.auth = { userId: user.id, username: user.username, displayName: user.displayName, platformRole: "LEAD" };
  });
  app.setErrorHandler((e, q, r) => sendApiError(q, r, e));
  registerV2DefinitionRoutes(app, env.prisma);
}, 30000);

afterAll(async () => { await app?.close(); await env?.cleanup(); });

const create = (nodes: unknown[], name = "canvas-flow") =>
  app.inject({ method: "POST", url: `/api/v2/projects/${projectId}/definitions`, headers: H, payload: { name, description: "", nodes, maxSubflowDepth: 4 } as never });

it("静态校验门：环拒绝且不保存；合法图保存为 DRAFT", async () => {
  const cycle = await create([node("a", { dependsOn: ["b"] }), node("b", { dependsOn: ["a"] })]);
  expect(cycle.statusCode).toBe(422);
  expect(JSON.stringify(cycle.json())).toContain("环");
  expect(await env.prisma.v2WorkflowDefinition.count()).toBe(0); // 未保存

  const ok = await create([node("a"), node("b", { dependsOn: ["a"] })]);
  expect(ok.statusCode).toBe(202);
  expect(ok.json().status).toBe("DRAFT");
});

it("AST 幂等：同内容重复创建返回原定义；改内容升版本", async () => {
  const first = await create([node("a")], "idem-flow");
  const again = await create([node("a")], "idem-flow");
  expect(again.json().existed).toBe(true);
  expect(again.json().definitionId).toBe(first.json().definitionId);
  const changed = await create([node("a"), node("c", { dependsOn: ["a"] })], "idem-flow");
  expect(changed.json().version).toBe(first.json().version + 1);
});

it("发布：幂等；篡改内容哈希后拒绝发布", async () => {
  const created = await create([node("a")], "pub-flow");
  const id = created.json().definitionId;
  const pub1 = await app.inject({ method: "POST", url: `/api/v2/definitions/${id}/publish`, headers: H, payload: {} });
  expect(pub1.json().status).toBe("PUBLISHED");
  const pub2 = await app.inject({ method: "POST", url: `/api/v2/definitions/${id}/publish`, headers: H, payload: {} });
  expect(pub2.json().status).toBe("PUBLISHED"); // 幂等

  // 篡改内容（哈希不一致）→ 拒绝。
  const row = await env.prisma.v2WorkflowDefinition.findUniqueOrThrow({ where: { id } });
  const content = row.content as { nodes: unknown[] };
  content.nodes.push(node("tampered"));
  await env.prisma.v2WorkflowDefinition.update({ where: { id }, data: { content: content as never, status: "DRAFT" } });
  const bad = await app.inject({ method: "POST", url: `/api/v2/definitions/${id}/publish`, headers: H, payload: {} });
  expect(bad.statusCode).toBe(409);
});
