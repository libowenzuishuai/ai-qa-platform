import Fastify from "fastify";
import { PrismaClient } from "@prisma/client";
import { Queue, Worker as BullWorker } from "bullmq";
import { emitRunEvent, parseRedisConnection } from "@ai-qa/run-events";
import { loadConfig } from "./config.js";
import { processRun } from "./run-processor.js";
import { finalizeCancelledFromRequest } from "@ai-qa/run-events";
import { seedFixedAssets } from "./seed-processor.js";

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

const runWorker = new BullWorker(
  "runs",
  async (job) => {
    if (job.name === "execute") {
      await processRun(prisma, config, String(job.data.runId));
    }
  },
  { connection, concurrency: 2 },
);

const seedWorker = new BullWorker(
  "seed-fixed-assets",
  async (job) => {
    await seedFixedAssets(prisma, config, String(job.data.projectId), String(job.data.environmentId));
  },
  { connection, concurrency: 1 },
);

for (const w of [runWorker, seedWorker]) {
  w.on("failed", (job, err) => {
    console.error(`[queue:${w.name}] job ${job?.id} 失败:`, err.message);
  });
}

// —— 对账循环 ——
const RECONCILE_INTERVAL_MS = 15_000;
const QUEUED_RETRY_AFTER_MS = 10_000;
const LEASE_STALE_MS = 90_000;

async function reconcile(): Promise<void> {
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
    const cas = await prisma.run.updateMany({
      where: { id: run.id, lifecycle: { in: ["PREPARING", "RUNNING", "FINALIZING"] } },
      data: { lifecycle: "ERROR" },
    });
    if (cas.count === 0) continue; // CAS 失败：状态已被他人迁移。
    await prisma.caseAttempt.updateMany({
      where: { runId: run.id, lifecycle: { not: "FINISHED" } },
      data: {
        lifecycle: "FINISHED",
        verdict: "BLOCKED",
        reasonCode: "ENVIRONMENT",
        retryReason: "worker 租约丢失（心跳超时）",
        finishedAt: new Date(),
      },
    });
    await emitRunEvent(prisma, run.id, "run.platform_error", {
      detail: "worker 心跳超时，运行进入 ERROR",
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
  await seedWorker.close();
  await runsQueue.close();
  await seedQueue.close();
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
