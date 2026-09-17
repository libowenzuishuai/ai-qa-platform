import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { emitRunEvent } from "@ai-qa/run-events";
import { buildRunReport } from "@ai-qa/reporting";
import { createRun } from "../src/runs-service.js";
import { createTestEnv, seedMinimalAssets, type TestEnv } from "./helpers/db.js";
import { unlinkSync } from "node:fs";

let env: TestEnv;
beforeAll(async () => { env = await createTestEnv("review"); });
afterAll(async () => { await env?.cleanup(); });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
async function runAsset() {
  const assets = await seedMinimalAssets(env.prisma, env.store);
  const input = { ...assets, caseVersionIds: [assets.caseVersionId], mode: "real" as const,
    buildId: "review-build", idempotencyKey: `review-${assets.caseVersionId}` };
  const { runId } = await createRun(env.prisma, env.store, input);
  return { ...assets, input, runId };
}
async function passingRun() {
  const asset = await runAsset();
  const attempt = await env.prisma.caseAttempt.create({ data: {
    runId: asset.runId, projectId: asset.projectId, caseVersionId: asset.caseVersionId,
    attemptNo: 1, namespace: `ns-${asset.runId}`, lifecycle: "FINISHED", verdict: "PASS", reasonCode: "NONE",
  } });
  const stored = env.store.put({ runId: asset.runId, attemptId: attempt.id, filename: "pass.png", data: Buffer.from("evidence") });
  const artifact = await env.prisma.artifact.create({ data: {
    projectId: asset.projectId, attemptId: attempt.id, type: "SCREENSHOT", storageKey: stored.storageKey, checksum: stored.checksum,
  } });
  const record = await env.prisma.assertionResultRecord.create({ data: {
    attemptId: attempt.id, assertionId: "a1", expected: "付款待办", actual: "付款待办",
    result: "PASS", evidenceIds: [artifact.id],
  } });
  await env.prisma.run.update({ where: { id: asset.runId }, data: { lifecycle: "FINISHED", acceptanceStatus: "PASS" } });
  return { ...asset, attempt, artifact, record };
}

describe("独立复查：提交顺序与报告可信度", () => {
  it("事件写入失败必须回滚取号，不能留下永久序号空洞", async () => {
    const { runId } = await runAsset();
    const before = await env.prisma.run.findUniqueOrThrow({ where: { id: runId } });
    await expect(emitRunEvent(env.prisma, runId, undefined as never)).rejects.toThrow();
    const after = await env.prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect(after.eventSeq).toBe(before.eventSeq);
  });

  it("序号较小的事件延迟写入时，后续事件不得提前对 SSE 可见", async () => {
    const { runId } = await runAsset();
    const entered = latch(), release = latch();
    const client = env.prisma.$extends({ query: { runEvent: { async create({ args, query }) {
      if (args.data.type === "review.slow") { entered.resolve(); await release.promise; }
      return query(args);
    } } } }) as unknown as PrismaClient;
    const slow = emitRunEvent(client, runId, "review.slow");
    await entered.promise;
    const fast = emitRunEvent(env.prisma, runId, "review.fast");
    let visible: unknown[] = [];
    try {
      await delay(150);
      visible = await env.prisma.runEvent.findMany({ where: { runId, type: { startsWith: "review." } } });
    } finally { release.resolve(); await Promise.all([slow, fast]); }
    expect(visible).toEqual([]);
    const events = await env.prisma.runEvent.findMany({ where: { runId }, orderBy: { seq: "asc" } });
    expect(events.map((e) => e.type)).toEqual(["run.created", "review.slow", "review.fast"]);
  });

  it("已完成的幂等请求在观察文件过期后仍返回原运行", async () => {
    const asset = await runAsset();
    const evidence = await env.prisma.artifact.findUniqueOrThrow({ where: { id: asset.evidenceArtifactId } });
    unlinkSync(`${env.artifactDir}/${evidence.storageKey}`);
    expect(await createRun(env.prisma, env.store, asset.input)).toEqual({ runId: asset.runId, existed: true });
  });

  it("证据丢失后报告头与指标必须一致降级，不能保留缓存 PASS", async () => {
    const asset = await passingRun();
    unlinkSync(`${env.artifactDir}/${asset.artifact.storageKey}`);
    const report = await buildRunReport(env.prisma, env.store, asset.runId);
    expect(report.metrics.acceptanceStatus).toBe("INCOMPLETE");
    expect(report.run.acceptanceStatus).toBe(report.metrics.acceptanceStatus);
  });

  it.each(["NOT_EVALUATED", "REVIEW", "FAIL"])("必需断言 %s 不能被缓存的用例 PASS 覆盖", async (result) => {
    const asset = await passingRun();
    await env.prisma.assertionResultRecord.update({ where: { id: asset.record.id }, data: { result } });
    const report = await buildRunReport(env.prisma, env.store, asset.runId);
    expect(report.cases[0]!.verdict).not.toBe("PASS");
    expect(report.metrics.acceptanceStatus).not.toBe("PASS");
  });

  it("固定计划删除后无法继续宣称 PASS", async () => {
    const asset = await passingRun();
    await env.prisma.testPlanVersion.delete({ where: { id: asset.planVersionId } });
    const report = await buildRunReport(env.prisma, env.store, asset.runId);
    expect(report.cases[0]!.verdict).toBe("REVIEW");
  });
});

describe("独立复查：接口与执行前复核", () => {
  it("首事件持久化失败时运行创建一并回滚", async () => {
    const assets = await seedMinimalAssets(env.prisma, env.store);
    const client = env.prisma.$extends({ query: { runEvent: { async create({ args, query }) {
      if (args.data.type === "run.created") throw new Error("injected persistence failure");
      return query(args);
    } } } }) as unknown as PrismaClient;
    const idempotencyKey = `rollback-${assets.caseVersionId}`;
    await expect(createRun(client, env.store, { ...assets, caseVersionIds: [assets.caseVersionId],
      mode: "real", idempotencyKey })).rejects.toThrow("injected persistence failure");
    expect(await env.prisma.run.count({ where: { projectId: assets.projectId, idempotencyKey } })).toBe(0);
  });

  it("未请求取消时，取消收尾不能提前篡改 attempt", async () => {
    const { finalizeCancelledFromRequest } = await import("@ai-qa/run-events");
    const asset = await passingRun();
    await env.prisma.run.update({ where: { id: asset.runId }, data: { lifecycle: "RUNNING" } });
    await env.prisma.caseAttempt.update({ where: { id: asset.attempt.id }, data: { lifecycle: "RUNNING", verdict: "NOT_RUN" } });
    expect(await finalizeCancelledFromRequest(env.prisma, asset.runId, "stale cancel")).toBe(false);
    expect((await env.prisma.caseAttempt.findUniqueOrThrow({ where: { id: asset.attempt.id } })).lifecycle).toBe("RUNNING");
  });

  it("排队后删除观察证据，worker 在任何浏览器动作前阻断", async () => {
    const { processRun } = await import("../../worker/src/run-processor.js");
    const asset = await runAsset();
    const evidence = await env.prisma.artifact.findUniqueOrThrow({ where: { id: asset.evidenceArtifactId } });
    unlinkSync(`${env.artifactDir}/${evidence.storageKey}`);
    await processRun(env.prisma, { databaseUrl: env.databaseUrl, artifactDir: env.artifactDir,
      port: 0, host: "127.0.0.1", redisUrl: "redis://127.0.0.1:1", demoFixtureToken: "dummy", logLevel: "silent",
    }, asset.runId);
    const attempt = await env.prisma.caseAttempt.findFirstOrThrow({ where: { runId: asset.runId } });
    expect(attempt.verdict).toBe("BLOCKED");
    expect(attempt.reasonCode).toBe("UNSUPPORTED");
    expect(await env.prisma.runEvent.count({ where: { runId: asset.runId, type: "step.updated" } })).toBe(0);
  });

  it("观察文件内容被篡改，创建新运行时拒绝", async () => {
    const { writeFileSync } = await import("node:fs");
    const asset = await runAsset();
    const evidence = await env.prisma.artifact.findUniqueOrThrow({ where: { id: asset.evidenceArtifactId } });
    writeFileSync(`${env.artifactDir}/${evidence.storageKey}`, "corrupted");
    await expect(createRun(env.prisma, env.store, { ...asset.input, idempotencyKey: `new-${asset.runId}` }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("损坏或过期") });
  });

  it("证据丢失后真实 HTTP 详情、列表、报告同时降级", async () => {
    const { default: Fastify } = await import("fastify");
    const { default: cookie } = await import("@fastify/cookie");
    const { registerAuth } = await import("../src/auth.js");
    const { registerRunRoutes } = await import("../src/routes-runs.js");
    const asset = await passingRun();
    const app = Fastify();
    await app.register(cookie);
    registerAuth(app, env.prisma, 600);
    // 只测试只读端点；不会调用队列。鉴权通过真实 Session 与 User 表。
    registerRunRoutes(app, env.prisma, undefined as never, env.store);
    const user = await env.prisma.user.create({ data: {
      username: `review-${asset.runId}`, displayName: "Review", passwordHash: "unused", platformRole: "ADMIN",
    } });
    const session = await env.prisma.session.create({ data: { id: `session-${asset.runId}`,
      userId: user.id, expiresAt: new Date(Date.now() + 60_000) } });
    const headers = { cookie: `aiqa_sid=${session.id}` };
    try {
      const before = await app.inject({ url: `/api/runs/${asset.runId}`, headers });
      expect(before.statusCode).toBe(200);
      expect(before.json().run.acceptanceStatus).toBe("PASS");
      unlinkSync(`${env.artifactDir}/${asset.artifact.storageKey}`);
      const detail = (await app.inject({ url: `/api/runs/${asset.runId}`, headers })).json();
      const report = (await app.inject({ url: `/api/runs/${asset.runId}/report`, headers })).json();
      const list = (await app.inject({ url: `/api/runs?projectId=${asset.projectId}`, headers })).json();
      expect(detail.run.acceptanceStatus).toBe("INCOMPLETE");
      expect(detail.cases[0].verdict).toBe("REVIEW");
      expect(report.run.acceptanceStatus).toBe(detail.run.acceptanceStatus);
      expect(report.metrics.acceptanceStatus).toBe(detail.run.acceptanceStatus);
      expect(list.runs[0].acceptanceStatus).toBe(detail.run.acceptanceStatus);
    } finally { await app.close(); }
  });
});

it("计划登记哈希与计划 JSON 哈希不一致时拒绝创建", async () => {
  const asset = await runAsset();
  await env.prisma.testPlanVersion.update({ where: { id: asset.planVersionId }, data: { acceptanceHash: "b".repeat(64) } });
  await expect(createRun(env.prisma, env.store, { ...asset.input, idempotencyKey: `hash-${asset.runId}` }))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("登记哈希") });
});
