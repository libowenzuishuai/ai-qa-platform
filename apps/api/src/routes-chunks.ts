import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import { z } from "zod";
import { createHash } from "node:crypto";
import { ChunkManifest, RuleExtractionOutput, chunkManifestPayload, ChunkProcessingBudget, ChunkBudgetState } from "@ai-qa/contracts";
import { loadCompletedChunks } from "./chunk-results.js";
import { contentHash } from "./change-review-service.js";
import { requireAuth, requireProjectAccess } from "./auth.js";
import { ApiError } from "./errors.js";
import { chunkCoverage, mergeChunkExtractions } from "./chunk-merge.js";

/**
 * R03 块处理 API：
 * - POST …/chunks        → DOCUMENT_CHUNK 作业（Python 确定性分块 + 清单/块行落库，幂等）
 * - GET  …/chunks        → 清单 + 每块状态 + 覆盖对账（部分完成只可审阅）
 * - POST …/chunks/:chunkId/extract → CHUNK_EXTRACT 作业（租约 CAS；完成块不可重复）
 * - POST …/chunks/merge  → 完成门（全部 completed）后确定性跨块合并
 */

export function registerChunkRoutes(
  app: FastifyInstance,
  db: PrismaClient,
  queue: Pick<Queue, "add">,
) {
  const param = (req: FastifyRequest, key: string) =>
    (req.params as Record<string, string>)[key]!;

  async function ownedDocument(req: FastifyRequest, write: "LEAD" | "VIEWER") {
    const projectId = param(req, "id");
    const versionId = param(req, "versionId");
    await requireProjectAccess(db, req, projectId, write);
    const doc = await db.documentVersion.findUnique({
      where: { id: versionId },
      include: { document: { select: { projectId: true } } },
    });
    if (!doc || doc.document.projectId !== projectId)
      throw new ApiError("NOT_FOUND", "文档版本不存在或不属于本项目");
    return doc;
  }

  app.put('/api/projects/:id/documents/:versionId/chunks/budget',async req=>{
    const doc=await ownedDocument(req,'LEAD');
    const body=z.object({limits:ChunkProcessingBudget,mode:z.enum(['real','mock'])}).strict().parse(req.body);
    if(body.mode==='real'&&doc.mode!=='real')throw new ApiError('VALIDATION_ERROR','模拟资料不能用于真实提取');
    return db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM "DocumentVersion" WHERE id=${doc.id} FOR UPDATE`;
      const fresh=await tx.documentVersion.findUniqueOrThrow({where:{id:doc.id}});
      const old=fresh.chunkBudget?ChunkBudgetState.parse(fresh.chunkBudget):null;
      if(old && old.mode!==body.mode)throw new ApiError('CONFLICT','同一资料版本的提取模式不能混用');
      if(old && (body.limits.maxModelCalls<old.usedCalls||body.limits.maxReservedTokens<old.reservedTokens))throw new ApiError('CONFLICT','预算不能低于已保留的调用额度');
      const budget=ChunkBudgetState.parse({limits:body.limits,usedCalls:old?.usedCalls??0,reservedTokens:old?.reservedTokens??0,deadline:new Date(Date.now()+body.limits.maxWallClockMs).toISOString(),mode:body.mode,updatedBy:requireAuth(req).userId});
      await tx.documentVersion.update({where:{id:doc.id},data:{chunkBudget:budget}});
      await tx.auditEvent.create({data:{actorId:requireAuth(req).userId,action:'chunk.budget',entityType:'DocumentVersion',entityId:doc.id,metadata:{before:old,after:budget} as never}});
      return {budget};
    });
  });
  app.post('/api/projects/:id/documents/:versionId/chunks/process',async(req,reply)=>{
    const doc=await ownedDocument(req,'LEAD');
    const body=z.object({idempotencyKey:z.string().min(8).max(200)}).strict().parse(req.body);
    if(!doc.chunkManifestHash||!doc.chunkBudget)throw new ApiError('CONFLICT','先创建分块清单并设置全文预算');
    const budget=ChunkBudgetState.parse(doc.chunkBudget);
    if(Date.parse(budget.deadline)<=Date.now())throw new ApiError('BUDGET_EXCEEDED','全文预算已到期，请明确延长预算');
    const fingerprint=contentHash({documentVersionId:doc.id,manifestHash:doc.chunkManifestHash,idempotencyKey:body.idempotencyKey});
    const job=await db.job.upsert({where:{projectId_kind_fingerprint:{projectId:doc.document.projectId,kind:'CHUNK_BATCH',fingerprint}},create:{projectId:doc.document.projectId,kind:'CHUNK_BATCH',fingerprint,request:{documentVersionId:doc.id,manifestHash:doc.chunkManifestHash,mode:budget.mode}},update:{}});
    if(job.status==='QUEUED')try{await queue.add('run',{jobId:job.id},{removeOnComplete:true,removeOnFail:200});}catch{/* durable reconciliation */}
    return reply.code(202).send({jobId:job.id});
  });

  app.post("/api/projects/:id/documents/:versionId/chunks", async (req, reply) => {
    const doc = await ownedDocument(req, "LEAD");
    const body = z
      .object({
        strategyParams: z.object({
          maxCharsPerChunk: z.number().int().min(500).max(50_000),
          contextOverlapChars: z.number().int().min(0).max(5_000),
          modelBudgetChars: z.number().int().min(1_000).max(200_000),
        }),
        mode: z.enum(["real", "mock"]).default("mock"),
        idempotencyKey: z.string().min(8).max(200),
      })
      .strict()
      .parse(req.body);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ kind: "DOCUMENT_CHUNK", versionId: doc.id, params: body.strategyParams }))
      .digest("hex");
    const saved = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${doc.document.projectId} FOR UPDATE`;
      const existing = await tx.job.findUnique({
        where: {
          projectId_kind_fingerprint: {
            projectId: doc.document.projectId,
            kind: "DOCUMENT_CHUNK",
            fingerprint,
          },
        },
      });
      if (existing) return { job: existing, existed: true };
      const job = await tx.job.create({
        data: {
          projectId: doc.document.projectId,
          kind: "DOCUMENT_CHUNK",
          fingerprint,
          request: { ...body, documentVersionId: doc.id } as never,
        },
      });
      return { job, existed: false };
    });
    if (saved.job.status === "QUEUED")
      try {
        await queue.add("run", { jobId: saved.job.id }, { removeOnComplete: true, removeOnFail: 200 });
      } catch { /* 对账补投 */ }
    return reply.code(saved.existed ? 200 : 202).send({ jobId: saved.job.id, existed: saved.existed });
  });

  app.get("/api/projects/:id/documents/:versionId/chunks", async (req) => {
    const doc = await ownedDocument(req, "VIEWER");
    if (!doc.chunkManifest || !doc.chunkManifestHash)
      return { manifest: null, chunks: [], coverage: { complete: false, note: "尚未分块" } };
    const manifest = ChunkManifest.parse(doc.chunkManifest);
    if(contentHash(chunkManifestPayload(manifest))!==doc.chunkManifestHash)throw new ApiError("CONFLICT","分块清单校验和不符");
    const rows = await db.documentChunk.findMany({
      where: { documentVersionId: doc.id, manifestHash: doc.chunkManifestHash },
      orderBy: { seq: "asc" },
      select: { chunkId: true, seq: true, status: true, attempts: true, leaseExpiresAt: true, outputHash: true, updatedAt: true },
    });
    const coverage = chunkCoverage(
      manifest.chunks.map((c) => ({ chunkId: c.chunkId, seq: c.seq })),
      rows,
    );
    return {
      manifest: {
        strategyVersion: manifest.strategyVersion,
        strategyParams: manifest.strategyParams,
        totalCodePoints: manifest.totalCodePoints,
        chunkCount: manifest.chunks.length,
        manifestHash: doc.chunkManifestHash,
      },
      chunks: rows,
      budget:doc.chunkBudget,
      coverage: {
        ...coverage,
        note: coverage.complete
          ? "全部块已完成，可合并"
          : `完成 ${coverage.processed.length}/${manifest.chunks.length}；部分结果仅可审阅，不能发布为完整提取`,
      },
    };
  });

  app.post("/api/projects/:id/documents/:versionId/chunks/:chunkId/extract", async (req, reply) => {
    const doc = await ownedDocument(req, "LEAD");
    const body = z
      .object({ mode: z.enum(["real", "mock"]).default("mock"), idempotencyKey: z.string().min(8).max(200) })
      .strict()
      .parse(req.body);
    const row = await db.documentChunk.findFirst({
      where: { documentVersionId: doc.id, manifestHash:doc.chunkManifestHash??"", chunkId: param(req, "chunkId") },
      orderBy: { createdAt: "desc" },
    });
    if (!row) throw new ApiError("NOT_FOUND", "块不存在（请先分块）");
    if (row.status === "completed")
      throw new ApiError("CONFLICT", "已完成的块不会重复调用模型");
    if (row.status === "in_progress" && row.leaseExpiresAt && row.leaseExpiresAt > new Date())throw new ApiError("CONFLICT","块正在处理中，请等待或取消");
    if(body.mode === "real" && doc.mode !== "real")throw new ApiError("VALIDATION_ERROR","模拟解析不能用于真实提取");
    // 失败后重试：attempts 变化允许新指纹；同参数重复提交幂等返回。
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ kind: "CHUNK_EXTRACT", chunkRowId: row.id, idempotencyKey:body.idempotencyKey, mode: body.mode }))
      .digest("hex");
    const saved = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${doc.document.projectId} FOR UPDATE`;
      const existing = await tx.job.findUnique({
        where: {
          projectId_kind_fingerprint: {
            projectId: doc.document.projectId,
            kind: "CHUNK_EXTRACT",
            fingerprint,
          },
        },
      });
      if (existing) return { job: existing, existed: true };
      const job = await tx.job.create({
        data: {
          projectId: doc.document.projectId,
          kind: "CHUNK_EXTRACT",
          fingerprint,
          request: { chunkRowId: row.id, mode: body.mode } as never,
        },
      });
      return { job, existed: false };
    });
    if (saved.job.status === "QUEUED")
      try {
        await queue.add("run", { jobId: saved.job.id }, { removeOnComplete: true, removeOnFail: 200 });
      } catch { /* 对账补投 */ }
    return reply.code(saved.existed ? 200 : 202).send({ jobId: saved.job.id, existed: saved.existed });
  });

  app.post("/api/projects/:id/documents/:versionId/chunks/drafts",async(req,reply)=>{
    const doc=await ownedDocument(req,"LEAD");
    if(!doc.chunkManifestHash)throw new ApiError("CONFLICT","请先完成分块提取");
    const result=await loadCompletedChunks(db,doc.document.projectId,doc.id,doc.chunkManifestHash);
    const fingerprint=contentHash({documentVersionId:doc.id,completedChunkManifestHash:doc.chunkManifestHash,mode:result.mode});
    const job=await db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${doc.document.projectId} FOR UPDATE`;
      return tx.job.upsert({where:{projectId_kind_fingerprint:{projectId:doc.document.projectId,kind:'RULE_EXTRACTION',fingerprint}},create:{projectId:doc.document.projectId,kind:'RULE_EXTRACTION',fingerprint,request:{documentVersionIds:[doc.id],completedChunkManifestHash:doc.chunkManifestHash,mode:result.mode}},update:{}});
    });
    if(job.status==='QUEUED')try{await queue.add('run',{jobId:job.id},{removeOnComplete:true,removeOnFail:200});}catch{/* reconciliation */}
    return reply.code(202).send({jobId:job.id});
  });

  app.post("/api/projects/:id/documents/:versionId/chunks/merge", async (req) => {
    const doc = await ownedDocument(req, "LEAD");
    if (!doc.chunkManifest || !doc.chunkManifestHash)
      throw new ApiError("CONFLICT", "尚未分块，不能合并");
    const manifest = ChunkManifest.parse(doc.chunkManifest);
    if(contentHash(chunkManifestPayload(manifest))!==doc.chunkManifestHash)throw new ApiError("CONFLICT","分块清单校验和不符");
    const rows = await db.documentChunk.findMany({
      where: { documentVersionId: doc.id, manifestHash: doc.chunkManifestHash },
    });
    const coverage = chunkCoverage(
      manifest.chunks.map((c) => ({ chunkId: c.chunkId, seq: c.seq })),
      rows,
    );
    // 覆盖对账：处理/失败/在途/取消集合完整；部分结果不得发布为完整提取。
    if (!coverage.complete)
      throw new ApiError("CONFLICT", "覆盖对账未通过：存在未完成/失败/在途/缺失的块", {
        coverage: {
          processed: coverage.processed.length,
          pending: coverage.pending.length,
          inProgress: coverage.inProgress.length,
          failed: coverage.failed.length,
          cancelled: coverage.cancelled.length,
          missing: coverage.missing.length,
        },
      });
    const byChunkId = new Map(rows.map((row) => [row.chunkId, row]));
    const results = manifest.chunks.map((chunk) => {
      const row = byChunkId.get(chunk.chunkId)!;
      if(!row.output||contentHash(row.output)!==row.outputHash)throw new ApiError("CONFLICT","块结果缺失或校验和不符");
      return {
        chunkId: chunk.chunkId,
        seq: chunk.seq,
        output: RuleExtractionOutput.parse(row.output),
      };
    });
    const merged = mergeChunkExtractions(results);
    return {
      documentVersionId: doc.id,
      manifestHash: doc.chunkManifestHash,
      chunkCount: manifest.chunks.length,
      merged,
      counts: {
        ruleDrafts: merged.ruleDrafts.length,
        conflicts: merged.ruleDrafts.filter((d) => d.conflictsWith.length > 0).length,
        clarifications: merged.clarifications.length,
        unparsedRanges: merged.unparsedRanges.length,
      },
    };
  });
}
