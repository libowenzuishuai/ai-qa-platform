import type { PrismaClient } from "@prisma/client";
import { TestCaseVersion, TestPlanV1, verifyStoredPlan } from "@ai-qa/contracts";
import { ArtifactStore } from "@ai-qa/artifact-store";
import { aggregateCase, type AssertionOutcome } from "@ai-qa/evaluation";
import { executePlan } from "@ai-qa/test-runtime";
import type { WorkerConfig } from "./config.js";
import { createArtifactSink } from "./artifact-sink.js";
import { makeCredentialResolver, type SecretRefs } from "./credentials.js";
import { DemoFixtureClient } from "./fixtures.js";
import { RunEventWriter, transitionRun } from "./run-events.js";

/**
 * 运行处理器：真实浏览器执行选定用例并持久化一切。
 *
 * 幂等与一致性：
 * - 认领 = 原子 QUEUED→PREPARING；重复投递认领失败直接返回。
 * - attempt 由 (runId, caseVersionId, attemptNo) 唯一约束兜底；
 *   已有终态 verdict 的 attempt 跳过（消息重复消费不重复执行业务）。
 * - 取消：每个动作前检查 run.lifecycle；写操作不做盲目重放。
 */

interface EnvSnapshot {
  baseUrl: string;
  allowedOrigins: string[];
  dependencyOrigins: string[];
  secretRefs: SecretRefs;
  buildId?: string | null;
}

export async function processRun(prisma: PrismaClient, config: WorkerConfig, runId: string): Promise<void> {
  // —— 认领（幂等） ——
  const claimed = await prisma.run.updateMany({
    where: { id: runId, lifecycle: "QUEUED" },
    data: { lifecycle: "PREPARING" },
  });
  if (claimed.count === 0) return; // 已被其它消费者处理

  const store = new ArtifactStore(config.artifactDir);
  let run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
  const events = await RunEventWriter.open(prisma, runId);
  await events.emit("run.lifecycle", { lifecycle: "PREPARING", runId });

  // 心跳：运行期间持续触碰 updatedAt，供租约检测。
  const heartbeat = setInterval(() => {
    void prisma.run
      .update({ where: { id: runId }, data: { updatedAt: new Date() } })
      .catch(() => undefined);
  }, 5_000);

  try {
    const snapshot = (run.environmentSnapshot ?? {}) as unknown as EnvSnapshot;
    const fixture = new DemoFixtureClient(snapshot.baseUrl, config.demoFixtureToken);
    const resolveCredential = makeCredentialResolver(snapshot.secretRefs ?? {});
    const budget = (run.budget ?? {}) as {
      maxToolActionsPerCase?: number;
      maxWallClockMsPerCase?: number;
    };

    run = await transitionRun(prisma, run, "RUNNING");
    await events.emit("run.lifecycle", { lifecycle: "RUNNING", runId });

    let index = 0;
    for (const caseVersionId of run.selectedCaseVersionIds) {
      index += 1;
      // 取消检查：停止安排新用例。
      const latest = await prisma.run.findUnique({ where: { id: runId }, select: { lifecycle: true } });
      if (latest?.lifecycle === "CANCEL_REQUESTED" || latest?.lifecycle === "CANCELLED") {
        await events.emit("run.cancel_skipped", { caseVersionId, index });
        continue; // 保留 NOT_RUN
      }

      const caseVersion = await prisma.testCaseVersion.findFirst({
        where: { id: caseVersionId, projectId: run.projectId },
      });
      if (!caseVersion) {
        await events.emit("run.case_missing", { caseVersionId });
        continue;
      }
      const planVersion = await prisma.testPlanVersion.findFirst({
        where: { caseVersionId },
        orderBy: { version: "desc" },
      });
      if (!planVersion) {
        await createBlockedAttempt(prisma, events, run, caseVersionId, index, "UNSUPPORTED", "用例没有已绑定的执行计划");
        continue;
      }

      // —— 执行前可信校验（F3 统一入口） ——
      const caseParsed = parseCaseVersion(caseVersion);
      const verification = caseParsed.success
        ? verifyStoredPlan(planVersion.plan, caseParsed.data)
        : { ok: false as const, problems: ["用例版本数据不符合契约"] };
      if (!verification.ok) {
        await createBlockedAttempt(
          prisma,
          events,
          run,
          caseVersionId,
          index,
          "UNSUPPORTED",
          `计划/用例一致性校验失败：${verification.problems.slice(0, 3).join("; ")}`,
        );
        continue;
      }
      const plan = TestPlanV1.parse(planVersion.plan);

      // —— attempt（唯一约束兜底重复消费） ——
      const namespace = `ns-${runId.slice(-10)}-${index}`;
      const existingAttempt = await prisma.caseAttempt.findUnique({
        where: { runId_caseVersionId_attemptNo: { runId, caseVersionId, attemptNo: 1 } },
      });
      if (existingAttempt && existingAttempt.verdict !== "NOT_RUN") {
        continue; // 已执行过，不重复业务操作
      }
      const attempt =
        existingAttempt ??
        (await prisma.caseAttempt.create({
          data: {
            runId,
            caseVersionId,
            projectId: run.projectId,
            attemptNo: 1,
            namespace,
            lifecycle: "RUNNING",
            startedAt: new Date(),
          },
        }));
      await events.emit("attempt.started", {
        attemptId: attempt.id,
        caseVersionId,
        namespace,
        title: caseVersion.title,
      });

      // 命名空间预清理。
      try {
        await fixture.resetNamespace(namespace);
      } catch (err) {
        await events.emit("attempt.fixture_error", {
          attemptId: attempt.id,
          phase: "pre-clean",
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      const sink = createArtifactSink(prisma, store, run.projectId, runId, attempt.id);
      const result = await executePlan({
        plan,
        baseUrl: snapshot.baseUrl,
        policy: {
          allowedOrigins: snapshot.allowedOrigins ?? [],
          dependencyOrigins: snapshot.dependencyOrigins ?? [],
        },
        namespace,
        resolveCredential,
        sink,
        budget: {
          maxActions: budget.maxToolActionsPerCase ?? 50,
          wallClockMs: budget.maxWallClockMsPerCase ?? 300_000,
          perActionTimeoutMs: 15_000,
        },
        shouldContinue: async () => {
          const r = await prisma.run.findUnique({ where: { id: runId }, select: { lifecycle: true } });
          return r?.lifecycle !== "CANCEL_REQUESTED" && r?.lifecycle !== "CANCELLED";
        },
        events: {
          onStep: async (step) => {
            await upsertStep(prisma, attempt.id, step);
            await events.emit("step.updated", { attemptId: attempt.id, ...step });
          },
          onAssertion: async (a) => {
            await upsertAssertion(prisma, attempt.id, plan.assertions, a);
            await events.emit("assertion.evaluated", { attemptId: attempt.id, ...a });
          },
          onViolation: async (v) => {
            await events.emit("violation", { attemptId: attempt.id, ...v });
          },
          onWriteIntent: async (stepId, detail) => {
            await events.emit("write.intent", { attemptId: attempt.id, stepId, detail });
          },
        },
      });

      // —— 持久化断言结果（结果数组为准，避免与回调竞态丢失） ——
      for (const a of result.assertions) {
        await upsertAssertion(prisma, attempt.id, plan.assertions, a);
      }

      // —— 聚合 verdict ——
      const assertionOutcomes: AssertionOutcome[] = result.assertions.map((a) => ({
        assertionId: a.assertionId,
        required: a.required,
        result: a.result,
      }));
      const hasRequiredFail = assertionOutcomes.some((a) => a.required && a.result === "FAIL");
      const evidenceComplete = assertionOutcomes
        .filter((a) => a.required && a.result !== "NOT_EVALUATED")
        .every((a) => {
          const found = result.assertions.find((x) => x.assertionId === a.assertionId);
          return !found || found.evidenceIds.length > 0;
        });
      const aggregate = aggregateCase({
        caseVersionId,
        selected: true,
        started: true,
        blocked: hasRequiredFail
          ? undefined
          : result.cancelled
            ? { reasonCode: "CANCELLED", detail: "执行被取消" }
            : result.blocked
              ? { reasonCode: result.blocked.reasonCode, detail: result.blocked.detail }
              : undefined,
        requiredStepsSkipped: result.steps.some(
          (s) => s.status === "SKIPPED" && !hasOnlyIfJustification(result, s.stepId),
        ) && !hasRequiredFail,
        assertions: assertionOutcomes,
        evidenceComplete,
      });

      await prisma.caseAttempt.update({
        where: { id: attempt.id },
        data: {
          lifecycle: "FINISHED",
          verdict: aggregate.verdict,
          reasonCode: aggregate.reasonCode,
          finishedAt: new Date(),
        },
      });
      await events.emit("attempt.finished", {
        attemptId: attempt.id,
        caseVersionId,
        verdict: aggregate.verdict,
        reasonCode: aggregate.reasonCode,
        detail: aggregate.detail,
        assertions: result.assertions,
      });

      // 命名空间后清理（失败记录事件，不影响已判定结果）。
      try {
        await fixture.resetNamespace(namespace);
      } catch (err) {
        await events.emit("attempt.fixture_error", {
          attemptId: attempt.id,
          phase: "post-clean",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // —— 终态 ——
    // 先读数据库当前状态：取消请求不得被 FINALIZING 覆盖。
    const nowLifecycle = await currentLifecycle(prisma, runId);
    if (nowLifecycle === "CANCEL_REQUESTED") {
      run = await transitionRun(prisma, { ...run, lifecycle: "CANCEL_REQUESTED" }, "CANCELLED");
      await events.emit("run.lifecycle", { lifecycle: "CANCELLED", runId });
    } else {
      const claim = await prisma.run.updateMany({
        where: { id: runId, lifecycle: { in: ["RUNNING", "PREPARING"] } },
        data: { lifecycle: "FINALIZING" },
      });
      if (claim.count > 0) {
        run = { ...run, lifecycle: "FINALIZING" };
        await events.emit("run.lifecycle", { lifecycle: "FINALIZING", runId });
      }
      const acceptance = await computeAcceptance(prisma, runId);
      run = await prisma.run.update({
        where: { id: runId },
        data: { lifecycle: "FINISHED", acceptanceStatus: acceptance },
      });
      await events.emit("run.lifecycle", { lifecycle: "FINISHED", runId, acceptanceStatus: acceptance });
    }
    await events.emit("run.done", { runId, lifecycle: run.lifecycle });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await prisma.runEvent.create({
      data: { runId, seq: 9_999, type: "run.platform_error", payload: { detail: detail.slice(0, 500) } },
    }).catch(() => undefined);
    await prisma.run
      .updateMany({ where: { id: runId, lifecycle: { in: ["QUEUED", "PREPARING", "RUNNING", "FINALIZING"] } }, data: { lifecycle: "ERROR" } })
      .catch(() => undefined);
  } finally {
    clearInterval(heartbeat);
  }
}

function hasOnlyIfJustification(result: { steps: Array<{ stepId: string; actual?: string }> }, stepId: string): boolean {
  const step = result.steps.find((s) => s.stepId === stepId);
  return Boolean(step?.actual?.includes("onlyIf"));
}

async function currentLifecycle(prisma: PrismaClient, runId: string): Promise<string | null> {
  const run = await prisma.run.findUnique({ where: { id: runId }, select: { lifecycle: true } });
  return run?.lifecycle ?? null;
}

function parseCaseVersion(caseVersion: {
  id: string;
  caseId: string;
  version: number;
  title: string;
  description: string | null;
  ruleVersionIds: string[];
  roles: string[];
  preconditions: unknown;
  dataSpec: unknown;
  steps: unknown;
  assertions: unknown;
  cleanup: unknown;
  priority: string;
  approvalStatus: string;
  supersedesId: string | null;
  origin: string;
  promptVersion: string | null;
  approvalHash: string | null;
  projectId: string;
  createdAt: Date;
}) {
  return TestCaseVersion.safeParse({
      ...caseVersion,
      description: caseVersion.description ?? undefined,
      preconditions: caseVersion.preconditions,
      dataSpec: caseVersion.dataSpec,
      steps: caseVersion.steps,
      assertions: caseVersion.assertions,
      cleanup: caseVersion.cleanup,
      promptVersion: caseVersion.promptVersion,
      approvalHash: caseVersion.approvalHash ?? undefined,
      createdAt: caseVersion.createdAt.toISOString(),
    });
}

async function createBlockedAttempt(
  prisma: PrismaClient,
  events: RunEventWriter,
  run: { id: string; projectId: string },
  caseVersionId: string,
  index: number,
  reasonCode: string,
  detail: string,
): Promise<void> {
  const existing = await prisma.caseAttempt.findUnique({
    where: { runId_caseVersionId_attemptNo: { runId: run.id, caseVersionId, attemptNo: 1 } },
  });
  if (existing && existing.verdict !== "NOT_RUN") return;
  const attempt =
    existing ??
    (await prisma.caseAttempt.create({
      data: {
        runId: run.id,
        caseVersionId,
        projectId: run.projectId,
        attemptNo: 1,
        namespace: `ns-${run.id.slice(-10)}-${index}`,
        lifecycle: "FINISHED",
        verdict: "BLOCKED",
        reasonCode,
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    }));
  await prisma.caseAttempt.update({
    where: { id: attempt.id },
    data: { verdict: "BLOCKED", reasonCode, lifecycle: "FINISHED", finishedAt: new Date() },
  });
  await events.emit("attempt.finished", {
    attemptId: attempt.id,
    caseVersionId,
    verdict: "BLOCKED",
    reasonCode,
    detail,
  });
}

async function upsertStep(
  prisma: PrismaClient,
  attemptId: string,
  step: {
    stepId: string;
    type: string;
    effect: string;
    status: string;
    actual?: string;
    error?: string;
    startedAt: string;
    finishedAt?: string;
    evidenceIds: string[];
  },
): Promise<void> {
  const existing = await prisma.stepExecution.findFirst({ where: { attemptId, stepId: step.stepId } });
  const data = {
    status: step.status,
    startedAt: new Date(step.startedAt),
    finishedAt: step.finishedAt ? new Date(step.finishedAt) : null,
    actual: step.actual ?? null,
    error: step.error ?? null,
    evidenceIds: step.evidenceIds,
  };
  if (existing) {
    await prisma.stepExecution.update({ where: { id: existing.id }, data });
  } else {
    await prisma.stepExecution.create({ data: { attemptId, stepId: step.stepId, ...data } });
  }
}

async function upsertAssertion(
  prisma: PrismaClient,
  attemptId: string,
  planAssertions: Array<{ id: string; required: boolean }>,
  a: {
    assertionId: string;
    required?: boolean;
    expected?: unknown;
    actual?: unknown;
    unit?: string;
    result: string;
    evidenceIds: string[];
    note?: string;
  },
): Promise<void> {
  const required = a.required ?? planAssertions.find((p) => p.id === a.assertionId)?.required ?? true;
  const serialize = (v: unknown) =>
    v === undefined || v === null ? null : typeof v === "object" ? JSON.stringify(v) : String(v);
  const existing = await prisma.assertionResultRecord.findFirst({
    where: { attemptId, assertionId: a.assertionId },
  });
  const data = {
    expected: serialize(a.expected),
    actual: serialize(a.actual),
    unit: a.unit ?? null,
    result: a.result,
    evaluatedAt: a.result === "NOT_EVALUATED" ? null : new Date(),
    evidenceIds: a.evidenceIds,
    note: a.note ?? null,
  };
  if (existing) {
    // 只允许从 NOT_EVALUATED 前进，不回退已判定结果。
    if (existing.result === "NOT_EVALUATED") {
      await prisma.assertionResultRecord.update({ where: { id: existing.id }, data });
    }
  } else {
    await prisma.assertionResultRecord.create({ data: { attemptId, assertionId: a.assertionId, ...data } });
  }
}

/** 严格验收状态（FR-10；证据文件存在性降级在 API 报告层复核）。 */
async function computeAcceptance(prisma: PrismaClient, runId: string): Promise<string> {
  const { aggregateRun } = await import("@ai-qa/evaluation");
  const attempts = await prisma.caseAttempt.findMany({ where: { runId } });
  const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
  const cases = attempts.map((a) => ({
    caseVersionId: a.caseVersionId,
    verdict: a.verdict as "PASS" | "FAIL" | "BLOCKED" | "REVIEW" | "NOT_RUN",
    reasonCode: a.reasonCode,
    unstable: a.unstable,
  }));
  const selectedWithoutAttempt = run.selectedCaseVersionIds.filter(
    (id) => !attempts.some((a) => a.caseVersionId === id),
  );
  for (const id of selectedWithoutAttempt) {
    cases.push({ caseVersionId: id, verdict: "NOT_RUN", reasonCode: "NONE", unstable: false });
  }
  const metrics = aggregateRun({
    cases,
    hasBuildId: run.buildId !== null && run.buildId !== undefined,
    cancelled: run.lifecycle === "CANCELLED",
  });
  return metrics.acceptanceStatus;
}
