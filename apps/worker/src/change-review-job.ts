import type { Prisma, PrismaClient } from "@prisma/client";
import type { ArtifactStore } from "@ai-qa/artifact-store";
import {
  ChangeReviewAnalysisInput,
  ChangeReviewAnalysisResponse,
} from "@ai-qa/contracts";
import {
  contentHash,
  loadReviewBundle,
  verifyReviewOutput,
} from "../../api/src/change-review-service.js";
import { callIntelligence } from "./intelligence-client.js";
import type { WorkerConfig } from "./config.js";
type Job = {
  id: string;
  projectId: string;
  request: unknown;
  startedAt: Date | null;
};
export async function runChangeReview(
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
  const review = await db.changeReview.findUniqueOrThrow({
    where: { jobId: job.id },
  });
  if (
    review.projectId !== job.projectId ||
    contentHash(review.input) !== review.inputHash
  )
    throw Object.assign(new Error("变更输入归属或校验和错误"), {
      code: "VALIDATION_ERROR",
    });
  const input = ChangeReviewAnalysisInput.parse(review.input);
  for (const side of ["oldBundle", "newBundle"] as const) {
    const loaded = await loadReviewBundle(
      db,
      store,
      job.projectId,
      input.comparison[side].documentVersionId,
    );
    if (contentHash(loaded.bundle) !== contentHash(input.comparison[side]))
      throw Object.assign(new Error("资料在排队期间发生变化，请重新分析"), {
        code: "CONFLICT",
      });
  }
  const remote = ChangeReviewAnalysisResponse.parse(
    await callIntelligence(
      { ...config, intelligenceTimeoutMs: 30000 },
      "changes",
      job.id,
      (job.request as { mode: "real" | "mock" }).mode,
      input,
    ),
  );
  if (remote.invocations.length)
    throw Object.assign(new Error("确定性分析不应调用模型"), {
      code: "MODEL_OUTPUT_INVALID",
    });
  const output = verifyReviewOutput(input, remote.output);
  await commit(db, job, async (tx) => {
    await tx.changeReview.update({
      where: { id: review.id },
      data: { output: output as never, outputHash: contentHash(output) },
    });
    await tx.job.update({
      where: { id: job.id },
      data: {
        status: "SUCCEEDED",
        result: { reviewId: review.id },
        finishedAt: new Date(),
      },
    });
  });
}
