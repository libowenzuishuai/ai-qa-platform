import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import { z } from "zod";
import { createHash } from "node:crypto";
import { requireAuth, requireProjectAccess } from "./auth.js";
import { ApiError } from "./errors.js";

/**
 * R2/R3：v2 会话 API（最小旅程）。
 * 创建会话（固定 script 规划器切片）→ V2_SESSION_LOOP 作业驱动 session-loop；
 * 详情返回会话+阶段+intent/invocation+观察（真实事件数据源）。
 */

export function registerV2SessionRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  queue: Pick<Queue, "add">,
) {
  const param = (req: FastifyRequest, key: string) =>
    (req.params as Record<string, string>)[key]!;

  app.post("/api/v2/projects/:id/sessions", async (req, reply) => {
    const projectId = param(req, "id");
    await requireProjectAccess(prisma, req, projectId, "LEAD");
    const body = z
      .object({
        goal: z.string().min(1).max(4000),
        oracleSpecId: z.string().min(1),
        environmentId: z.string().min(1),
        /** 合成系统地址（操作层输入；script 切片）。 */
        targetBaseUrl: z.string().url(),
        buildId: z.string().min(1).max(200).default("synthetic"),
        planner: z.enum(["script"]).default("script"),
        maxRounds: z.number().int().min(1).max(50).default(10),
        idempotencyKey: z.string().min(8).max(200),
      })
      .strict()
      .parse(req.body);

    const oracle = await prisma.v2OracleSpec.findFirst({
      where: { id: body.oracleSpecId, projectId, status: "APPROVED" },
    });
    if (!oracle) throw new ApiError("VALIDATION_ERROR", "Oracle 不存在、未批准或不属于本项目");
    const environment = await prisma.environment.findFirst({
      where: { id: body.environmentId, projectId, isProduction: false },
    });
    if (!environment) throw new ApiError("VALIDATION_ERROR", "环境不可用或为生产环境");

    // 目标 origin 必须在环境白名单内（登记面与执行面一致）。
    const targetOrigin = new URL(body.targetBaseUrl).origin;
    if (!environment.allowedOrigins.includes(targetOrigin))
      throw new ApiError("VALIDATION_ERROR", `目标 origin ${targetOrigin} 不在环境白名单`);

    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ kind: "V2_SESSION_LOOP", projectId, goal: body.goal, oracleSpecId: body.oracleSpecId }))
      .digest("hex");
    const saved = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${projectId} FOR UPDATE`;
      const jobKey = await tx.job.findUnique({
        where: { projectId_kind_fingerprint: { projectId, kind: "V2_SESSION_LOOP", fingerprint } },
      });
      if (jobKey) {
        const session = await tx.v2ExecutionSession.findFirst({ where: { projectId, goal: body.goal } });
        if (session) return { session, jobId: jobKey.id, existed: true };
      }
      const session = await tx.v2ExecutionSession.create({
        data: {
          projectId,
          goal: body.goal,
          oracleSpecId: oracle.id,
          oracleHash: oracle.oracleHash,
          profileId: "profile-script-1",
          profileHash: "0".repeat(64),
          definitionId: "def-draft-loop",
          definitionVersion: 1,
          environmentId: environment.id,
          buildId: body.buildId,
          status: "QUEUED",
          budget: {
            maxWallClockMs: 120000, maxActiveMs: 120000, maxModelCalls: 0,
            maxTokens: 0, maxToolCalls: 200, maxResources: 10, maxCostMicros: null,
          },
          usage: {},
        },
      });
      const job = await tx.job.create({
        data: {
          projectId, kind: "V2_SESSION_LOOP", fingerprint,
          request: {
            sessionId: session.id, baseUrl: body.targetBaseUrl,
            planner: body.planner, maxRounds: body.maxRounds,
          } as never,
        },
      });
      await tx.auditEvent.create({
        data: {
          actorId: requireAuth(req).userId, action: "v2.session.create",
          entityType: "V2ExecutionSession", entityId: session.id,
          metadata: { oracleHash: oracle.oracleHash, planner: body.planner } as never,
        },
      });
      return { session, jobId: job.id, existed: false };
    });
    if (!saved.existed)
      try {
        await queue.add("run", { jobId: saved.jobId }, { removeOnComplete: true, removeOnFail: 200 });
      } catch { /* durable reconciliation */ }
    return reply.code(saved.existed ? 200 : 202).send({
      sessionId: saved.session.id, jobId: saved.jobId, existed: saved.existed,
    });
  });

  app.get("/api/v2/projects/:id/sessions", async (req) => {
    const projectId = param(req, "id");
    await requireProjectAccess(prisma, req, projectId, "VIEWER");
    const sessions = await prisma.v2ExecutionSession.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return {
      sessions: sessions.map((s) => ({
        id: s.id, goal: s.goal, status: s.status, buildId: s.buildId,
        oracleHash: s.oracleHash, createdAt: s.createdAt,
      })),
    };
  });

  app.get("/api/v2/sessions/:id", async (req) => {
    const id = param(req, "id");
    const session = await prisma.v2ExecutionSession.findUnique({ where: { id } });
    if (!session) throw new ApiError("NOT_FOUND", "会话不存在");
    await requireProjectAccess(prisma, req, session.projectId, "VIEWER");
    const [attempts, intents, observations] = await Promise.all([
      prisma.v2StepAttempt.findMany({ where: { sessionId: id }, orderBy: { round: "asc" } }),
      prisma.v2ActionIntent.findMany({ where: { sessionId: id }, orderBy: { createdAt: "asc" } }),
      prisma.v2Observation.findMany({ where: { sessionId: id }, orderBy: { round: "asc" } }),
    ]);
    const invocations = await prisma.v2Invocation.findMany({
      where: { intentId: { in: intents.map((i) => i.id) } },
      orderBy: { startedAt: "asc" },
    });
    return { session, attempts, intents, invocations, observations };
  });

  app.post("/api/v2/sessions/:id/cancel", async (req) => {
    const id = param(req, "id");
    const session = await prisma.v2ExecutionSession.findUnique({ where: { id } });
    if (!session) throw new ApiError("NOT_FOUND", "会话不存在");
    await requireProjectAccess(prisma, req, session.projectId, "LEAD");
    const updated = await prisma.v2ExecutionSession.updateMany({
      where: { id, status: { in: ["QUEUED", "PREPARING", "RUNNING", "WAITING_HUMAN", "WAITING_AUTH", "PAUSED"] } },
      data: { status: "CANCELLED", terminationReason: "用户取消", cancelRequestedAt: new Date() },
    });
    if (!updated.count) throw new ApiError("CONFLICT", "会话已处于终态");
    return { sessionId: id, status: "CANCELLED" };
  });
}
