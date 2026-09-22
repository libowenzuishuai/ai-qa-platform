import type { Prisma, PrismaClient } from "@prisma/client";

/** Sequence and event commit together under the workflow row lock. */
export async function emitWorkflowEvent(
  db: PrismaClient | Prisma.TransactionClient,
  workflowId: string,
  type: string,
  payload: unknown = {},
) {
  const write = async (tx: Prisma.TransactionClient) => {
    const row = await tx.workflowRun.update({
      where: { id: workflowId },
      data: { eventSeq: { increment: 1 } },
      select: { eventSeq: true },
    });
    await tx.workflowEvent.create({
      data: {
        workflowId,
        seq: row.eventSeq,
        type,
        payload: payload as Prisma.InputJsonValue,
      },
    });
    return row.eventSeq;
  };
  return "$transaction" in db ? db.$transaction(write) : write(db);
}

export async function cancelWorkflowChildren(
  tx: Prisma.TransactionClient,
  workflowId: string,
) {
  const nodes = await tx.workflowNode.findMany({ where: { workflowId } });
  const jobs: string[] = [];
  const runs: string[] = [], checks:string[]=[];
  for (const node of nodes) {
    const ref = (node.outputRef ?? {}) as { jobIds?: string[]; runId?: string; checkId?:string };
    jobs.push(...(ref.jobIds ?? []));
    if(ref.checkId)checks.push(ref.checkId);
    if (ref.runId) runs.push(ref.runId);
  }
  const parsing = await tx.job.findMany({
    where: {
      id: { in: jobs },
      kind: "DOCUMENT_PARSE",
      status: { in: ["QUEUED", "RUNNING"] },
    },
  });
  for (const job of parsing) {
    const id = (job.request as { documentVersionId?: string })
      .documentVersionId;
    if (id)
      await tx.documentVersion.updateMany({
        where: { id, parseStatus: { in: ["PENDING", "PARSING"] } },
        data: { parseStatus: "FAILED" },
      });
  }
  await tx.job.updateMany({
    where: { id: { in: jobs }, status: { in: ["QUEUED", "RUNNING"] } },
    data: { status: "CANCELLED", finishedAt: new Date() },
  });
  await tx.run.updateMany({
    where: {
      id: { in: runs },
      lifecycle: { in: ["QUEUED", "PREPARING", "RUNNING", "FINALIZING"] },
    },
    data: { lifecycle: "CANCEL_REQUESTED" },
  });
  await tx.codeCheck.updateMany({where:{id:{in:checks},status:"RUNNING"},data:{status:"CANCEL_REQUESTED"}});
  await tx.codeCheck.updateMany({where:{id:{in:checks},status:"QUEUED"},data:{status:"CANCELLED"}});
  await tx.workflowNode.updateMany({
    where: {
      workflowId,
      status: { in: ["queued", "running", "waiting_human"] },
    },
    data: {
      status: "failed",
      error: "工作流停止，未完成节点不再执行",
      finishedAt: new Date(),
    },
  });
}
