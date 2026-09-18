import type { ParsedDocumentBundle } from "@ai-qa/contracts";
import type { ArtifactStore } from "@ai-qa/artifact-store";

/** 与 apps/worker agent-job-processor bundleStorageKey 一致。 */
export function bundleStorageKey(documentVersionId: string): string {
  return `bundles/${documentVersionId}/bundle.json`;
}

/**
 * 将 bundle 写入 artifact-store。
 * 复用 runId=bundles / attemptId=documentVersionId 约定（与 worker 测试一致）。
 */
export function writeBundle(store: ArtifactStore, bundle: ParsedDocumentBundle): string {
  const key = bundleStorageKey(bundle.documentVersionId);
  store.put({
    runId: "bundles",
    attemptId: bundle.documentVersionId,
    filename: "bundle.json",
    data: Buffer.from(JSON.stringify(bundle)),
  });
  return key;
}
