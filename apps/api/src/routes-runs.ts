import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { Queue } from "bullmq";
import { ArtifactStore } from "@ai-qa/artifact-store";
import { buildRunReport } from "@ai-qa/reporting";
import { casTransitionRun, emitRunEvent } from "@ai-qa/run-events";
import { ApiError } from "./errors.js";
import { requireAuth, requireProjectAccess } from "./auth.js";
import { createRun } from "./runs-service.js";

/** 运行接口：创建（202）、详情、SSE 事件流、幂等取消、报告。 */

const TERMINAL_LIFECYCLE = new Set(["FINISHED", "CANCELLED", "ERROR"]);

export function registerRunRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  runsQueue: Queue,
  store: ArtifactStore,
) {
  const RunCreateBody = z.object({
    projectId: z.string().min(1),
    baselineId: z.string().min(1),
    environmentId: z.string().min(1),
    caseVersionIds: z.array(z.string().min(1)).min(1),
    buildId: z.string().min(1).max(200).optional(),
    mode: z.literal("real"),
    idempotencyKey: z.string().min(8).max(128),
    // R9：调用者预算（解析、保存并执行；超限 422）。
    budget: z
      .object({
        maxToolActionsPerCase: z.number().int().min(1).max(1000).optional(),
        maxWallClockMsPerCase: z.number().int().min(10_000).max(600_000).optional(),
        maxWallClockMsPerRun: z.number().int().min(60_000).max(7_200_000).optional(),
      })
      .optional(),
  });

  app.post("/api/runs", async (req, reply) => {
    const auth = requireAuth(req);
    const body = RunCreateBody.parse(req.body);
    await requireProjectAccess(prisma, req, body.projectId, "LEAD");
    if (auth.platformRole === "VIEWER") {
      throw new ApiError("FORBIDDEN", "查看者不能启动运行");
    }
    const result = await createRun(prisma, store, body);
    if (result.existed) {
      const run = await prisma.run.findUniqueOrThrow({ where: { id: result.runId } });
      return reply.code(200).send({ runId: run.id, lifecycle: run.lifecycle, existed: true });
    }
    // 入队（失败不回滚：对账循环会重投 QUEUED 运行）。
    await runsQueue
      .add("execute", { runId: result.runId }, { jobId: `run-${result.runId}`, removeOnComplete: true, removeOnFail: 500 })
      .catch((err) => req.log.warn({ err }, "入队失败，等待对账重投"));
    return reply.code(202).send({ runId: result.runId, lifecycle: "QUEUED" });
  });

  app.get("/api/runs", async (req) => {
    const { projectId } = z.object({ projectId: z.string() }).parse(req.query);
    await requireProjectAccess(prisma, req, projectId, "VIEWER");
    const runs = await prisma.run.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true, lifecycle: true, acceptanceStatus: true, mode: true, buildId: true,
        createdAt: true, updatedAt: true, selectedCaseVersionIds: true,
      },
    });
    return { runs };
  });

  app.get("/api/runs/:id", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const run = await prisma.run.findUnique({
      where: { id },
      include: { attempts: { orderBy: { createdAt: "asc" } } },
    });
    if (!run) throw new ApiError("NOT_FOUND", "运行不存在");
    await requireProjectAccess(prisma, req, run.projectId, "VIEWER");
    const caseTitles = await prisma.testCaseVersion.findMany({
      where: { id: { in: run.selectedCaseVersionIds } },
      select: { id: true, title: true },
    });
    return {
      run: {
        id: run.id,
        lifecycle: run.lifecycle,
        acceptanceStatus: run.acceptanceStatus,
        mode: run.mode,
        buildId: run.buildId,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        selectedCaseVersionIds: run.selectedCaseVersionIds,
      },
      cases: run.selectedCaseVersionIds.map((caseVersionId) => {
        const attempt = run.attempts.find((a) => a.caseVersionId === caseVersionId);
        return {
          caseVersionId,
          title: caseTitles.find((t) => t.id === caseVersionId)?.title ?? caseVersionId,
          attemptId: attempt?.id ?? null,
          attemptNamespace: attempt?.namespace ?? null,
          verdict: attempt?.verdict ?? "NOT_RUN",
          reasonCode: attempt?.reasonCode ?? "NONE",
          unstable: attempt?.unstable ?? false,
        };
      }),
    };
  });

  // ---------- SSE ----------
  app.get("/api/runs/:id/events", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const run = await prisma.run.findUnique({ where: { id } });
    if (!run) throw new ApiError("NOT_FOUND", "运行不存在");
    await requireProjectAccess(prisma, req, run.projectId, "VIEWER");

    const lastEventHeader = req.headers["last-event-id"];
    const lastEventQuery = (req.query as { lastEventId?: string }).lastEventId;
    let lastSeq = 0;
    const rawHeader = Array.isArray(lastEventHeader) ? lastEventHeader[0] : lastEventHeader;
    const raw = rawHeader ?? lastEventQuery;
    if (raw && /^\d+$/.test(raw)) lastSeq = Number(raw);

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const write = (chunk: string) => reply.raw.write(chunk);
    write(": connected\n\n");

    let closed = false;
    req.raw.on("close", () => {
      closed = true;
    });

    let cursor = lastSeq;
    const poll = async () => {
      while (!closed) {
        const events = await prisma.runEvent.findMany({
          where: { runId: id, seq: { gt: cursor } },
          orderBy: { seq: "asc" },
          take: 200,
        });
        for (const event of events) {
          cursor = event.seq;
          write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify({
            seq: event.seq,
            type: event.type,
            payload: event.payload,
            createdAt: event.createdAt,
          })}\n\n`);
        }
        const current = await prisma.run.findUnique({ where: { id }, select: { lifecycle: true } });
        if (current && TERMINAL_LIFECYCLE.has(current.lifecycle) && events.length === 0) {
          write(`event: stream.end\ndata: ${JSON.stringify({ lifecycle: current.lifecycle })}\n\n`);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      if (!closed) reply.raw.end();
    };
    void poll().catch((err) => req.log.error({ err }, "SSE 轮询失败"));
    return reply;
  });

  // ---------- 取消（幂等） ----------
  app.post("/api/runs/:id/cancel", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const run = await prisma.run.findUnique({ where: { id } });
    if (!run) throw new ApiError("NOT_FOUND", "运行不存在");
    const access = await requireProjectAccess(prisma, req, run.projectId, "LEAD");
    if (access.role === "VIEWER") {
      throw new ApiError("FORBIDDEN", "查看者不能取消运行");
    }
    if (TERMINAL_LIFECYCLE.has(run.lifecycle)) {
      return { runId: id, lifecycle: run.lifecycle, note: "运行已处于终态，取消为幂等空操作" };
    }
    // R2/R7：CAS 迁移 + 数据库原子序号事件。
    const updated = await casTransitionRun(
      prisma,
      id,
      ["QUEUED", "PREPARING", "RUNNING", "FINALIZING"],
      "CANCEL_REQUESTED",
    );
    if (updated) {
      await emitRunEvent(prisma, id, "run.cancel_requested", { actor: req.auth?.userId });
    }
    const after = await prisma.run.findUniqueOrThrow({ where: { id }, select: { lifecycle: true } });
    return { runId: id, lifecycle: after.lifecycle };
  });

  // ---------- 报告（R5：与 worker 终态同一口径的共享报告构建器） ----------
  app.get("/api/runs/:id/report", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const run = await prisma.run.findUnique({ where: { id }, select: { projectId: true } });
    if (!run) throw new ApiError("NOT_FOUND", "运行不存在");
    await requireProjectAccess(prisma, req, run.projectId, "VIEWER");
    return buildRunReport(prisma, store, id);
  });
}