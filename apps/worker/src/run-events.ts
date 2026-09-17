import type { PrismaClient, Run } from "@prisma/client";

/**
 * 运行事件写入器：RunEvent 是 SSE 的唯一事实来源。
 * seq 在 run 内单调递增；并发写入由 (runId, seq) 唯一约束兜底。
 */
export class RunEventWriter {
  private seq: number;

  private constructor(private readonly prisma: PrismaClient, private readonly runId: string, startSeq: number) {
    this.seq = startSeq;
  }

  static async open(prisma: PrismaClient, runId: string): Promise<RunEventWriter> {
    const last = await prisma.runEvent.findFirst({
      where: { runId },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    return new RunEventWriter(prisma, runId, (last?.seq ?? 0) + 1);
  }

  async emit(type: string, payload: Record<string, unknown> = {}): Promise<void> {
    const seq = this.seq++;
    await this.prisma.runEvent.create({
      data: { runId: this.runId, seq, type, payload: payload as object },
    }).catch(async (err) => {
      // 唯一冲突（重复消费）时跳过：以数据库现有事件为准。
      if (/Unique constraint/i.test(String(err))) return;
      throw err;
    });
  }
}

/** 生命周期迁移 + 事件（受 contracts 状态机约束）。 */
export const RUN_LIFECYCLE_TRANSITIONS: Record<string, string[]> = {
  QUEUED: ["PREPARING", "CANCEL_REQUESTED", "ERROR"],
  PREPARING: ["RUNNING", "CANCEL_REQUESTED", "ERROR"],
  RUNNING: ["FINALIZING", "CANCEL_REQUESTED", "ERROR"],
  FINALIZING: ["FINISHED", "CANCEL_REQUESTED", "ERROR"],
  CANCEL_REQUESTED: ["CANCELLED", "ERROR"],
};

export async function transitionRun(
  prisma: PrismaClient,
  run: Run,
  to: string,
): Promise<Run> {
  const from = run.lifecycle;
  const allowed = RUN_LIFECYCLE_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`非法生命周期迁移：${from} → ${to}`);
  }
  const updated = await prisma.run.update({ where: { id: run.id }, data: { lifecycle: to } });
  return updated;
}
