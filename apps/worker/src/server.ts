import { reconcileCodeChecks } from '@ai-qa/run-events';
import { ArtifactStore } from "@ai-qa/artifact-store";
import Fastify from "fastify";
import { reconcileAgentJobs } from "./agent-job-recovery.js";
import { PrismaClient } from "@prisma/client";
import { Queue, Worker as BullWorker } from "bullmq";
import { emitRunEvent, parseRedisConnection } from "@ai-qa/run-events";
import { loadConfig } from "./config.js";
import { processRun } from "./run-processor.js";
import { finalizeCancelledFromRequest } from "@ai-qa/run-events";
import { seedFixedAssets } from "./seed-processor.js";
import { processAgentJob } from "./agent-job-processor.js";
import { runLoginCheck } from "./login-check-job.js";
import { runDataPrepare, runDataCleanup } from "./data-plugin-job.js";
import { advanceWorkflow } from "./workflow-orchestrator.js";

/**
 * 执行 worker（阶段 1）。
 *
 * - BullMQ 消费 runs / seed-fixed-assets 两个队列（真实 Redis）。
 * - 对账循环兜底"落库但入队失败"（QUEUED 超时重投）与 worker 失联
 *   （心跳超时 → 运行进入 ERROR，不永久 RUNNING、不报 PASS）。
 * - 处理幂等：运行认领与 attempt 唯一约束保证重复投递不重复执行业务。
 */

const config = loadConfig();
if (!config.databaseUrl) {
  console.error("缺少 DATABASE_URL");
  process.exit(1);
}
const prisma = new PrismaClient();

// Redis URL 完整解析（§三.1）：db/密码/TLS 实际生效，不只取 host/port。
const parsed = parseRedisConnection(config.redisUrl);
const connection = {
  host: parsed.host,
  port: parsed.port,
  ...(parsed.username ? { username: parsed.username } : {}),
  ...(parsed.password ? { password: parsed.password } : {}),
  ...(parsed.db !== undefined ? { db: parsed.db } : {}),
  ...(parsed.tls ? { tls: {} } : {}),
};

export const runsQueue = new Queue("runs", { connection });
export const seedQueue = new Queue("seed-fixed-assets", { connection });
export const agentJobsQueue = new Queue("agent-jobs", { connection });

const runWorker = new BullWorker(
  "runs",
  async (job) => {
    if (job.name === "execute") {
      await processRun(prisma, config, String(job.data.runId));
    }
  },
  { connection, concurrency: 2 },
);

const agentJobWorker = new BullWorker(
  "agent-jobs",
  async (job) => {
    if (job.name === "run") {
      const jobId = String(job.data.jobId);
      const row = await prisma.job.findUnique({ where: { id: jobId } });
      if (row?.kind === "LOGIN_CHECK") {
        // 登录检查有独立 BrowserContext；沿用 CAS 认领 + 心跳模式。
        const claimed = await prisma.job.updateMany({ where: { id: jobId, status: "QUEUED" }, data: { status: "RUNNING", startedAt: new Date() } });
        if (!claimed.count) return;
        try {
          await runLoginCheck(prisma, new ArtifactStore(config.artifactDir), { ...row, startedAt: new Date() }, config);
        } catch (err) {
          await prisma.job.update({ where: { id: jobId }, data: { status: "FAILED", error: { code: "INTERNAL", message: String(err).slice(0, 500), requestId: jobId } as never, finishedAt: new Date() } });
        }
      } else if (row?.kind === "DATA_PREPARE") {
        const claimed = await prisma.job.updateMany({ where: { id: jobId, status: "QUEUED" }, data: { status: "RUNNING", startedAt: new Date() } });
        if (claimed.count) {
          try { await runDataPrepare(prisma, { ...row, startedAt: new Date() }); }
          catch (err) {
            await prisma.job.update({ where: { id: jobId }, data: { status: "FAILED", error: { code: "INTERNAL", message: String(err).slice(0, 500), requestId: jobId } as never, finishedAt: new Date() } });
          }
        }
      } else if (row?.kind === "DATA_CLEANUP") {
        const claimed = await prisma.job.updateMany({ where: { id: jobId, status: "QUEUED" }, data: { status: "RUNNING", startedAt: new Date() } });
        if (claimed.count) {
          try { await runDataCleanup(prisma, { ...row, startedAt: new Date() }); }
          catch (err) {
            await prisma.job.update({ where: { id: jobId }, data: { status: "FAILED", error: { code: "INTERNAL", message: String(err).slice(0, 500), requestId: jobId } as never, finishedAt: new Date() } });
          }
        }
      } else if (row?.kind === "WORKFLOW_ADVANCE") {
        const wfId = (row.request as Record<string, unknown>).workflowId as string;
        const claimed = await prisma.job.updateMany({ where: { id: jobId, status: "QUEUED" }, data: { status: "RUNNING", startedAt: new Date() } });
        if (claimed.count) {
          try {
            await advanceWorkflow(prisma, wfId);
            await prisma.job.update({ where: { id: jobId }, data: { status: "SUCCEEDED", finishedAt: new Date() } });
          } catch (err) {
            await prisma.job.update({ where: { id: jobId }, data: { status: "FAILED", error: { code: "INTERNAL", message: String(err).slice(0, 500), requestId: jobId } as never, finishedAt: new Date() } });
          }
        }
      } else {
        await processAgentJob(prisma, config, jobId);
      }
    }
  },
  { connection, concurrency: 1 },
);

const seedWorker = new BullWorker(
  "seed-fixed-assets",
  async (job) => {
    await seedFixedAssets(prisma, config, String(job.data.projectId), String(job.data.environmentId));
  },
  { connection, concurrency: 1 },
);

for (const w of [runWorker, agentJobWorker, seedWorker]) {
  w.on("failed", (job, err) => {
    console.error(`[queue:${w.name}] job ${job?.id} 失败:`, err.message);
  });
}

// —— 对账循环 ——
const RECONCILE_INTERVAL_MS = 15_000;
const QUEUED_RETRY_AFTER_MS = 10_000;
const LEASE_STALE_MS = 90_000;

async function reconcile(): Promise<void> {
  await reconcileAgentJobs(prisma, agentJobsQueue);
  await reconcileCodeChecks(prisma);
  // 1) 落库但入队失败/丢失的 QUEUED 运行：超时重投。
  const staleQueued = await prisma.run.findMany({
    where: {
      lifecycle: "QUEUED",
      updatedAt: { lt: new Date(Date.now() - QUEUED_RETRY_AFTER_MS) },
    },
    select: { id: true },
    take: 20,
  });
  for (const run of staleQueued) {
    await runsQueue
      .add("execute", { runId: run.id }, { jobId: `retry-${run.id}`, removeOnComplete: true, removeOnFail: 100 })
      .catch(() => undefined);
  }

  // 2) 取消后进程丢失：CANCEL_REQUESTED 停滞（无 worker 推进）→ 完成取消归宿。
  const staleCancel = await prisma.run.findMany({
    where: {
      lifecycle: "CANCEL_REQUESTED",
      updatedAt: { lt: new Date(Date.now() - LEASE_STALE_MS) },
    },
    select: { id: true },
    take: 10,
  });
  for (const run of staleCancel) {
    await finalizeCancelledFromRequest(prisma, run.id, "取消后 worker 失联（对账完成取消）");
  }

  // 3) worker 失联：心跳超时的活跃运行 → CAS 置 ERROR（平台故障 ≠ 业务 FAIL），
  //    未完成 attempt 置 BLOCKED/ENVIRONMENT；事件走原子序号（R7）。
  const staleActive = await prisma.run.findMany({
    where: {
      lifecycle: { in: ["PREPARING", "RUNNING", "FINALIZING"] },
      updatedAt: { lt: new Date(Date.now() - LEASE_STALE_MS) },
    },
    select: { id: true },
    take: 10,
  });
  for (const run of staleActive) {
    await prisma.$transaction(async (tx) => {
      const cas = await tx.run.updateMany({
        where: { id: run.id, lifecycle: { in: ["PREPARING", "RUNNING", "FINALIZING"] },
          updatedAt: { lt: new Date(Date.now() - LEASE_STALE_MS) } },
        data: { lifecycle: "ERROR" },
      });
      if (cas.count === 0) return; // CAS 失败：状态已被他人迁移。
      await tx.caseAttempt.updateMany({
        where: { runId: run.id, lifecycle: { not: "FINISHED" } },
        data: {
          lifecycle: "FINISHED",
          verdict: "BLOCKED",
          reasonCode: "ENVIRONMENT",
          retryReason: "worker 租约丢失（心跳超时）",
          finishedAt: new Date(),
        },
      });
      await emitRunEvent(tx, run.id, "run.platform_error", {
        detail: "worker 心跳超时，运行进入 ERROR",
      });
    });
  }
}

const reconciler = setInterval(() => {
  void reconcile().catch((err) => console.error("[reconciler]", err.message));
}, RECONCILE_INTERVAL_MS);

// —— 健康服务 ——
const app = Fastify({ logger: { level: config.logLevel } });
app.get("/api/health", async () => ({
  ok: true,
  service: "worker",
  status: "ready",
  capabilities: { executor: true, queue: true },
}));

const port = config.port;
const host = config.host;
await app.listen({ port, host });
app.log.info(`worker ready on http://${host}:${port}`);

const shutdown = async () => {
  clearInterval(reconciler);
  await runWorker.close();
  await agentJobWorker.close();
  await seedWorker.close();
  await runsQueue.close();
  await agentJobsQueue.close();
  await seedQueue.close();
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
