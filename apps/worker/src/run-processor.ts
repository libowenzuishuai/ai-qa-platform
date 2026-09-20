import { EnvironmentRuntime } from "@ai-qa/contracts";
import { probeBuild } from "./build-verification.js";
import type { PrismaClient, Prisma } from "@prisma/client";
import { TestCaseVersion, TestPlanV1, verifyStoredPlan } from "@ai-qa/contracts";
import { ArtifactStore } from "@ai-qa/artifact-store";
import { aggregateCase, type AssertionOutcome } from "@ai-qa/evaluation";
import { buildRunReport, syncRunDefects } from "@ai-qa/reporting";
import { executePlan } from "@ai-qa/test-runtime";
import {
  casTransitionRun,
  currentLifecycle,
  emitRunEvent,
  finalizeCancelledFromRequest,
  isRunActive,
} from "@ai-qa/run-events";
import type { WorkerConfig } from "./config.js";
import { createArtifactSink } from "./artifact-sink.js";
import { makeCredentialResolver, type SecretRefs } from "./credentials.js";
import { DemoFixtureClient } from "./fixtures.js";

/**
 * 运行处理器（R2/R3/R7/R9 版本）。
 *
 * 状态机：所有迁移使用 CAS（条件 UPDATE）。终态不可回退；持有过期内存
 * 状态的 worker 无法覆盖数据库中的新状态（ERROR/CANCELLED 等）。
 *
 * - QUEUED 取消：认领失败且当前为 CANCEL_REQUESTED → 完成取消（attempt
 *   保持 NOT_RUN），提供明确归宿。
 * - 心跳受租约约束：仅当数据库仍处于 PREPARING/RUNNING 时刷新；租约
 *   丢失即停止，对账器接管后本进程不再安排业务动作。
 * - shouldContinue：只有 PREPARING/RUNNING 视为可继续（ERROR/CANCEL_* 停）。
 * - 计划版本固定：只执行 run.casePlanPins 固定的 planVersionId（R3）。
 * - 预算：run 级截止时间（R9）约束每个 attempt 的 wallClock。
 * - 事件：全部经数据库原子序号分配（R7）。
 */

interface EnvSnapshot {
  baseUrl: string;
  allowedOrigins: string[];
  dependencyOrigins: string[];
  secretRefs: SecretRefs;
  buildId?: string | null;
  runtime?: unknown;
  apiTemplates?: Record<string, unknown>;
}

interface CasePlanPin {
  caseVersionId: string;
  planVersionId: string;
  acceptanceHash: string;
}

/** 状态与对应事件同事务提交，SSE 不会先看到终态再漏掉尾部事件。 */
async function transitionWithEvent(prisma: PrismaClient, runId: string, from: string[], to: string) {
  return prisma.$transaction(async (tx) => {
    const changed = await casTransitionRun(tx, runId, from, to);
    if (changed) await emitRunEvent(tx, runId, "run.lifecycle", { lifecycle: to, runId });
    return changed;
  });
}

export async function processRun(prisma: PrismaClient, config: WorkerConfig, runId: string): Promise<void> {
  // —— 认领（CAS）：QUEUED → PREPARING，仅一个消费者成功 ——
  const claimed = await transitionWithEvent(prisma, runId, ["QUEUED"], "PREPARING");
  if (!claimed) {
    // 未认领成功：若已被取消（如排队期取消），完成取消归宿。
    const lifecycle = await currentLifecycle(prisma, runId);
    if (lifecycle === "CANCEL_REQUESTED") {
      await finalizeCancelledFromRequest(prisma, runId, "排队期间取消，未认领任何用例");
    }
    return; // 已被其它消费者处理或终态。
  }

  const store = new ArtifactStore(config.artifactDir);
  const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });

  // —— 心跳（受租约约束）：数据库不再处于活跃状态时停止刷新 ——
  const heartbeat = setInterval(() => {
    void prisma.run
      .updateMany({
        where: { id: runId, lifecycle: { in: ["PREPARING", "RUNNING"] } } as never,
        data: { updatedAt: new Date() },
      })
      .then((r) => {
        if (r.count === 0) clearInterval(heartbeat); // 租约丢失，停止心跳。
      })
      .catch(() => undefined);
  }, 5_000);

  try {
    const snapshot = (run.environmentSnapshot ?? {}) as unknown as EnvSnapshot;
    const runtime = EnvironmentRuntime.parse(snapshot.runtime ?? {});
    const fixture = runtime.fixture === "demo" ? new DemoFixtureClient(snapshot.baseUrl, config.demoFixtureToken) : undefined;
    await probeBuild(prisma, store, runId, "before");
    const resolveCredential = makeCredentialResolver(Object.keys(runtime.secretRefs).length ? runtime.secretRefs : snapshot.secretRefs ?? {}, runtime.fixture === "demo");
    const budget = (run.budget ?? {}) as {
      maxToolActionsPerCase?: number;
      maxWallClockMsPerCase?: number;
      maxWallClockMsPerRun?: number;
    };
    // R9：run 级截止时间（自运行创建起算），任何 attempt 不得越过。
    const runDeadline =
      budget.maxWallClockMsPerRun && budget.maxWallClockMsPerRun > 0
        ? new Date(run.createdAt).getTime() + budget.maxWallClockMsPerRun
        : Number.MAX_SAFE_INTEGER;

    const enteredRunning = await transitionWithEvent(prisma, runId, ["PREPARING"], "RUNNING");
    if (!enteredRunning) {
      // 数据库已被外部迁移（取消/ERROR）：交给 finalize 分支处理。
      await finalize(prisma, store, runId);
      return;
    }

    const pins = (run.casePlanPins ?? []) as unknown as CasePlanPin[];
    let index = 0;
    for (const caseVersionId of run.selectedCaseVersionIds) {
      index += 1;
      if (!(await isRunActive(prisma, runId))) {
        await emitRunEvent(prisma, runId, "run.cancel_skipped", { caseVersionId, index });
        continue; // 保留 NOT_RUN
      }
      // R9：run 预算耗尽 → 剩余用例不再执行（BLOCKED/TIME_BUDGET）。
      if (Date.now() >= runDeadline) {
        await createBlockedAttempt(
          prisma, runId, run.projectId, caseVersionId, index,
          "TIME_BUDGET", "run 级时间预算耗尽，未开始执行",
        );
        continue;
      }

      const caseVersion = await prisma.testCaseVersion.findFirst({
        where: { id: caseVersionId, projectId: run.projectId },
      });
      if (!caseVersion) {
        await emitRunEvent(prisma, runId, "run.case_missing", { caseVersionId });
        continue;
      }

      // R3：只执行创建运行时固定的计划版本。
      const pin = pins.find((p) => p.caseVersionId === caseVersionId);
      const planVersion = pin
        ? await prisma.testPlanVersion.findUnique({ where: { id: pin.planVersionId } })
        : await prisma.testPlanVersion.findFirst({
            where: { caseVersionId },
            orderBy: { version: "desc" }, // 兼容旧运行（无固定记录）。
          });
      if (!planVersion) {
        await createBlockedAttempt(prisma, runId, run.projectId, caseVersionId, index, "UNSUPPORTED", "用例没有已绑定的执行计划");
        continue;
      }
      if (pin && planVersion.acceptanceHash !== pin.acceptanceHash) {
        await createBlockedAttempt(
          prisma, runId, run.projectId, caseVersionId, index, "UNSUPPORTED",
          `固定计划哈希不符（固定 ${pin.acceptanceHash.slice(0, 12)}… vs 存储 ${planVersion.acceptanceHash.slice(0, 12)}…）`,
        );
        continue;
      }

      // —— 执行前可信校验（F3 统一入口 + 批准状态复核 R4） ——
      const caseParsed = parseCaseVersion(caseVersion);
      const verification = caseParsed.success
        ? verifyStoredPlan(planVersion.plan, caseParsed.data)
        : { ok: false as const, problems: ["用例版本数据不符合契约"] };
      if (!verification.ok) {
        await createBlockedAttempt(
          prisma, runId, run.projectId, caseVersionId, index, "UNSUPPORTED",
          `计划/用例一致性校验失败：${verification.problems.slice(0, 3).join("; ")}`,
        );
        continue;
      }
      // R4：用例引用的规则仍须 APPROVED。
      const rules = await prisma.ruleVersion.findMany({
        where: { id: { in: caseVersion.ruleVersionIds } },
        select: { id: true, reviewStatus: true },
      });
      const notApproved = caseVersion.ruleVersionIds.filter(
        (rid) => rules.find((r) => r.id === rid)?.reviewStatus !== "APPROVED",
      );
      if (notApproved.length > 0) {
        await createBlockedAttempt(
          prisma, runId, run.projectId, caseVersionId, index, "UNSUPPORTED",
          `引用的规则已不是 APPROVED：${notApproved.join(",")}`,
        );
        continue;
      }

      const dataSpec = caseVersion.dataSpec as { strategy: string };
      const cleanup = caseVersion.cleanup as { strategy: string };
      if (dataSpec.strategy === "fixture" || (cleanup.strategy !== "manual" && !fixture)) {
        await createBlockedAttempt(prisma, runId, run.projectId, caseVersionId, index, "UNSUPPORTED", "用例声明的业务夹具或自动清理能力未配置，未开始业务操作");
        continue;
      }
      const plan = TestPlanV1.parse(planVersion.plan);
      let invalidEvidence = false;
      for (const binding of plan.bindings) {
        const evidence = await prisma.artifact.findUnique({ where: { id: binding.evidenceId } });
        if (!evidence || evidence.projectId !== run.projectId || evidence.type !== "OBSERVATION" ||
            (evidence.expiresAt && evidence.expiresAt <= new Date()) ||
            !store.verify(evidence.storageKey, evidence.checksum)) {
          invalidEvidence = true;
          break;
        }
      }
      if (invalidEvidence) {
        await createBlockedAttempt(prisma, runId, run.projectId, caseVersionId, index,
          "UNSUPPORTED", "执行前复核发现观察证据缺失、损坏、过期或归属错误");
        continue;
      }
      const namespace = `ns-${runId.slice(-10)}-${index}`;
      const existingAttempt = await prisma.caseAttempt.findUnique({
        where: { runId_caseVersionId_attemptNo: { runId, caseVersionId, attemptNo: 1 } },
      });
      if (existingAttempt && existingAttempt.verdict !== "NOT_RUN") {
        continue; // 已执行（重复投递）：不重复业务操作。
      }
      const attempt =
        existingAttempt ??
        (await prisma.caseAttempt.create({
          data: {
            runId, caseVersionId, projectId: run.projectId,
            attemptNo: 1, namespace, lifecycle: "RUNNING", startedAt: new Date(),
          },
        }));
      await emitRunEvent(prisma, runId, "attempt.started", {
        attemptId: attempt.id, caseVersionId, namespace, title: caseVersion.title,
        planVersionId: planVersion.id,
      });

      try {
        await fixture?.resetNamespace(namespace, runDeadline);
      } catch (err) {
        await emitRunEvent(prisma, runId, "attempt.fixture_error", {
          attemptId: attempt.id, phase: "pre-clean",
          detail: err instanceof Error ? err.message : String(err),
        });
        await prisma.caseAttempt.updateMany({where:{id:attempt.id,lifecycle:"RUNNING"},data:{lifecycle:"FINISHED",verdict:"BLOCKED",reasonCode:"ENVIRONMENT",finishedAt:new Date()}});
        await emitRunEvent(prisma,runId,"attempt.finished",{attemptId:attempt.id,caseVersionId,verdict:"BLOCKED",reasonCode:"ENVIRONMENT",detail:"数据准备失败，未执行浏览器业务操作"});
        continue;
      }

      const sink = createArtifactSink(prisma, store, run.projectId, runId, attempt.id);
      // R9：attempt 预算受 run 截止时间约束。
      const remainingForCase = Math.max(1, runDeadline - Date.now());
      const wallClockMs = Math.min(budget.maxWallClockMsPerCase ?? 300_000, remainingForCase);
      const result = await executePlan({
        plan,
        baseUrl: snapshot.baseUrl,
        policy: {
          allowedOrigins: snapshot.allowedOrigins ?? [],
          dependencyOrigins: snapshot.dependencyOrigins ?? [],
        },
        namespace,
        resolveCredential,
        dataRefs: runtime.dataRefs,
        apiTemplates: snapshot.apiTemplates,
        sink,
        budget: {
          maxActions: budget.maxToolActionsPerCase ?? 50,
          wallClockMs,
          perActionTimeoutMs: Math.min(15_000, wallClockMs),
        },
        shouldContinue: async () => isRunActive(prisma, runId),
        events: {
          onStep: async (step) => {
            await upsertStep(prisma, attempt.id, step);
            await emitRunEvent(prisma, runId, "step.updated", { attemptId: attempt.id, ...step });
          },
          onAssertion: async (a) => {
            await upsertAssertion(prisma, attempt.id, plan.assertions, a);
            await emitRunEvent(prisma, runId, "assertion.evaluated", { attemptId: attempt.id, ...a });
          },
          onViolation: async (v) => {
            await emitRunEvent(prisma, runId, "violation", { attemptId: attempt.id, ...v });
          },
          onWriteIntent: async (stepId, detail) => {
            await emitRunEvent(prisma, runId, "write.intent", { attemptId: attempt.id, stepId, detail });
          },
        },
      });

      let cleanupError: string | undefined;
      try { await fixture?.resetNamespace(namespace, runDeadline); }
      catch (err) {
        cleanupError = "数据清理失败，请检查此运行的数据隔离区";
        await emitRunEvent(prisma, runId, "attempt.fixture_error", {attemptId:attempt.id,phase:"post-clean",detail:err instanceof Error?err.message:String(err)});
      }
      const assertionOutcomes: AssertionOutcome[] = result.assertions.map((a) => ({
        assertionId: a.assertionId,
        required: a.required,
        result: a.result,
      }));
      const hasRequiredFail = assertionOutcomes.some((a) => a.required && a.result === "FAIL");
      const evidenceComplete = assertionOutcomes
        .filter((a) => a.required && a.result === "PASS")
        .every((a) => {
          const found = result.assertions.find((x) => x.assertionId === a.assertionId);
          return found && found.evidenceIds.length > 0;
        });
      const aggregate = aggregateCase({
        caseVersionId,
        selected: true,
        started: true,
        blocked: hasRequiredFail
          ? undefined
          : result.cancelled
            ? { reasonCode: "CANCELLED", detail: "执行被取消" }
            : cleanupError
              ? { reasonCode: "ENVIRONMENT", detail: cleanupError }
            : result.blocked
              ? { reasonCode: result.blocked.reasonCode, detail: result.blocked.detail }
              : undefined,
        requiredStepsSkipped:
          result.steps.some((s) => s.status === "SKIPPED" && !s.actual?.includes("onlyIf")) && !hasRequiredFail,
        assertions: assertionOutcomes,
        evidenceComplete,
      });

      await prisma.$transaction(async (tx) => {
        // 锁住运行行再收尾 attempt：不能覆盖取消/对账器刚写入的结果。
        const active = await tx.run.updateMany({
          where: { id: runId, lifecycle: "RUNNING" }, data: { updatedAt: new Date() },
        });
        if (active.count === 0) return;
        const completed = await tx.caseAttempt.updateMany({
          where: { id: attempt.id, lifecycle: "RUNNING" },
          data: { lifecycle: "FINISHED", verdict: aggregate.verdict,
            reasonCode: aggregate.reasonCode, finishedAt: new Date() },
        });
        if (completed.count === 0) return;
        for (const a of result.assertions) await upsertAssertion(tx, attempt.id, plan.assertions, a);
        await emitRunEvent(tx, runId, "attempt.finished", {
          attemptId: attempt.id, caseVersionId, verdict: aggregate.verdict,
          reasonCode: aggregate.reasonCode, detail: aggregate.detail, planVersionId: planVersion.id,
        });
      });

    }

    await probeBuild(prisma, store, runId, "after");
    await finalize(prisma, store, runId);
    await syncRunDefects(prisma, store, runId);
  } catch (err) {
    const detail = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    // 平台故障：仅在仍处于非终态时落 ERROR（CAS，不覆盖已定终态）。
    await prisma.$transaction(async (tx) => {
      const changed = await casTransitionRun(tx, runId,
        ["QUEUED", "PREPARING", "RUNNING", "FINALIZING", "CANCEL_REQUESTED"], "ERROR");
      if (!changed) return;
      await tx.caseAttempt.updateMany({
        where: { runId, lifecycle: { not: "FINISHED" } },
        data: { lifecycle: "FINISHED", verdict: "BLOCKED", reasonCode: "ENVIRONMENT", finishedAt: new Date() },
      });
      await emitRunEvent(tx, runId, "run.platform_error", { detail });
    });
  } finally {
    clearInterval(heartbeat);
  }
}

/** 终态：取消优先（不覆盖）；否则 CAS 进入 FINALIZING → FINISHED。 */
async function finalize(
  prisma: PrismaClient,
  store: ArtifactStore,
  runId: string,
): Promise<void> {
  const lifecycle = await currentLifecycle(prisma, runId);
  if (lifecycle === "CANCEL_REQUESTED") {
    await finalizeCancelledFromRequest(prisma, runId, "执行期间取消");
    return;
  }
  if (lifecycle !== "PREPARING" && lifecycle !== "RUNNING" && lifecycle !== "FINALIZING") {
    return; // 终态（含对账器已落 ERROR）：不可回退。
  }
  if (lifecycle !== "FINALIZING") {
    // 仅 RUNNING 可进入 FINALIZING（状态机边）；PREPARING 中途回到收尾的
    // 场景由 enteredRunning 失败分支提前 return 处理。
    const entered = await transitionWithEvent(prisma, runId, ["RUNNING"], "FINALIZING");
    if (!entered) {
      // 竞争失败（被取消/ERROR）：按当前状态收尾。
      const now = await currentLifecycle(prisma, runId);
      if (now === "CANCEL_REQUESTED") {
        await finalizeCancelledFromRequest(prisma, runId, "收尾期间取消");
        return;
      }
      if (now !== "FINALIZING") return;
    }
  }
  // 收尾期间到达的取消：FINALIZING → CANCEL_REQUESTED → CANCELLED。
  const beforeFinish = await currentLifecycle(prisma, runId);
  if (beforeFinish === "CANCEL_REQUESTED") {
    await finalizeCancelledFromRequest(prisma, runId, "收尾期间取消");
    return;
  }
  const report = await buildRunReport(prisma, store, runId);
  await prisma.$transaction(async (tx) => {
    const finished = await casTransitionRun(tx, runId, ["FINALIZING"], "FINISHED");
    if (!finished) return;
    await tx.run.update({ where: { id: runId }, data: { acceptanceStatus: report.metrics.acceptanceStatus } });
    await emitRunEvent(tx, runId, "run.lifecycle", {
      lifecycle: "FINISHED", runId, acceptanceStatus: report.metrics.acceptanceStatus,
    });
    await emitRunEvent(tx, runId, "run.done", { runId, lifecycle: "FINISHED" });
  });
  if (await currentLifecycle(prisma, runId) === "CANCEL_REQUESTED") {
    await finalizeCancelledFromRequest(prisma, runId, "收尾期间取消");
  }
}

function parseCaseVersion(caseVersion: {
  id: string; caseId: string; version: number; title: string; description: string | null;
  ruleVersionIds: string[]; roles: string[]; preconditions: unknown; dataSpec: unknown;
  steps: unknown; assertions: unknown; cleanup: unknown; priority: string;
  approvalStatus: string; supersedesId: string | null; origin: string;
  promptVersion: string | null; approvalHash: string | null; projectId: string; createdAt: Date;
}) {
  return TestCaseVersion.safeParse({
    ...caseVersion,
    description: caseVersion.description ?? undefined,
    preconditions: caseVersion.preconditions,
    dataSpec: caseVersion.dataSpec,
    steps: caseVersion.steps,
    assertions: caseVersion.assertions,
    cleanup: caseVersion.cleanup,
    approvalHash: caseVersion.approvalHash ?? undefined,
    createdAt: caseVersion.createdAt.toISOString(),
  });
}

async function createBlockedAttempt(
  prisma: PrismaClient,
  runId: string,
  projectId: string,
  caseVersionId: string,
  index: number,
  reasonCode: string,
  detail: string,
): Promise<void> {
  const existing = await prisma.caseAttempt.findUnique({
    where: { runId_caseVersionId_attemptNo: { runId, caseVersionId, attemptNo: 1 } },
  });
  if (existing && existing.verdict !== "NOT_RUN") return;
  const attempt =
    existing ??
    (await prisma.caseAttempt.create({
      data: {
        runId, caseVersionId, projectId, attemptNo: 1,
        namespace: `ns-${runId.slice(-10)}-${index}`,
        lifecycle: "FINISHED", verdict: "BLOCKED", reasonCode,
        startedAt: new Date(), finishedAt: new Date(),
      },
    }));
  await prisma.caseAttempt.update({
    where: { id: attempt.id },
    data: { verdict: "BLOCKED", reasonCode, lifecycle: "FINISHED", finishedAt: new Date() },
  });
  await emitRunEvent(prisma, runId, "attempt.finished", {
    attemptId: attempt.id, caseVersionId, verdict: "BLOCKED", reasonCode, detail,
  });
}

async function upsertStep(
  prisma: PrismaClient,
  attemptId: string,
  step: {
    stepId: string; type: string; effect: string; status: string;
    actual?: string; error?: string; startedAt: string; finishedAt?: string; evidenceIds: string[];
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
  prisma: PrismaClient | Prisma.TransactionClient,
  attemptId: string,
  planAssertions: Array<{ id: string; required: boolean }>,
  a: {
    assertionId: string; required?: boolean; expected?: unknown; actual?: unknown;
    unit?: string; result: string; evidenceIds: string[]; note?: string;
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
    if (existing.result === "NOT_EVALUATED") {
      await prisma.assertionResultRecord.update({ where: { id: existing.id }, data });
    }
  } else {
    await prisma.assertionResultRecord.create({ data: { attemptId, assertionId: a.assertionId, ...data } });
  }
}
