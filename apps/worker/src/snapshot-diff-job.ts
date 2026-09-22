import type { Prisma, PrismaClient } from "@prisma/client";
import type { ArtifactStore } from "@ai-qa/artifact-store";
import {
  SnapshotDiffInput,
  SnapshotCompareResponse,
} from "@ai-qa/contracts";
import { contentHash, loadReviewBundle } from "../../api/src/change-review-service.js";
import { validateSnapshotOutput, freezeSnapshotInput } from "../../api/src/snapshot-service.js";
import { callIntelligence } from "./intelligence-client.js";
import type { WorkerConfig } from "./config.js";

type Job = {
  id: string;
  projectId: string;
  request: unknown;
  startedAt: Date | null;
};

/**
 * R02 快照对比作业：调用 Python 确定性 compare_files，产出 MultiFileChangeReport。
 * 与 change-review-job 同款防线：排队期间资料被换（校验和变化）→ 拒绝；
 * 确定性分析不得产生模型调用记录；输出过契约校验后才落库。
 */
export async function runSnapshotDiff(
  db: PrismaClient,
  store: ArtifactStore,
  job: Job,
  config: WorkerConfig,
  commit: (
    db: PrismaClient,
    job: Job,
    persist: (tx: Prisma.TransactionClient) => Promise<void>,
  ) => Promise<void>,
) {
  const change = await db.snapshotChange.findUniqueOrThrow({
    where: { jobId: job.id },
  });
  if (
    change.projectId !== job.projectId ||
    contentHash(change.input) !== change.inputHash
  )
    throw Object.assign(new Error("快照输入归属或校验和错误"), {
      code: "VALIDATION_ERROR",
    });
  const input = SnapshotDiffInput.parse(change.input);
  const current = await freezeSnapshotInput(db,store,job.projectId,input.oldSnapshot.snapshotId,input.newSnapshot.snapshotId);
  if(contentHash(current.input)!==change.inputHash)throw Object.assign(new Error("资料在排队期间发生变化，请重新对比"),{code:"CONFLICT"});
  const remote = SnapshotCompareResponse.parse(
    await callIntelligence(
      { ...config, intelligenceTimeoutMs: 30000 },
      "snapshot",
      job.id,
      (job.request as { mode: "real" | "mock" }).mode,
      input,
    ),
  );
  // 快照对比是确定性分析：任何模型调用记录都意味着拿错了通道。
  if (remote.invocations.length)
    throw Object.assign(new Error("确定性对比不应调用模型"), {
      code: "MODEL_OUTPUT_INVALID",
    });
  // 评审修复（#4）：输出与冻结输入联合校验（路径归属/方向性/renamed 字节证据/
  // totals/排除回显），Python 无 DB 权威，落库前必须通过。
  const output = validateSnapshotOutput(input, remote.output);
  await commit(db, job, async (tx) => {
    await tx.snapshotChange.update({
      where: { id: change.id },
      data: { output: output as never, outputHash: contentHash(output) },
    });
    await tx.job.update({
      where: { id: job.id },
      data: {
        status: "SUCCEEDED",
        result: { snapshotChangeId: change.id },
        finishedAt: new Date(),
      },
    });
  });
}
