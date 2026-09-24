import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { MemoryUsage } from "@ai-qa/contracts";
import { requireAuth, requireProjectAccess } from "./auth.js";
import { ApiError } from "./errors.js";

/**
 * W07（INT-04）记忆消费闭环：检索候选 → used/rejected 决策 + outcome。
 * 过期/跨项目/矛盾记忆拒绝（服务端判定，不靠模型自律）；每次使用可追溯。
 */

export function registerV2MemoryRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const param = (req: FastifyRequest, key: string) =>
    (req.params as Record<string, string>)[key]!;

  app.post("/api/v2/sessions/:id/memory-usages", async (req, reply) => {
    const sessionId = param(req, "id");
    const session = await prisma.v2ExecutionSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new ApiError("NOT_FOUND", "会话不存在");
    await requireProjectAccess(prisma, req, session.projectId, "LEAD");
    const body = z
      .object({
        memoryRecordId: z.string().min(1),
        decision: z.enum(["used", "rejected"]),
        reason: z.string().min(1).max(2000),
        outcome: z.enum(["helped", "neutral", "harmful", "unknown"]).nullable().default(null),
      })
      .strict()
      .parse(req.body);

    // 记忆必须属于本项目（跨项目拒绝）。
    const record = await prisma.projectMemory.findFirst({
      where: { id: body.memoryRecordId, projectId: session.projectId },
    });
    if (!record) throw new ApiError("VALIDATION_ERROR", "记忆不属于本会话项目（跨项目拒绝）");

    // 过期记忆：validUntil 已过 → 拒绝 used（只能 rejected 并注明过期）。
    const expired = record.validUntil !== null && record.validUntil < new Date();
    if (expired && body.decision === "used")
      throw new ApiError("CONFLICT", "记忆已过期：不能用于当前计划（只能拒绝并记录原因）");
    // 已失效记忆同样不可 used。
    if (record.invalidated && body.decision === "used")
      throw new ApiError("CONFLICT", "记忆已被失效标记：不能用于当前计划");

    const parsed = MemoryUsage.pick({
      memoryRecordId: true, sessionId: true, retrieved: true, decision: true, reason: true, outcome: true, usedAt: true,
    }).parse({
      memoryRecordId: body.memoryRecordId,
      sessionId,
      retrieved: true,
      decision: body.decision,
      reason: body.reason,
      outcome: body.outcome,
      usedAt: new Date().toISOString(),
    });
    const created = await prisma.v2MemoryUsage.create({
      data: { ...parsed, projectId: session.projectId } as never,
    });
    return reply.code(201).send({ memoryUsageId: created.id });
  });

  app.get("/api/v2/sessions/:id/memory-usages", async (req) => {
    const sessionId = param(req, "id");
    const session = await prisma.v2ExecutionSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new ApiError("NOT_FOUND", "会话不存在");
    await requireProjectAccess(prisma, req, session.projectId, "VIEWER");
    const usages = await prisma.v2MemoryUsage.findMany({
      where: { sessionId },
      orderBy: { usedAt: "desc" },
      take: 200,
    });
    return { memoryUsages: usages };
  });
}
