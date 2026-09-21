import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import { z } from "zod";
import {
  PrepareRequest,
  CleanupRequest,
  DataParameterSchema,
  HttpDataPluginDefinition,
} from "@ai-qa/contracts";
import { requireAuth, requireProjectAccess } from "./auth.js";
import { ApiError } from "./errors.js";
import { configHash } from "./preparation-service.js";
import { validateDataParameters } from "./data-plugin-service.js";
export function registerDataPluginRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  jobs: Pick<Queue, "add">,
) {
  const param = (r: FastifyRequest, k: string) =>
    z.record(z.string()).parse(r.params)[k]!;
  async function plugin(
    req: FastifyRequest,
    role: "ADMIN" | "LEAD" | "VIEWER" = "LEAD",
  ) {
    const projectId = param(req, "id");
    await requireProjectAccess(prisma, req, projectId, role);
    const p = await prisma.dataPlugin.findFirst({
      where: { id: param(req, "pluginId"), projectId },
    });
    if (!p?.definition || !p.environmentId)
      throw new ApiError("VALIDATION_ERROR", "插件未注册完整环境和操作模板");
    return p;
  }
  async function enqueue(
    projectId: string,
    kind: string,
    request: unknown,
    key: string,
  ) {
    const fingerprint = configHash({ kind, key });
    const existing = await prisma.job.findUnique({
      where: { projectId_kind_fingerprint: { projectId, kind, fingerprint } },
    });
    if (existing && configHash(existing.request) !== configHash(request))
      throw new ApiError("IDEMPOTENCY_CONFLICT", "相同请求标识对应不同参数");
    const job = await prisma.job.upsert({
      where: { projectId_kind_fingerprint: { projectId, kind, fingerprint } },
      create: { projectId, kind, fingerprint, request: request as never },
      update: {},
    });
    if (configHash(job.request) !== configHash(request))
      throw new ApiError("IDEMPOTENCY_CONFLICT", "相同请求标识对应不同参数");
    if (job.status === "QUEUED")
      try {
        await jobs.add(
          "run",
          { jobId: job.id },
          { jobId: `job-${job.id}`, removeOnComplete: true },
        );
      } catch {}
    return { jobId: job.id };
  }
  app.post("/api/projects/:id/data-plugins", async (req) => {
    const projectId = param(req, "id");
    await requireProjectAccess(prisma, req, projectId, "ADMIN");
    const body = z
      .object({
        kind: z.literal("http-request"),
        name: z.string().min(1).max(200),
        environmentId: z.string().min(1),
        definition: HttpDataPluginDefinition,
        paramSchema: DataParameterSchema,
      })
      .strict()
      .parse(req.body);
    if (
      body.paramSchema.required.some(
        (name) => !body.paramSchema.properties[name],
      )
    )
      throw new ApiError("VALIDATION_ERROR", "必填参数必须在属性表中声明");
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${projectId} FOR UPDATE`;
      const env = await tx.environment.findFirst({
        where: { id: body.environmentId, projectId, isProduction: false },
      });
      if (!env) throw new ApiError("VALIDATION_ERROR", "测试环境不存在");
      const prior = await tx.dataPlugin.findFirst({
        where: { projectId, kind: body.kind },
        orderBy: { version: "desc" },
      });
      return tx.dataPlugin.create({
        data: {
          ...body,
          projectId,
          environmentRevision: env.revision,
          environmentSnapshot: {
            baseUrl: env.baseUrl,
            allowedOrigins: env.allowedOrigins,
          },
          version: (prior?.version ?? 0) + 1,
          effectTypes: ["CREATE", "DELETE", "READ"],
          createdBy: requireAuth(req).userId,
        },
      });
    });
  });
  app.get("/api/projects/:id/data-plugins", async (req) => {
    const projectId = param(req, "id");
    await requireProjectAccess(prisma, req, projectId, "VIEWER");
    return {
      plugins: await prisma.dataPlugin.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
      }),
    };
  });
  app.post(
    "/api/projects/:id/data-plugins/:pluginId/prepare",
    async (req, reply) => {
      const p = await plugin(req);
      if (!p.enabled) throw new ApiError("CONFLICT", "插件已禁用");
      const body = PrepareRequest.parse(req.body);
      try {
        validateDataParameters(p.paramSchema, body.params);
      } catch {
        throw new ApiError("VALIDATION_ERROR", "参数不符合已注册 schema");
      }
      if (
        body.runId &&
        !(await prisma.run.findFirst({
          where: {
            id: body.runId,
            projectId: p.projectId,
            environmentId: p.environmentId!,
          },
        }))
      )
        throw new ApiError("VALIDATION_ERROR", "运行与插件不属于同一项目环境");
      if (
        body.attemptId &&
        (!body.runId ||
          !(await prisma.caseAttempt.findFirst({
            where: {
              id: body.attemptId,
              runId: body.runId,
              projectId: p.projectId,
            },
          })))
      )
        throw new ApiError("VALIDATION_ERROR", "attempt 归属不符");
      return reply
        .code(202)
        .send(
          await enqueue(
            p.projectId,
            "DATA_PREPARE",
            { ...body, pluginId: p.id },
            `${p.id}:${body.idempotencyKey}`,
          ),
        );
    },
  );
  for (const operation of ["cleanup", "inspect"] as const)
    app.post(
      `/api/projects/:id/data-plugins/:pluginId/${operation}`,
      async (req, reply) => {
        const p = await plugin(req);
        const body = CleanupRequest.parse(req.body);
        const resources = await prisma.dataResource.findMany({
          where: {
            id: { in: body.resourceIds },
            projectId: p.projectId,
            pluginId: p.id,
          },
        });
        if (resources.length !== new Set(body.resourceIds).size)
          throw new ApiError("VALIDATION_ERROR", "资源不存在或归属不符");
        // A fingerprint tied to current resource states permits explicit retry after a failed cleanup.
        const key = configHash(
          resources
            .map((r) => [r.id, r.status, r.updatedAt.toISOString()])
            .sort(),
        );
        return reply
          .code(202)
          .send(
            await enqueue(
              p.projectId,
              operation === "cleanup" ? "DATA_CLEANUP" : "DATA_INSPECT",
              { pluginId: p.id, resourceIds: body.resourceIds },
              key,
            ),
          );
      },
    );
  app.get("/api/projects/:id/data-resources", async (req) => {
    const projectId = param(req, "id");
    await requireProjectAccess(prisma, req, projectId, "VIEWER");
    return {
      resources: await prisma.dataResource.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        take: 500,
      }),
    };
  });
  app.post("/api/data-resources/:id/retry-cleanup", async (req, reply) => {
    const r = await prisma.dataResource.findUnique({
      where: { id: param(req, "id") },
    });
    if (!r) throw new ApiError("NOT_FOUND", "资源不存在");
    await requireProjectAccess(prisma, req, r.projectId, "ADMIN");
    return reply
      .code(202)
      .send(
        await enqueue(
          r.projectId,
          "DATA_CLEANUP",
          { pluginId: r.pluginId, resourceIds: [r.id], inspectFirst: true },
          `${r.id}:${r.updatedAt.toISOString()}`,
        ),
      );
  });
}
