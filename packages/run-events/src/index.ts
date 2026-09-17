import { Prisma, type PrismaClient } from "@prisma/client";

/**
 * 运行事件与生命周期原语（评审 R2/R7）。
 *
 * - 事件序号：所有生产者（API 取消、worker 步骤、对账错误事件）通过
 *   `UPDATE "Run" SET "eventSeq" = "eventSeq" + 1 ... RETURNING` 原子取号，
 *   严格按数据库分配递增；禁止任何固定大数预留（9000/9998 之类）或吞冲突。
 * - 状态迁移：全部使用条件 UPDATE（CAS）。终态不可回退；持有过期状态的
 *   worker 无法覆盖数据库中的新状态（比较的是数据库当前值，不是内存旧值）。
 */

/** Run 生命周期状态机（与 contracts RUN_LIFECYCLE_TRANSITIONS 一致）。 */
export const RUN_LIFECYCLE_TRANSITIONS: Readonly<Record<string, string[]>> = {
  QUEUED: ["PREPARING", "CANCEL_REQUESTED", "ERROR"],
  PREPARING: ["RUNNING", "CANCEL_REQUESTED", "ERROR"],
  RUNNING: ["FINALIZING", "CANCEL_REQUESTED", "ERROR"],
  FINALIZING: ["FINISHED", "CANCEL_REQUESTED", "ERROR"],
  CANCEL_REQUESTED: ["CANCELLED", "ERROR"],
};

export const ACTIVE_LIFECYCLE = ["PREPARING", "RUNNING"] as const;
export const NON_TERMINAL_LIFECYCLE = [
  "QUEUED",
  "PREPARING",
  "RUNNING",
  "FINALIZING",
  "CANCEL_REQUESTED",
] as const;
export const TERMINAL_LIFECYCLE = ["FINISHED", "CANCELLED", "ERROR"] as const;

/**
 * 原子取号：返回该 run 的下一个事件序号。
 * 依赖 Run.eventSeq 列（迁移 005）。事务中可传入 tx。
 */
export async function allocateEventSeq(
  prisma: PrismaClient | Prisma.TransactionClient,
  runId: string,
): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ eventSeq: number }>>(
    Prisma.sql`UPDATE "Run" SET "eventSeq" = "eventSeq" + 1 WHERE "id" = ${runId} RETURNING "eventSeq"`,
  );
  if (!rows || rows.length === 0) {
    throw new Error(`运行 ${runId} 不存在，无法分配事件序号`);
  }
  return rows[0]!.eventSeq;
}

/**
 * 写入运行事件（原子序号）。事件写入失败必须上抛，不静默丢弃（R7）。
 */
export async function emitRunEvent(
  prisma: PrismaClient | Prisma.TransactionClient,
  runId: string,
  type: string,
  payload: Record<string, unknown> = {},
): Promise<number> {
  // 取号时持有 Run 行锁，直到事件也提交：高序号不能抢先可见。
  const write = async (tx: Prisma.TransactionClient) => {
    const seq = await allocateEventSeq(tx, runId);
    await tx.runEvent.create({
      data: { runId, seq, type, payload: payload as Prisma.InputJsonValue },
    });
    return seq;
  };
  return "$transaction" in prisma ? prisma.$transaction(write) : write(prisma);
}

/**
 * 条件状态迁移（CAS）：仅当数据库当前 lifecycle ∈ allowedFrom 时迁移到 to。
 * 返回是否成功。持有过期内存状态的调用者会得到 false，不会覆盖新状态。
 */
export async function casTransitionRun(
  prisma: PrismaClient | Prisma.TransactionClient,
  runId: string,
  allowedFrom: readonly string[],
  to: string,
): Promise<boolean> {
  // 校验迁移本身合法（任一 from → to 必须在状态机中）。
  for (const from of allowedFrom) {
    if ((RUN_LIFECYCLE_TRANSITIONS[from] ?? []).includes(to)) continue;
    throw new Error(`非法生命周期迁移：${from} → ${to}`);
  }
  const result = await prisma.run.updateMany({
    where: { id: runId, lifecycle: { in: [...allowedFrom] } },
    data: { lifecycle: to },
  });
  return result.count > 0;
}

/** 读取当前生命周期。 */
export async function currentLifecycle(
  prisma: PrismaClient,
  runId: string,
): Promise<string | null> {
  const run = await prisma.run.findUnique({ where: { id: runId }, select: { lifecycle: true } });
  return run?.lifecycle ?? null;
}

/** 运行是否仍处于可执行业务动作的状态（租约有效）。 */
export async function isRunActive(prisma: PrismaClient, runId: string): Promise<boolean> {
  const lifecycle = await currentLifecycle(prisma, runId);
  return lifecycle === "PREPARING" || lifecycle === "RUNNING";
}

/**
 * Redis URL 完整解析（评审 §三.1）：host/port/path(db)/username/password/TLS
 * 全部生效，而不只取 host/port。供 BullMQ connection 使用。
 */
export interface RedisConnection {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: boolean;
}

export function parseRedisConnection(url: string): RedisConnection {
  const parsed = new URL(url);
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new Error(`不支持的 Redis 协议：${parsed.protocol}`);
  }
  const dbRaw = parsed.pathname.replace(/^\//, "");
  if (dbRaw && (!/^\d+$/.test(dbRaw) || !Number.isSafeInteger(Number(dbRaw)))) {
    throw new Error("Redis 数据库号必须是非负安全整数");
  }
  const connection: RedisConnection = {
    host: parsed.hostname.replace(/^\[|\]$/g, "") || "127.0.0.1",
    port: Number(parsed.port || 6379),
  };
  if (parsed.username) connection.username = decodeURIComponent(parsed.username);
  if (parsed.password) connection.password = decodeURIComponent(parsed.password);
  if (dbRaw && /^\d+$/.test(dbRaw)) connection.db = Number(dbRaw);
  if (parsed.protocol === "rediss:") connection.tls = true;
  return connection;
}

/** CANCEL_REQUESTED → CANCELLED（R2）：在途 attempt 收尾 + 原子事件。 */
export async function finalizeCancelledFromRequest(
  prisma: PrismaClient,
  runId: string,
  reason: string,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const cancelled = await casTransitionRun(tx, runId, ["CANCEL_REQUESTED"], "CANCELLED");
    if (!cancelled) return false;
    await tx.caseAttempt.updateMany({
      where: { runId, lifecycle: { not: "FINISHED" } },
      data: {
        lifecycle: "FINISHED", verdict: "BLOCKED", reasonCode: "CANCELLED",
        retryReason: reason, finishedAt: new Date(),
      },
    });
    await emitRunEvent(tx, runId, "run.lifecycle", { lifecycle: "CANCELLED", runId, reason });
    await emitRunEvent(tx, runId, "run.done", { runId, lifecycle: "CANCELLED" });
    return true;
  });
}
