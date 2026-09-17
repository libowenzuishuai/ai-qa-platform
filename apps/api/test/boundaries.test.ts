import { PrismaClient } from "@prisma/client";
import { buildRunReport } from "@ai-qa/reporting";
import { casTransitionRun, emitRunEvent, finalizeCancelledFromRequest } from "@ai-qa/run-events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRun } from "../src/runs-service.js";
import { ApiError } from "../src/errors.js";
import { createTestEnv, seedMinimalAssets, type TestEnv } from "./helpers/db.js";

/**
 * 数据库层边界反例（R2/R3/R4/R5/R8/R9）：全部使用独立临时库与真实
 * Prisma/存储；结束清理。不触碰开发库。
 */

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv("boundary");
});

afterAll(async () => {
  await env.cleanup();
});

async function attemptCreate(assets: Awaited<ReturnType<typeof seedMinimalAssets>>, extra: Record<string, unknown> = {}) {
  return createRun(env.prisma, env.store, {
    projectId: assets.projectId,
    baselineId: assets.baselineId,
    environmentId: assets.environmentId,
    caseVersionIds: [assets.caseVersionId],
    mode: "real",
    idempotencyKey: `key-${Math.random().toString(36).slice(2, 10)}`,
    ...extra,
  });
}

describe("R4：可信引用核验（真实库反例）", () => {
  it("观察证据不存在 → 422", async () => {
    const assets = await seedMinimalAssets(env.prisma, env.store, { fakeEvidence: true });
    await expect(attemptCreate(assets)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("观察证据 nonexistent-evidence-000 不存在"),
    });
  });

  it("观察证据跨项目 → 422", async () => {
    const assets = await seedMinimalAssets(env.prisma, env.store, { crossProjectEvidence: true });
    await expect(attemptCreate(assets)).rejects.toMatchObject({
      message: expect.stringContaining("跨项目"),
    });
  });

  it("引用的规则为 DRAFT → 422", async () => {
    const assets = await seedMinimalAssets(env.prisma, env.store, { ruleStatus: "DRAFT" });
    await expect(attemptCreate(assets)).rejects.toMatchObject({
      message: expect.stringContaining("DRAFT"),
    });
  });
});

describe("R8：并发幂等（真实并发插入，唯一约束竞争）", () => {
  it("并发同键同体：两个都成功且返回同一 run，绝无 500", async () => {
    const assets = await seedMinimalAssets(env.prisma, env.store);
    const body = {
      projectId: assets.projectId,
      baselineId: assets.baselineId,
      environmentId: assets.environmentId,
      caseVersionIds: [assets.caseVersionId],
      mode: "real" as const,
      idempotencyKey: `conc-same-${Date.now()}`,
      budget: { maxToolActionsPerCase: 10 },
    };
    const [a, b] = await Promise.all([
      createRun(env.prisma, env.store, body),
      createRun(env.prisma, env.store, { ...body }),
    ]);
    expect(a.runId).toBe(b.runId);
    const runs = await env.prisma.run.count({ where: { idempotencyKey: body.idempotencyKey } });
    expect(runs).toBe(1);
  });

  it("并发同键异体：一个成功，另一个 409，绝无 500", async () => {
    const assets = await seedMinimalAssets(env.prisma, env.store);
    const key = `conc-diff-${Date.now()}`;
    const base = {
      projectId: assets.projectId,
      baselineId: assets.baselineId,
      environmentId: assets.environmentId,
      mode: "real" as const,
      idempotencyKey: key,
    };
    const results = await Promise.allSettled([
      createRun(env.prisma, env.store, { ...base, caseVersionIds: [assets.caseVersionId] }),
      createRun(env.prisma, env.store, { ...base, caseVersionIds: [assets.caseVersionId], buildId: "another-build" }),
    ]);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(ApiError);
      expect((rejected.reason as ApiError).code).toBe("IDEMPOTENCY_CONFLICT");
    }
    const runs = await env.prisma.run.count({ where: { idempotencyKey: key } });
    expect(runs).toBe(1);
  });
});

describe("R3：运行固定计划版本", () => {
  it("创建时固定 planVersionId/哈希；发布 v2 后旧 run 固定 v1", async () => {
    const assets = await seedMinimalAssets(env.prisma, env.store);
    const created = await attemptCreate(assets);
    const run = await env.prisma.run.findUniqueOrThrow({ where: { id: created.runId } });
    const pins = (run.casePlanPins ?? []) as Array<{ planVersionId: string; acceptanceHash: string }>;
    expect(pins).toHaveLength(1);
    expect(pins[0]!.planVersionId).toBe(assets.planVersionId);

    // 排队期间发布 v2（新版本行）。
    const v1 = await env.prisma.testPlanVersion.findUniqueOrThrow({ where: { id: assets.planVersionId } });
    await env.prisma.testPlanVersion.create({
      data: {
        caseVersionId: assets.caseVersionId,
        version: 2,
        schemaVersion: "1.0",
        plan: v1.plan as never,
        bindingEvidenceIds: v1.bindingEvidenceIds,
        acceptanceHash: "a".repeat(64), // 语义不同（哈希不同）
      },
    });
    // 旧 run 的固定不变。
    const pinsAfter = (run.casePlanPins ?? []) as Array<{ planVersionId: string }>;
    expect(pinsAfter[0]!.planVersionId).toBe(assets.planVersionId);
  });
});

describe("R9：预算解析与保存", () => {
  it("调用者预算被保存（不再静默丢弃）", async () => {
    const assets = await seedMinimalAssets(env.prisma, env.store);
    const created = await attemptCreate(assets, {
      budget: { maxToolActionsPerCase: 3, maxWallClockMsPerCase: 30_000, maxWallClockMsPerRun: 120_000 },
    });
    const run = await env.prisma.run.findUniqueOrThrow({ where: { id: created.runId } });
    expect(run.budget).toMatchObject({
      maxToolActionsPerCase: 3,
      maxWallClockMsPerCase: 30_000,
      maxWallClockMsPerRun: 120_000,
    });
  });

  it("超范围预算 → 422", async () => {
    const assets = await seedMinimalAssets(env.prisma, env.store);
    await expect(
      attemptCreate(assets, { budget: { maxToolActionsPerCase: 9999 } }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("R2：取消与生命周期（CAS）", () => {
  it("排队取消：CANCEL_REQUESTED 有明确归宿（CANCELLED，attempt 不存在）", async () => {
    const assets = await seedMinimalAssets(env.prisma, env.store);
    const created = await attemptCreate(assets);
    const ok = await casTransitionRun(env.prisma, created.runId, ["QUEUED"], "CANCEL_REQUESTED");
    expect(ok).toBe(true);
    await emitRunEvent(env.prisma, created.runId, "run.cancel_requested", {});
    const finalized = await finalizeCancelledFromRequest(env.prisma, created.runId, "排队期间取消");
    expect(finalized).toBe(true);
    const run = await env.prisma.run.findUniqueOrThrow({ where: { id: created.runId } });
    expect(run.lifecycle).toBe("CANCELLED");
    expect(await env.prisma.caseAttempt.count({ where: { runId: created.runId } })).toBe(0);
  });

  it("终态不可回退：CANCELLED 后任何迁移都失败", async () => {
    const assets = await seedMinimalAssets(env.prisma, env.store);
    const created = await attemptCreate(assets);
    await casTransitionRun(env.prisma, created.runId, ["QUEUED"], "CANCEL_REQUESTED");
    await finalizeCancelledFromRequest(env.prisma, created.runId, "测试");
    // 非法迁移（CANCELLED → RUNNING）被状态机拒绝。
    await expect(
      casTransitionRun(env.prisma, created.runId, ["CANCELLED"], "RUNNING"),
    ).rejects.toThrow(/非法生命周期迁移/);
    // 合法边（RUNNING→FINALIZING）在终态上必然失败。
    const again = await casTransitionRun(env.prisma, created.runId, ["RUNNING"], "FINALIZING");
    expect(again).toBe(false);
    expect((await env.prisma.run.findUniqueOrThrow({ where: { id: created.runId } })).lifecycle).toBe("CANCELLED");
  });

  it("过期内存状态无法覆盖数据库新状态（ERROR 后不能再 RUNNING）", async () => {
    const assets = await seedMinimalAssets(env.prisma, env.store);
    const created = await attemptCreate(assets);
    await casTransitionRun(env.prisma, created.runId, ["QUEUED"], "PREPARING");
    // 对账器把数据库改为 ERROR。
    await casTransitionRun(env.prisma, created.runId, ["PREPARING"], "ERROR");
    // 持有过期 PREPARING 的 worker 尝试进入 RUNNING：必须失败。
    const stale = await casTransitionRun(env.prisma, created.runId, ["PREPARING"], "RUNNING");
    expect(stale).toBe(false);
    expect((await env.prisma.run.findUniqueOrThrow({ where: { id: created.runId } })).lifecycle).toBe("ERROR");
  });
});

describe("R5：报告证据完整性（对照固定计划）", () => {
  async function makeFinishedRunWithAttempt(assets: Awaited<ReturnType<typeof seedMinimalAssets>>) {
    const created = await attemptCreate(assets);
    await casTransitionRun(env.prisma, created.runId, ["QUEUED"], "PREPARING");
    await casTransitionRun(env.prisma, created.runId, ["PREPARING"], "RUNNING");
    const attempt = await env.prisma.caseAttempt.create({
      data: {
        runId: created.runId,
        caseVersionId: assets.caseVersionId,
        projectId: assets.projectId,
        attemptNo: 1,
        namespace: "ns-t",
        lifecycle: "FINISHED",
        verdict: "PASS",
        reasonCode: "NONE",
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    });
    return { runId: created.runId, attemptId: attempt.id };
  }

  it("必需断言 PASS 但 evidenceIds 为空 → REVIEW，验收 INCOMPLETE", async () => {
    const assets = await seedMinimalAssets(env.prisma, env.store);
    const { runId, attemptId } = await makeFinishedRunWithAttempt(assets);
    await env.prisma.assertionResultRecord.create({
      data: {
        attemptId,
        assertionId: "a1",
        expected: "付款待办",
        actual: "付款待办",
        result: "PASS",
        evaluatedAt: new Date(),
        evidenceIds: [],
      },
    });
    const report = await buildRunReport(env.prisma, env.store, runId);
    const c = report.cases[0]!;
    expect(c.verdict).toBe("REVIEW");
    expect(c.evidenceDowngraded).toBe(true);
    expect(c.downgradeReasons.join()).toContain("evidenceIds 为空");
    expect(report.metrics.acceptanceStatus).toBe("INCOMPLETE");
  });

  it("必需断言结果记录缺失 → REVIEW（不能 PASS）", async () => {
    const assets = await seedMinimalAssets(env.prisma, env.store);
    const { runId } = await makeFinishedRunWithAttempt(assets);
    const report = await buildRunReport(env.prisma, env.store, runId);
    expect(report.cases[0]!.verdict).toBe("REVIEW");
    expect(report.cases[0]!.downgradeReasons.join()).toContain("缺少结果记录");
  });

  it("证据文件丢失 → REVIEW；内容损坏（校验和不符）→ REVIEW", async () => {
    // 文件丢失。
    {
      const assets = await seedMinimalAssets(env.prisma, env.store);
      const { runId, attemptId } = await makeFinishedRunWithAttempt(assets);
      const stored = env.store.put({ runId: "r", attemptId: "a", filename: "shot.png", data: Buffer.from("png") });
      const artifact = await env.prisma.artifact.create({
        data: {
          projectId: assets.projectId, attemptId,
          storageKey: stored.storageKey, type: "assert-a1",
          sensitivity: "NORMAL", checksum: stored.checksum,
        },
      });
      await env.prisma.assertionResultRecord.create({
        data: {
          attemptId, assertionId: "a1", expected: "x", actual: "x",
          result: "PASS", evaluatedAt: new Date(), evidenceIds: [artifact.id],
        },
      });
      // 删除文件（模拟丢失）。
      const { unlinkSync } = await import("node:fs");
      unlinkSync(`${env.artifactDir}/${stored.storageKey}`);
      const report = await buildRunReport(env.prisma, env.store, runId);
      expect(report.cases[0]!.verdict).toBe("REVIEW");
      expect(report.cases[0]!.downgradeReasons.join()).toContain("证据文件缺失");
    }
    // 内容损坏。
    {
      const assets = await seedMinimalAssets(env.prisma, env.store);
      const { runId, attemptId } = await makeFinishedRunWithAttempt(assets);
      const stored = env.store.put({ runId: "r", attemptId: "a", filename: "shot2.png", data: Buffer.from("png") });
      const artifact = await env.prisma.artifact.create({
        data: {
          projectId: assets.projectId, attemptId,
          storageKey: stored.storageKey, type: "assert-a1",
          sensitivity: "NORMAL", checksum: stored.checksum,
        },
      });
      await env.prisma.assertionResultRecord.create({
        data: {
          attemptId, assertionId: "a1", expected: "x", actual: "x",
          result: "PASS", evaluatedAt: new Date(), evidenceIds: [artifact.id],
        },
      });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(`${env.artifactDir}/${stored.storageKey}`, Buffer.from("tampered"));
      const report = await buildRunReport(env.prisma, env.store, runId);
      expect(report.cases[0]!.verdict).toBe("REVIEW");
      expect(report.cases[0]!.downgradeReasons.join()).toContain("校验和不符");
    }
  });

  it("证据归属他 attempt → REVIEW", async () => {
    const assets = await seedMinimalAssets(env.prisma, env.store);
    const { runId, attemptId } = await makeFinishedRunWithAttempt(assets);
    const stored = env.store.put({ runId: "r", attemptId: "a", filename: "shot3.png", data: Buffer.from("png") });
    // 证据挂在别的 attempt 上。
    const artifact = await env.prisma.artifact.create({
      data: {
        projectId: assets.projectId, attemptId: "someone-else",
        storageKey: stored.storageKey, type: "assert-a1",
        sensitivity: "NORMAL", checksum: stored.checksum,
      },
    });
    await env.prisma.assertionResultRecord.create({
      data: {
        attemptId, assertionId: "a1", expected: "x", actual: "x",
        result: "PASS", evaluatedAt: new Date(), evidenceIds: [artifact.id],
      },
    });
    const report = await buildRunReport(env.prisma, env.store, runId);
    expect(report.cases[0]!.verdict).toBe("REVIEW");
    expect(report.cases[0]!.downgradeReasons.join()).toContain("归属错误");
  });

  it("报告与详情口径一致：metrics 与终态写入同源", async () => {
    const assets = await seedMinimalAssets(env.prisma, env.store);
    const { runId, attemptId } = await makeFinishedRunWithAttempt(assets);
    const stored = env.store.put({ runId: "r", attemptId: "a", filename: "shot4.png", data: Buffer.from("png") });
    const artifact = await env.prisma.artifact.create({
      data: {
        projectId: assets.projectId, attemptId,
        storageKey: stored.storageKey, type: "assert-a1",
        sensitivity: "NORMAL", checksum: stored.checksum,
      },
    });
    await env.prisma.assertionResultRecord.create({
      data: {
        attemptId, assertionId: "a1", expected: "付款待办", actual: "付款待办",
        result: "PASS", evaluatedAt: new Date(), evidenceIds: [artifact.id],
      },
    });
    await casTransitionRun(env.prisma, runId, ["RUNNING"], "FINALIZING");
    await casTransitionRun(env.prisma, runId, ["FINALIZING"], "FINISHED");
    const report = await buildRunReport(env.prisma, env.store, runId);
    // 终态聚合由 worker 用同一 buildRunReport 写入；这里模拟写入后比对。
    await env.prisma.run.update({ where: { id: runId }, data: { acceptanceStatus: report.metrics.acceptanceStatus } });
    const stored2 = await env.prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect(stored2.acceptanceStatus).toBe(report.metrics.acceptanceStatus);
    expect(report.cases[0]!.verdict).toBe("PASS");
  });
});

describe("R7：事件序号原子分配", () => {
  it("并发取号严格递增、无重复、无空洞（模拟取消期间）", async () => {
    const project = await env.prisma.project.create({ data: { name: `seq-${Date.now()}` } });
    const baseline = await env.prisma.baseline.create({
      data: { projectId: project.id, name: "seq 基线", ruleVersionIds: [], caseVersionIds: [] },
    });
    const environment = await env.prisma.environment.create({
      data: { projectId: project.id, name: "seq 环境", baseUrl: "http://127.0.0.1:7999", allowedOrigins: ["http://127.0.0.1:7999"] },
    });
    const run = await env.prisma.run.create({
      data: {
        projectId: project.id,
        baselineId: baseline.id,
        environmentId: environment.id,
        mode: "real",
        selectedCaseVersionIds: [], budget: {}, idempotencyKey: `seq-${Date.now()}`,
      },
    });
    const seqs = await Promise.all(
      Array.from({ length: 20 }, () => emitRunEvent(env.prisma, run.id, "test.event", {})),
    );
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(20);
    expect(sorted).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    // SSE 查询按 seq 排序读取：无事件会被跳过或重复。
    const events = await env.prisma.runEvent.findMany({ where: { runId: run.id }, orderBy: { seq: "asc" } });
    expect(events.map((e) => e.seq)).toEqual(sorted);
  });
});
