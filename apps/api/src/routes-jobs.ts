import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient, type Job } from "@prisma/client";
import type { Queue } from "bullmq";
import {
  CaseGenerationJobRequest,
  JobEnvelope,
  RuleExtractionJobRequest,
} from "@ai-qa/contracts";
import { requireChannelConfig } from "@ai-qa/model-adapters";
import { reviewRule } from "./routes-review.js";
import { ApiError } from "./errors.js";
import { requireAuth, requireProjectAccess } from "./auth.js";

/**
 * 阶段 2 作业接口（contracts/jobs.ts 冻结形状）：
 * - POST /api/projects/:id/rule-extractions   → 202 {jobId}
 * - POST /api/projects/:id/case-generations   → 202 {jobId}
 * - GET  /api/jobs/:id                        → JobEnvelope
 * - POST /api/rule-versions/:id/approve       → 规则批准（LEAD+，解锁用例生成）
 *
 * 幂等（裁决点 4）：(projectId, kind, fingerprint) 唯一；同参数重复 POST
 * 返回原 jobId（200）；不同参数必然不同指纹。
 * real 模式：API 侧快速校验文本通道配置（503 MODEL_NOT_CONFIGURED），
 * worker 侧二次校验（双保险）。
 */

type JobKind = "RULE_EXTRACTION" | "CASE_GENERATION";

export function registerJobRoutes(app: FastifyInstance, prisma: PrismaClient, jobQueue: Pick<Queue, "add">) {
  async function enqueue(job: Job) {
    if (job.status !== "QUEUED") return;
    try {
      await jobQueue.add("run", { jobId: job.id }, { jobId: `job-${job.id}`, removeOnComplete: true, removeOnFail: 200 });
    } catch {
      // 作业已可靠落库；worker 对账负责补投，不丢弃用户已接受的请求。
      app.log.warn({ jobId: job.id }, "作业入队失败，等待对账补投");
    }
  }
  async function createJobEnqueued(
    reply: import("fastify").FastifyReply,
    projectId: string,
    kind: JobKind,
    request: Record<string, unknown>,
    fingerprintSource: Record<string, unknown>,
  ): Promise<Job> {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ kind, ...fingerprintSource }))
      .digest("hex");

    const existing = await prisma.job.findUnique({
      where: { projectId_kind_fingerprint: { projectId, kind, fingerprint } },
    });
    if (existing) {
      await enqueue(existing);
      // 幂等：同参数返回原 jobId。
      return reply.code(200).send({ jobId: existing.id, existed: true });
    }

    let job: Job;
    try {
      job = await prisma.job.create({
        data: { projectId, kind, request: request as never, fingerprint },
      });
    } catch (err) {
      if (String(err).includes("Unique constraint") || (err as { code?: string }).code === "P2002") {
        const raced = await prisma.job.findUnique({
          where: { projectId_kind_fingerprint: { projectId, kind, fingerprint } },
        });
        if (raced) {
          await enqueue(raced);
          return reply.code(200).send({ jobId: raced.id, existed: true });
        }
      }
      throw err;
    }
    await enqueue(job);
    return reply.code(202).send({ jobId: job.id });
  }

  app.post("/api/projects/:id/rule-extractions", async (req, reply) => {
    requireAuth(req);
    const { id: projectId } = z.object({ id: z.string() }).parse(req.params);
    await requireProjectAccess(prisma, req, projectId, "LEAD");
    const body = RuleExtractionJobRequest.parse(req.body);

    if (body.mode === "real" && (process.env.AIQA_INTELLIGENCE_BACKEND ?? "python") !== "python") {
      // API 快速失败：real 缺配置 503（PRD FR-11：不得自动降级 mock）。
      requireChannelConfig("text");
    }
    // 引用核验：文档版本存在、同项目、已 PARSED（NEEDS_OCR 422 拒绝）。
    const docVersions = await prisma.documentVersion.findMany({
      where: { id: { in: body.documentVersionIds } },
      include: { document: { select: { projectId: true } } },
    });
    for (const docId of body.documentVersionIds) {
      const row = docVersions.find((d) => d.id === docId);
      if (!row || row.document.projectId !== projectId) {
        throw new ApiError("VALIDATION_ERROR", `文档版本不存在或不属于该项目：${docId}`, {
          field: "documentVersionIds",
        });
      }
      if (body.mode === "real" && row.mode !== "real" && ["PNG", "JPEG", "PDF_TEXT", "PDF_SCANNED"].includes(row.format)) throw new ApiError("VALIDATION_ERROR", "模拟视觉转录不能用于真实规则提取");
      if (row.parseStatus === "NEEDS_OCR") {
        throw new ApiError("NEEDS_OCR", "该文档版本需要 OCR，不能直接提取规则", { documentVersionId: docId });
      }
      if (row.parseStatus !== "PARSED") {
        throw new ApiError("VALIDATION_ERROR", `文档版本状态为 ${row.parseStatus}（须 PARSED）`, {
          documentVersionId: docId,
        });
      }
    }

    return createJobEnqueued(reply, projectId, "RULE_EXTRACTION", body as never, {
      documentVersionIds: [...body.documentVersionIds].sort(),
      glossaryUpdates: body.glossaryUpdates,
      mode: body.mode,
    });
  });

  app.post("/api/projects/:id/case-generations", async (req, reply) => {
    requireAuth(req);
    const { id: projectId } = z.object({ id: z.string() }).parse(req.params);
    await requireProjectAccess(prisma, req, projectId, "LEAD");
    const body = CaseGenerationJobRequest.parse(req.body);

    if (body.mode === "real" && (process.env.AIQA_INTELLIGENCE_BACKEND ?? "python") !== "python") {
      requireChannelConfig("text");
    }
    // 规则必须全是 APPROVED 且属于本项目。
    const rules = await prisma.ruleVersion.findMany({
      where: { id: { in: body.ruleVersionIds } },
      include: { rule: { select: { projectId: true } } },
    });
    for (const ruleId of body.ruleVersionIds) {
      const row = rules.find((r) => r.id === ruleId);
      if (!row || row.rule.projectId !== projectId) {
        throw new ApiError("VALIDATION_ERROR", `规则版本不存在或不属于该项目：${ruleId}`, {
          field: "ruleVersionIds",
        });
      }
      if (row.reviewStatus !== "APPROVED") {
        throw new ApiError("VALIDATION_ERROR", `规则 ${ruleId} 状态为 ${row.reviewStatus}（须 APPROVED）`, {
          field: "ruleVersionIds",
        });
      }
    }

    if (await prisma.clarification.count({ where: { projectId, ruleVersionIds: { hasSome: body.ruleVersionIds }, resolvedAt: null } })) {
      throw new ApiError("CONFLICT", "选定规则仍有未解决澄清");
    }
    if (body.mode === "real" && rules.some(r => r.origin === "model" && r.generationMode !== "real")) throw new ApiError("VALIDATION_ERROR", "模拟或模式未核验的规则不能用于真实用例生成");

    return createJobEnqueued(reply, projectId, "CASE_GENERATION", body as never, {
      ruleVersionIds: [...body.ruleVersionIds].sort(),
      mode: body.mode,
    });
  });

  // 失联失败后显式重试；不对模型调用自动重复计费。仅失败作业可重新排队。
  app.post("/api/jobs/:id/retry", async (req, reply) => {
    requireAuth(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const job = await prisma.job.findUnique({ where: { id } });
    if (!job) throw new ApiError("NOT_FOUND", "作业不存在");
    await requireProjectAccess(prisma, req, job.projectId, "LEAD");
    if((job.request as {workflowId?:string}).workflowId)throw new ApiError('CONFLICT','工作流所属作业不能单独重放，请从工作流重新处理');
    if(['DATA_PREPARE','DATA_CLEANUP','DATA_INSPECT','LOGIN_CHECK'].includes(job.kind))throw new ApiError('CONFLICT','请从准备中心重新检查或核对资源；禁止直接重放准备写入');
    const changed = await prisma.$transaction(async tx => {
    const changed = await tx.job.updateMany({
      where: { id, status: "FAILED" },
      data: { status: "QUEUED", startedAt: null, finishedAt: null, error: Prisma.DbNull, result: Prisma.DbNull },
    });
    if (!changed.count) throw new ApiError("CONFLICT", "仅失败作业允许重试");
    if (job.kind === "DOCUMENT_PARSE") {
      const request = z.object({ documentVersionId: z.string() }).parse(job.request);
      await tx.documentVersion.updateMany({ where: { id: request.documentVersionId, document: { projectId: job.projectId }, parseStatus: "FAILED" }, data: { parseStatus: "PENDING" } });
    }
    return changed;
    });
    // 新队列 ID 避免遗留 BullMQ failed 记录占住旧 ID；兜底仍由对账负责。
    try {
      await jobQueue.add("run", { jobId: id }, { removeOnComplete: true, removeOnFail: 200 });
    } catch { app.log.warn({ jobId: id }, "重试入队失败，等待对账补投"); }
    return reply.code(202).send({ jobId: id });
  });

  app.post('/api/jobs/:id/cancel',async req=>{
    const {id}=z.object({id:z.string()}).parse(req.params);
    const job=await prisma.job.findUnique({where:{id}});if(!job)throw new ApiError('NOT_FOUND','作业不存在');
    await requireProjectAccess(prisma,req,job.projectId,'LEAD');
    if(!['LOGIN_CHECK','DATA_PREPARE','DATA_CLEANUP','DATA_INSPECT','CHANGE_REVIEW','SNAPSHOT_DIFF'].includes(job.kind))throw new ApiError('UNSUPPORTED','此类作业使用所属运行的取消入口');
    const changed=await prisma.job.updateMany({where:{id,status:{in:['QUEUED','RUNNING']}},data:{status:'CANCELLED',finishedAt:new Date()}});
    if(!changed.count)throw new ApiError('CONFLICT','作业已处于终态，不能取消');
    if(job.kind==='LOGIN_CHECK')await prisma.loginPreparation.updateMany({where:{lastCheckJobId:id},data:{lastCheckStatus:'CANCELLED',lastCheckAt:null}});
    return {jobId:id,status:(await prisma.job.findUniqueOrThrow({where:{id}})).status};
  });

  app.get("/api/jobs/:id", async (req) => {
    requireAuth(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const job = await prisma.job.findUnique({ where: { id } });
    if (!job) throw new ApiError("NOT_FOUND", "作业不存在");
    await requireProjectAccess(prisma, req, job.projectId, "VIEWER");
    const envelope = JobEnvelope.safeParse({
      jobId: job.id,
      projectId:job.projectId,
      workflowId:(job.request as {workflowId?:string}).workflowId,
      kind: job.kind,
      mode: (job.request as { mode?: string }).mode,
      status: job.status,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
      result: job.result ?? null,
      error: job.error ?? null,
    });
    if (!envelope.success) {
      throw new ApiError("INTERNAL", "作业信封不符合契约", {
        issues: envelope.error.issues.slice(0, 3),
      });
    }
    return envelope.data;
  });

  app.post("/api/rule-versions/:id/approve", req => reviewRule(prisma, req, "APPROVED"));
}
