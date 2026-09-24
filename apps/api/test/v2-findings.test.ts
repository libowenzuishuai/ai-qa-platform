import { beforeAll, afterAll, it, expect } from "vitest";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import { createTestEnv, type TestEnv } from "./helpers/db.js";
import { registerV2FindingRoutes } from "../src/routes-v2-findings.js";
import { registerAuth } from "../src/auth.js";
import { sendApiError } from "../src/errors.js";

/** W07 INT-01～03：候选证据门、去重、降级保护、假设分栏。 */

let env: TestEnv, app: ReturnType<typeof Fastify>;
let projectId = "";
const H = {} as Record<string, string>;

const createBody = (over: Record<string, unknown> = {}) => ({
  status: "candidate",
  expected: "刷新后名称保留", actual: "刷新后名称丢失",
  firstFailure: { sessionId: null, attemptId: null, runId: null, evidenceIds: [], observedAt: "2026-09-24T00:00:00Z" },
  hypotheses: [], minimalReproduction: null, severity: null,
  dedupeKey: `dedupe-${randomUUID().slice(0, 8)}`, buildId: "b1", role: "applicant",
  ...over,
});

beforeAll(async () => {
  env = await createTestEnv("v2find");
  const user = await env.prisma.user.create({
    data: { username: randomUUID(), displayName: "lead", passwordHash: "x", platformRole: "LEAD" },
  });
  const project = await env.prisma.project.create({
    data: { name: "Finding 项目", memberships: { create: { userId: user.id, role: "ADMIN" } } },
  });
  projectId = project.id;
  app = Fastify();
  await app.register(cookie);
  registerAuth(app, env.prisma, 600);
  app.addHook("onRequest", async (req) => {
    req.auth = { userId: user.id, username: user.username, displayName: user.displayName, platformRole: "LEAD" };
  });
  app.setErrorHandler((e, q, r) => sendApiError(q, r, e));
  registerV2FindingRoutes(app, env.prisma);
}, 30000);

afterAll(async () => { await app?.close(); await env?.cleanup(); });

const create = (over?: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/api/v2/projects/${projectId}/findings`, headers: H, payload: createBody(over) as never });
const setStatus = (id: string, status: string) =>
  app.inject({ method: "POST", url: `/api/v2/findings/${id}/status`, headers: H, payload: { status } as never });

it("无证据候选创建成功；reproduced 被证据门拒绝；补证据后通过", async () => {
  const created = await create();
  expect(created.statusCode).toBe(202);
  const id = created.json().findingId;
  expect((await setStatus(id, "reproduced")).statusCode).toBe(409);
  // 用带证据的新 Finding 验证通过路径。
  const withEvidence = await create({
    dedupeKey: `dedupe-${randomUUID().slice(0, 8)}`,
    firstFailure: { sessionId: null, attemptId: null, runId: null, evidenceIds: ["ev-1"], observedAt: "2026-09-24T00:00:00Z" },
  });
  const evidenceId = withEvidence.json().findingId;
  expect((await setStatus(evidenceId, "reproduced")).json().status).toBe("reproduced");
  // fix_verified 还需要已验证复现。
  expect((await setStatus(evidenceId, "fix_verified")).statusCode).toBe(409);
});

it("同 dedupeKey 去重返回既有", async () => {
  const key = `dedupe-${randomUUID().slice(0, 8)}`;
  const first = await create({ dedupeKey: key });
  const second = await create({ dedupeKey: key });
  expect(second.json().existed).toBe(true);
  expect(second.json().findingId).toBe(first.json().findingId);
});

it("human_confirmed 不能降级回 candidate；rejected 可达", async () => {
  const created = await create({
    dedupeKey: `dedupe-${randomUUID().slice(0, 8)}`,
    firstFailure: { sessionId: null, attemptId: null, runId: null, evidenceIds: ["ev-2"], observedAt: "2026-09-24T00:00:00Z" },
  });
  const id = created.json().findingId;
  await setStatus(id, "human_confirmed");
  expect((await setStatus(id, "candidate")).statusCode).toBe(409);
  expect((await setStatus(id, "rejected")).json().status).toBe("rejected");
});

it("假设追加：支持/反对分栏落库", async () => {
  const created = await create();
  const id = created.json().findingId;
  const res = await app.inject({
    method: "POST", url: `/api/v2/findings/${id}/hypotheses`, headers: H,
    payload: {
      text: "改名接口未写持久层",
      supportingEvidence: [{ kind: "network", ref: "PATCH /title 200 但无写" }],
      contradictingEvidence: [{ kind: "observation", ref: "同会话另一草稿改名成功" }],
    } as never,
  });
  expect(res.statusCode).toBe(200);
  const hypotheses = res.json().hypotheses as Array<{ text: string; supportingEvidence: unknown[]; contradictingEvidence: unknown[]; status: string }>;
  expect(hypotheses).toHaveLength(1);
  expect(hypotheses[0]!.supportingEvidence).toHaveLength(1);
  expect(hypotheses[0]!.contradictingEvidence).toHaveLength(1);
});
