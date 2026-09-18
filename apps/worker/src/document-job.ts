import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { DocumentParseResponse } from "@ai-qa/contracts";
import type { ArtifactStore } from "@ai-qa/artifact-store";
import type { WorkerConfig } from "./config.js";
import { callIntelligence } from "./intelligence-client.js";

type Job = { id: string; projectId: string; request: unknown; startedAt: Date | null };
type Commit = (prisma: PrismaClient, job: Job, persist: (tx: Prisma.TransactionClient) => Promise<void>) => Promise<void>;
export async function markDocumentFailed(tx: Prisma.TransactionClient, job: { projectId: string; kind: string; request: unknown }) {
  if (job.kind !== "DOCUMENT_PARSE") return;
  const request = z.object({ documentVersionId: z.string() }).safeParse(job.request);
  if (request.success) await tx.documentVersion.updateMany({ where: { id: request.data.documentVersionId, document: { projectId: job.projectId }, parseStatus: { in: ["PENDING", "PARSING"] } }, data: { parseStatus: "FAILED" } });
}

export async function runDocumentParse(prisma: PrismaClient, store: ArtifactStore, job: Job, config: WorkerConfig, commit: Commit) {
  const request = z.object({ documentVersionId: z.string(), mode: z.enum(["real", "mock"]) }).parse(job.request);
  const document = await prisma.documentVersion.findUnique({ where: { id: request.documentVersionId }, include: { document: true } });
  if (!document || document.document.projectId !== job.projectId || !document.fileSizeBytes || document.mode !== request.mode) throw Object.assign(new Error("文档引用、大小或模式不合法"), { code: "VALIDATION_ERROR" });
  if (!store.verify(document.storageKey, document.checksum) || store.size(document.storageKey) !== document.fileSizeBytes) throw Object.assign(new Error("源文件缺失、大小或校验和不符"), { code: "VALIDATION_ERROR" });
  await commit(prisma, job, async tx => {
    await tx.documentVersion.update({ where: { id: document.id }, data: { parseStatus: "PARSING" } });
  });
  // Documents always use the production Python parser, independent of legacy agent backend.
  const remote = DocumentParseResponse.parse(await callIntelligence(config, "document", job.id, request.mode, {
    documentVersionId: document.id, format: document.format, storageKey: document.storageKey,
    checksum: document.checksum, fileSizeBytes: document.fileSizeBytes,
  }));
  const bundle = remote.output;
  if (bundle.documentVersionId !== document.id || !["PARSED", "NEEDS_OCR", "FAILED"].includes(bundle.parseStatus)) throw Object.assign(new Error("解析版本或终态不合法"), { code: "MODEL_OUTPUT_INVALID" });
  if (bundle.format !== document.format && !(["PDF_TEXT", "PDF_SCANNED"].includes(bundle.format) && ["PDF_TEXT", "PDF_SCANNED"].includes(document.format))) throw Object.assign(new Error("解析格式与源文件不匹配"), { code: "MODEL_OUTPUT_INVALID" });
  if (new Set(bundle.spans.map(s => s.id)).size !== bundle.spans.length || new Set(bundle.blocks.map(b => b.id)).size !== bundle.blocks.length || bundle.coverageSummary.totalBlocks !== bundle.blocks.length || bundle.spans.some(s => s.quotedText !== null && !bundle.blocks.some(b => b.text.includes(s.quotedText!))) || bundle.blocks.some(b => b.imageStorageKey && b.imageStorageKey !== document.storageKey)) throw Object.assign(new Error("解析 ID、来源引用、图片路径或覆盖统计不合法"), { code: "MODEL_OUTPUT_INVALID" });
  // Every lease has its own file. Only the DB pointer publishes it; stale workers cannot overwrite.
  const stored = store.put({ runId: "bundles", attemptId: document.id, filename: `bundle-${randomUUID()}.json`, data: Buffer.from(JSON.stringify(bundle)) });
  try {
    await commit(prisma, job, async tx => {
      await tx.sourceSpan.deleteMany({ where: { documentVersionId: document.id } });
      if (bundle.spans.length) await tx.sourceSpan.createMany({ data: bundle.spans.map(s => ({ ...s, locator: s.locator as never })) });
      await tx.documentVersion.update({ where: { id: document.id }, data: {
        parseStatus: bundle.parseStatus, format: bundle.format, parserVersion: bundle.parserVersion,
        coverageSummary: bundle.coverageSummary, parseWarnings: bundle.warnings,
        bundleStorageKey: stored.storageKey, bundleChecksum: stored.checksum,
      } });
      for (const invocation of remote.invocations) await tx.modelInvocation.create({ data: {
        projectId: job.projectId, provider: invocation.response.provider, model: invocation.response.model,
        promptVersion: invocation.promptVersion, requestId: invocation.response.requestId,
        usage: { ...invocation.response.usage, purpose: invocation.purpose },
        latencyMs: invocation.response.latencyMs, outcome: invocation.response.outcome,
      } });
      await tx.job.update({ where: { id: job.id }, data: {
        status: bundle.parseStatus === "FAILED" ? "FAILED" : "SUCCEEDED", finishedAt: new Date(),
        result: { documentId: document.documentId, documentVersionId: document.id, parseStatus: bundle.parseStatus,
          spanCounts: { good: bundle.coverageSummary.goodSpans, low: bundle.coverageSummary.lowSpans, unparsed: bundle.coverageSummary.unparsedSpans } },
        ...(bundle.parseStatus === "FAILED" ? { error: { code: "PARSE_FAILED", message: "解析失败，请查看文档警告", requestId: job.id } } : {}),
      } });
    });
  } catch (error) {
    // In an ambiguous commit failure, keep the file if the database already references it.
    const current = await prisma.documentVersion.findUnique({ where: { id: document.id } }).catch(() => null);
    if (current && current.bundleStorageKey !== stored.storageKey) rmSync(store.resolveSafe(stored.storageKey), { force: true });
    throw error;
  }
}
