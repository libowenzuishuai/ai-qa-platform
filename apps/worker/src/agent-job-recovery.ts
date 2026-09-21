import { markDocumentFailed } from "./document-job.js";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";

export const AGENT_JOB_STALE_MS = 90_000;

/** QUEUED 补投；RUNNING 失联明确失败，避免自动重复计费。 */
export async function reconcileAgentJobs(prisma: PrismaClient, queue: Pick<Queue, "add">): Promise<void> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - AGENT_JOB_STALE_MS);
  const stale = await prisma.job.findMany({
    where: { status: "RUNNING", updatedAt: { lt: staleBefore } }, select: { id: true, projectId: true, kind: true, request: true }, take: 50,
  });
  for (const job of stale) {
    await prisma.$transaction(async tx => {
    const changed = await tx.job.updateMany({
      where: { id: job.id, status: "RUNNING", updatedAt: { lt: staleBefore } },
      data: {
        status: "FAILED", finishedAt: now,
        error: { code: "DEPENDENCY_UNAVAILABLE", message: "作业执行进程失联，请检查 worker 后重新发起", requestId: job.id },
      },
    });
    if (changed.count) {
      await markDocumentFailed(tx, job);
      if(job.kind==='LOGIN_CHECK')await tx.loginPreparation.updateMany({where:{lastCheckJobId:job.id},data:{lastCheckStatus:'ERROR',lastCheckAt:null,lastCheckDetail:'检查进程失联，需重新检查'}});
    }
    });
  }
  await prisma.dataResource.updateMany({where:{status:{in:['pending','cleaning']},updatedAt:{lt:staleBefore}},data:{status:'unknown',detail:'执行失联，必须先核对资源，未重放写入'}});
  const pending = await prisma.job.findMany({
    where: { status: "QUEUED", updatedAt: { lt: new Date(now.getTime() - 10_000) } },
    orderBy: { updatedAt: "asc" }, select: { id: true }, take: 20,
  });
  for (const job of pending) {
    try {
      // 新投递 ID 不受旧 BullMQ failed/completed 记录阻挡；DB CAS 保证只认领一次。
      await queue.add("run", { jobId: job.id }, {
        jobId: `recover-${job.id}-${randomUUID()}`, removeOnComplete: true, removeOnFail: 200,
      });
      await prisma.job.updateMany({ where: { id: job.id, status: "QUEUED" }, data: { updatedAt: now } });
    } catch {
      // 保留 QUEUED 和原时间，下次对账重试；不影响其它作业失联收敛。
    }
  }
}
