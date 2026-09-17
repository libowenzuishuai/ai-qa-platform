import type { PrismaClient } from "@prisma/client";
import { ArtifactStore } from "@ai-qa/artifact-store";
import type { EvidenceSink } from "@ai-qa/test-runtime";

/**
 * 执行器证据落盘 + Artifact 元数据入库。
 * 本次 attempt 的证据必须归属当前 run/attempt（PRD FR-09）。
 */
export function createArtifactSink(
  prisma: PrismaClient,
  store: ArtifactStore,
  projectId: string,
  runId: string,
  attemptId: string,
): EvidenceSink {
  return {
    save: async (kind, filename, data, opts) => {
      const stored = store.put({ runId, attemptId, filename, data });
      const artifact = await prisma.artifact.create({
        data: {
          projectId,
          attemptId,
          storageKey: stored.storageKey,
          type: kind,
          sensitivity: opts.sensitivity,
          checksum: stored.checksum,
        },
        select: { id: true },
      });
      return { artifactId: artifact.id };
    },
  };
}
