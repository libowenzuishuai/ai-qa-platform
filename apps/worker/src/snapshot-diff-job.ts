import type { Prisma, PrismaClient } from "@prisma/client";
import type { ArtifactStore } from "@ai-qa/artifact-store";
import {
  MultiFileComparisonInput,
  MultiFileChangeReport,
  SnapshotCompareResponse,
} from "@ai-qa/contracts";
import { contentHash, loadReviewBundle } from "../../api/src/change-review-service.js";
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
  const input = MultiFileComparisonInput.parse(change.input);
  // 排队期间资料被替换/重解析 → 拒绝执行（不能拿旧冻结输入对新资料下结论）。
  for (const side of ["oldFiles", "newFiles"] as const) {
    for (const entry of input[side]) {
      const loaded = await loadReviewBundle(
        db,
        store,
        job.projectId,
        entry.bundle.documentVersionId,
      );
      if (contentHash(loaded.bundle) !== contentHash(entry.bundle))
        throw Object.assign(new Error("资料在排队期间发生变化，请重新对比"), {
          code: "CONFLICT",
        });
    }
  }
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
  // 服务端二次校验（Python 无 DB 权威）：契约 + 覆盖对账在 superRefine 内完成。
  const output = MultiFileChangeReport.parse(remote.output);
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
