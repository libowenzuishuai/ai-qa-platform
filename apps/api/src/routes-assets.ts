import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import { ApiError } from "./errors.js";
import { requireProjectAccess } from "./auth.js";

/** 固定资产查询与种子接口（阶段 1）。 */

export function registerAssetRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  seedQueue: Queue,
) {
  app.post("/api/projects/:projectId/seed-fixed-assets", async (req, reply) => {
    const { projectId } = z.object({ projectId: z.string() }).parse(req.params);
    await requireProjectAccess(prisma, req, projectId, "LEAD");
    const body = z.object({ environmentId: z.string().min(1) }).parse(req.body);
    const environment = await prisma.environment.findFirst({
      where: { id: body.environmentId, projectId },
    });
    if (!environment) throw new ApiError("NOT_FOUND", "环境不存在或不属于该项目");
    await seedQueue.add(
      "seed",
      { projectId, environmentId: body.environmentId },
      { jobId: `seed-${projectId}-${body.environmentId}`, removeOnComplete: true, removeOnFail: 100 },
    );
    return reply.code(202).send({ queued: true, poll: `/api/projects/${projectId}/case-versions` });
  });

  app.get("/api/projects/:projectId/case-versions", async (req) => {
    const { projectId } = z.object({ projectId: z.string() }).parse(req.params);
    await requireProjectAccess(prisma, req, projectId, "VIEWER");
    const cases = await prisma.testCase.findMany({
      where: { projectId },
      include: { versions: { orderBy: { version: "desc" } } },
    });
    const result = [];
    for (const testCase of cases) {
      const latest = testCase.versions[0];
      if (!latest) continue;
      const plan = await prisma.testPlanVersion.findFirst({
        where: { caseVersionId: latest.id },
        orderBy: { version: "desc" },
      });
      result.push({
        caseId: testCase.id,
        caseVersionId: latest.id,
        version: latest.version,
        title: latest.title,
        approvalStatus: latest.approvalStatus,
        priority: latest.priority,
        ruleVersionIds: latest.ruleVersionIds,
        hasPlan: Boolean(plan),
        planId: plan?.id ?? null,
      });
    }
    return { caseVersions: result };
  });

  app.get("/api/projects/:projectId/baselines", async (req) => {
    const { projectId } = z.object({ projectId: z.string() }).parse(req.params);
    await requireProjectAccess(prisma, req, projectId, "VIEWER");
    const baselines = await prisma.baseline.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    });
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    return {
      baselines: baselines.map((b) => ({
        id: b.id,
        name: b.name,
        ruleVersionIds: b.ruleVersionIds,
        caseVersionIds: b.caseVersionIds,
        createdAt: b.createdAt,
        active: project?.activeBaselineId === b.id,
      })),
    };
  });

  app.get("/api/projects/:id/run-summaries", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireProjectAccess(prisma, req, id, "VIEWER");
    const runs = await prisma.run.findMany({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, lifecycle: true, acceptanceStatus: true, createdAt: true },
    });
    return { runs };
  });
}
