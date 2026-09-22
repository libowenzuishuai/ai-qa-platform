import type { Prisma, PrismaClient } from "@prisma/client";
import type { ArtifactStore } from "@ai-qa/artifact-store";
import {
  ChunkingResponse,
  ParsedDocumentBundle,
  RuleExtractionInput,
  RuleExtractionOutput,
  validateRuleExtraction,
  ChunkManifest,
  canonicalStringify,
} from "@ai-qa/contracts";
import { createHash } from "node:crypto";

/** ChunkManifest.parse 的返回类型（契约只导出 schema 常量）。 */
type ChunkBundle = ReturnType<typeof ChunkManifest.parse>;
import { callIntelligence } from "./intelligence-client.js";
import type { WorkerConfig } from "./config.js";

/**
 * R03 持久化块处理：
 * - runDocumentChunk：调用 Python 确定性分块，清单与块行幂等落库
 *   （同一文档同一策略只允许一批块）；
 * - runChunkExtract：租约 CAS 认领（pending|failed → in_progress），构造
 *   块范围 bundle（span ID 不变），复用规则提取管线与联合校验，
 *   已完成块绝不重复调用；失败/租约过期显式恢复。
 */

type JobRow = { id: string; projectId: string; request: unknown; startedAt: Date | null };

const LEASE_MS = 10 * 60 * 1000;

const contentHash = (v: unknown) =>
  createHash("sha256").update(canonicalStringify(v)).digest("hex");

/** 清单内容哈希：排除服务端时间戳，同一策略+分块结果必然同哈希。 */
function manifestHash(manifest: unknown): string {
  const m = manifest as { strategyParams?: unknown; chunks?: unknown; documentVersionId?: unknown; documentChecksum?: unknown; strategyVersion?: unknown; totalCodePoints?: unknown };
  return contentHash({
    documentVersionId: m.documentVersionId,
    documentChecksum: m.documentChecksum,
    strategyVersion: m.strategyVersion,
    strategyParams: m.strategyParams,
    totalCodePoints: m.totalCodePoints,
    chunks: m.chunks,
  });
}

async function loadBundle(
  prisma: PrismaClient,
  store: ArtifactStore,
  projectId: string,
  documentVersionId: string,
): Promise<{ row: { checksum: string; parseStatus: string; bundleStorageKey: string | null; bundleChecksum: string | null; document: { projectId: string } }; bundle: ParsedDocumentBundle }> {
  const row = await prisma.documentVersion.findUnique({
    where: { id: documentVersionId },
    include: { document: { select: { projectId: true } } },
  });
  if (!row || row.document.projectId !== projectId)
    throw Object.assign(new Error("文档版本不存在或不属于本项目"), { code: "VALIDATION_ERROR" });
  if (row.parseStatus !== "PARSED")
    throw Object.assign(new Error("分块要求文档已完整解析（PARSED）"), { code: "VALIDATION_ERROR" });
  if (!row.bundleStorageKey || !row.bundleChecksum || !store.verify(row.bundleStorageKey, row.bundleChecksum))
    throw Object.assign(new Error("解析产物缺失或被篡改"), { code: "VALIDATION_ERROR" });
  const bundle = ParsedDocumentBundle.parse(
    JSON.parse(store.read(row.bundleStorageKey).toString("utf8")),
  );
  if (bundle.documentVersionId !== documentVersionId)
    throw Object.assign(new Error("解析版本引用不匹配"), { code: "VALIDATION_ERROR" });
  return { row, bundle };
}

export async function runDocumentChunk(
  prisma: PrismaClient,
  store: ArtifactStore,
  job: JobRow,
  config: WorkerConfig,
  commit: (
    prisma: PrismaClient,
    job: JobRow,
    persist: (tx: Prisma.TransactionClient) => Promise<void>,
  ) => Promise<void>,
) {
  const request = job.request as {
    documentVersionId: string;
    strategyParams: { maxCharsPerChunk: number; contextOverlapChars: number; modelBudgetChars: number };
    mode: "real" | "mock";
  };
  const { row, bundle } = await loadBundle(prisma, store, job.projectId, request.documentVersionId);
  const remote = ChunkingResponse.parse(
    await callIntelligence(
      { ...config, intelligenceTimeoutMs: 30000 },
      "chunk",
      job.id,
      request.mode,
      {
        bundle,
        documentChecksum: row.checksum,
        strategyParams: request.strategyParams,
      },
    ),
  );
  if (remote.invocations.length)
    throw Object.assign(new Error("确定性分块不应调用模型"), { code: "MODEL_OUTPUT_INVALID" });
  const manifest = ChunkManifest.parse(remote.output.manifest);
  if (manifest.documentVersionId !== request.documentVersionId)
    throw Object.assign(new Error("清单文档版本不匹配"), { code: "MODEL_OUTPUT_INVALID" });
  const hash = manifestHash(manifest);
  await commit(prisma, job, async (tx) => {
    const existing = await tx.documentVersion.findUnique({
      where: { id: request.documentVersionId },
      select: { chunkManifestHash: true },
    });
    if (existing?.chunkManifestHash === hash) {
      await tx.job.update({
        where: { id: job.id },
        data: { status: "SUCCEEDED", result: { documentVersionId: request.documentVersionId, manifestHash: hash, chunkCount: manifest.chunks.length }, finishedAt: new Date() },
      });
      return; // 幂等：同一清单不重写。
    }
    await tx.documentVersion.update({
      where: { id: request.documentVersionId },
      data: { chunkManifest: manifest as never, chunkManifestHash: hash },
    });
    await tx.documentChunk.createMany({
      data: manifest.chunks.map((chunk) => ({
        documentVersionId: request.documentVersionId,
        manifestHash: hash,
        chunkId: chunk.chunkId,
        seq: chunk.seq,
        status: "pending",
      })),
      skipDuplicates: true,
    });
    await tx.job.update({
      where: { id: job.id },
      data: { status: "SUCCEEDED", result: { documentVersionId: request.documentVersionId, manifestHash: hash, chunkCount: manifest.chunks.length }, finishedAt: new Date() },
    });
  });
}

/** 构造块范围 bundle：span 引用保持原 ID；切片引用携带包含 span。 */
function buildChunkBundle(manifest: ChunkBundle, chunkId: string, whole: ParsedDocumentBundle): ParsedDocumentBundle {
  const chunk = manifest.chunks.find((c) => c.chunkId === chunkId);
  if (!chunk) throw Object.assign(new Error(`清单中不存在块 ${chunkId}`), { code: "VALIDATION_ERROR" });
  const neededSpans = new Set<string>();
  for (const ref of chunk.spanRefs) {
    if (ref.type === "span") neededSpans.add(ref.spanId);
    else neededSpans.add(ref.slice.sourceSpanId);
  }
  const spans = whole.spans.filter((s) => neededSpans.has(s.id));
  if (spans.length !== neededSpans.size)
    throw Object.assign(new Error("块引用的 span 不在解析产物中"), { code: "VALIDATION_ERROR" });
  const spanIds = new Set(spans.map((s) => s.id));
  // blocks 与 spans 同序生成（bundle.add 语义：block i ↔ span i）。
  const blocks = whole.blocks.filter((_, index) => spanIds.has(whole.spans[index]!.id));
  const good = spans.filter((s) => s.extractionQuality === "GOOD").length;
  const low = spans.filter((s) => s.extractionQuality === "LOW").length;
  const unparsed = spans.filter((s) => s.extractionQuality === "UNPARSED").length;
  return ParsedDocumentBundle.parse({
    ...whole,
    blocks,
    spans,
    warnings: [...whole.warnings, `块范围提取（chunk ${chunk.seq}，共 ${manifest.chunks.length} 块）`],
    coverageSummary: {
      totalBlocks: blocks.length,
      goodSpans: good,
      lowSpans: low,
      unparsedSpans: unparsed,
    },
  });
}

export async function runChunkExtract(
  prisma: PrismaClient,
  store: ArtifactStore,
  job: JobRow,
  config: WorkerConfig,
  commit: (
    prisma: PrismaClient,
    job: JobRow,
    persist: (tx: Prisma.TransactionClient) => Promise<void>,
  ) => Promise<void>,
) {
  const request = job.request as { chunkRowId: string; mode: "real" | "mock" };
  // 显式恢复：租约过期的 in_progress 块回到 failed（带原因），允许重新认领。
  await prisma.documentChunk.updateMany({
    where: { status: "in_progress", leaseExpiresAt: { lt: new Date() } },
    data: { status: "failed" },
  });
  const row = await prisma.documentChunk.findUnique({ where: { id: request.chunkRowId } });
  if (!row)
    throw Object.assign(new Error("块记录不存在"), { code: "VALIDATION_ERROR" });
  const docVersion = await prisma.documentVersion.findUnique({
    where: { id: row.documentVersionId },
    include: { document: { select: { projectId: true } } },
  });
  if (!docVersion || docVersion.document.projectId !== job.projectId)
    throw Object.assign(new Error("块不属于本项目"), { code: "VALIDATION_ERROR" });
  // 租约 CAS：仅 pending|failed 可认领；completed 绝不重复调用。
  const claimed = await prisma.documentChunk.updateMany({
    where: { id: row.id, status: { in: ["pending", "failed"] } },
    data: { status: "in_progress", attempts: { increment: 1 }, leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
  });
  if (claimed.count === 0) {
    const current = await prisma.documentChunk.findUniqueOrThrow({ where: { id: row.id } });
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "SUCCEEDED", result: { chunkRowId: row.id, chunkId: row.chunkId, status: current.status }, finishedAt: new Date() },
    });
    return; // 已完成或他人持有租约：不重复执行。
  }
  try {
    if (!docVersion.chunkManifest || docVersion.chunkManifestHash !== row.manifestHash)
      throw Object.assign(new Error("清单缺失或与块记录不一致"), { code: "CONFLICT" });
    const manifest: ChunkBundle = ChunkManifest.parse(docVersion.chunkManifest);
    const { bundle: whole } = await loadBundle(prisma, store, job.projectId, row.documentVersionId);
    const chunkBundle = buildChunkBundle(manifest, row.chunkId, whole);
    const input = RuleExtractionInput.parse({
      projectGlossary: [],
      documentVersions: [chunkBundle],
      images: [],
      promptVersion: "agents-v2",
    });
    const remote = await callIntelligence({ ...config, intelligenceTimeoutMs: 120000 }, "rules", job.id, request.mode, input);
    const output = RuleExtractionOutput.parse(remote.output);
    // 联合校验：引用必须来自块范围（span ID 不变 → 越界引用在此拦截）。
    const validation = validateRuleExtraction(input, output);
    if (!validation.ok)
      throw Object.assign(new Error("块提取输出未通过联合校验"), {
        code: "MODEL_OUTPUT_INVALID",
        details: { problems: validation.problems.slice(0, 10) },
      });
    const committed = await prisma.documentChunk.updateMany({
      where: { id: row.id, status: "in_progress" },
      data: { status: "completed", output: output as never, outputHash: contentHash(output), leaseExpiresAt: null },
    });
    if (committed.count === 0)
      throw Object.assign(new Error("块租约已失效，拒绝提交"), { code: "CONFLICT" });
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "SUCCEEDED", result: { chunkRowId: row.id, chunkId: row.chunkId, status: "completed" }, finishedAt: new Date() },
    });
  } catch (error) {
    // 失败显式落状态（保留 attempts 与租约现场），再向上抛给作业失败处理。
    await prisma.documentChunk.updateMany({
      where: { id: row.id, status: "in_progress" },
      data: { status: "failed", leaseExpiresAt: null },
    });
    throw error;
  }
}
