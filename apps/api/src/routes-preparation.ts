import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient, Prisma } from "@prisma/client";
import type { Queue } from "bullmq";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { EnvironmentRuntime } from "@ai-qa/contracts";
import { requireAuth, requireProjectAccess } from "./auth.js";
import { ApiError } from "./errors.js";
import {
  configHash,
  validateLoginConfiguration,
  loginFresh,
} from "./preparation-service.js";
export function registerPreparationRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  jobs: Pick<Queue, "add">,
) {
  const param = (r: FastifyRequest, k: string) =>
    z.record(z.string()).parse(r.params)[k]!;
  async function environment(
    req: FastifyRequest,
    role: "ADMIN" | "LEAD" | "VIEWER",
  ) {
    const projectId = param(req, "id");
    await requireProjectAccess(prisma, req, projectId, role);
    const env = await prisma.environment.findFirst({
      where: { id: param(req, "envId"), projectId, isProduction: false },
    });
    if (!env) throw new ApiError("NOT_FOUND", "测试环境不存在");
    return env;
  }
  app.get(
    "/api/projects/:id/environments/:envId/login-preparations",
    async (req) => {
      const env = await environment(req, "VIEWER");
      const rows = await prisma.loginPreparation.findMany({
        where: { projectId: env.projectId, environmentId: env.id },
        orderBy: { role: "asc" },
      });
      return {
        preparations: rows.map((r) => ({
          ...r,
          valid: loginFresh(r, env.revision),
          expired: r.lastCheckStatus === "PASS" && !loginFresh(r, env.revision),
        })),
      };
    },
  );
  app.put(
    "/api/projects/:id/environments/:envId/login-preparations/:role",
    async (req) => {
      const env = await environment(req, "ADMIN");
      const role = param(req, "role");
      let config;
      try {
        config = validateLoginConfiguration(
          {
            ...z.record(z.unknown()).parse(req.body),
            environmentId: env.id,
            role,
          },
          env.runtime,
        );
      } catch {
        throw new ApiError(
          "VALIDATION_ERROR",
          "登录配置无效，请检查步骤、成功标识与已登记账号引用",
        );
      }
      return prisma.$transaction(async (tx) => {
        // Lock environment before changing preparation; all previously bound plans become stale.
        await tx.environment.update({
          where: { id: env.id },
          data: { revision: { increment: 1 } },
        });
        const fresh = await tx.environment.findUniqueOrThrow({
          where: { id: env.id },
        });
        validateLoginConfiguration(config, fresh.runtime);
        const values = {
          configuration: config as Prisma.InputJsonValue,
          credentialRef: config.credentialRef,
          steps: config.steps,
          successIndicator: config.successIndicator,
          configHash: configHash(config),
          validityHours: config.validityHours,
          lastCheckStatus: "NEVER_CHECKED",
          lastCheckAt: null,
          lastCheckEnvRev: null,
          lastCheckDetail: null,
          lastCheckJobId: null,
        };
        const saved = await tx.loginPreparation.upsert({
          where: {
            projectId_environmentId_role: {
              projectId: env.projectId,
              environmentId: env.id,
              role,
            },
          },
          create: {
            projectId: env.projectId,
            environmentId: env.id,
            role,
            ...values,
          },
          update: values,
        });
        await tx.auditEvent.create({
          data: {
            actorId: requireAuth(req).userId,
            action: "loginPreparation.upsert",
            entityType: "LoginPreparation",
            entityId: saved.id,
          },
        });
        return saved;
      });
    },
  );
  app.delete(
    "/api/projects/:id/environments/:envId/login-preparations/:role",
    async (req) => {
      const env = await environment(req, "ADMIN");
      return prisma.$transaction(async (tx) => {
        await tx.environment.update({
          where: { id: env.id },
          data: { revision: { increment: 1 } },
        });
        const deleted = await tx.loginPreparation.deleteMany({
          where: {
            projectId: env.projectId,
            environmentId: env.id,
            role: param(req, "role"),
          },
        });
        if (!deleted.count) throw new ApiError("NOT_FOUND", "登录配置不存在");
        return { ok: true };
      });
    },
  );
  app.post(
    "/api/projects/:id/environments/:envId/login-preparations/:role/check",
    async (req, reply) => {
      const env = await environment(req, "LEAD");
      const job = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Environment" WHERE id=${env.id} FOR UPDATE`;
        const current = await tx.environment.findUniqueOrThrow({
          where: { id: env.id },
        });
        const prep = await tx.loginPreparation.findUnique({
          where: {
            projectId_environmentId_role: {
              projectId: env.projectId,
              environmentId: env.id,
              role: param(req, "role"),
            },
          },
        });
        if (!prep?.configuration)
          throw new ApiError("VALIDATION_ERROR", "请先保存完整登录配置");
        const row = await tx.job.create({
          data: {
            projectId: env.projectId,
            kind: "LOGIN_CHECK",
            fingerprint: randomUUID(),
            request: {
              loginPreparationId: prep.id,
              configuration: prep.configuration,
              configHash: prep.configHash,
              environmentId: env.id,
              environmentRevision: current.revision,
            },
          },
        });
        await tx.loginPreparation.update({
          where: { id: prep.id },
          data: {
            lastCheckJobId: row.id,
            lastCheckStatus: "QUEUED",
            lastCheckAt: null,
          },
        });
        return row;
      });
      try {
        await jobs.add(
          "run",
          { jobId: job.id },
          { jobId: `job-${job.id}`, removeOnComplete: true },
        );
      } catch {
        /* Durable queue recovery. */
      }
      return reply.code(202).send({ jobId: job.id });
    },
  );
  app.get("/api/projects/:id/preparation-summary", async (req) => {
    const projectId = param(req, "id");
    await requireProjectAccess(prisma, req, projectId, "VIEWER");
    const [envs, preps] = await Promise.all([
      prisma.environment.findMany({
        where: { projectId, isProduction: false },
      }),
      prisma.loginPreparation.findMany({ where: { projectId } }),
    ]);
    return {
      environments: envs.map((env) => {
        const runtime = EnvironmentRuntime.parse(env.runtime);
        return {
          id: env.id,
          name: env.name,
          baseUrl: env.baseUrl,
          revision: env.revision,
          buildConfigured: !!runtime.buildProbe,
          roles: [
            ...new Set([
              ...Object.keys(runtime.secretRefs),
              ...preps
                .filter((p) => p.environmentId === env.id)
                .map((p) => p.role),
            ]),
          ].map((role) => {
            const p = preps.find(
              (p) => p.environmentId === env.id && p.role === role,
            );
            return {
              role,
              configured: !!p?.configuration,
              checked: !!p?.lastCheckAt,
              valid: !!p && loginFresh(p, env.revision),
              expired:
                !!p &&
                p.lastCheckStatus === "PASS" &&
                !loginFresh(p, env.revision),
              status: p?.lastCheckStatus ?? "NEVER_CHECKED",
              lastCheckAt: p?.lastCheckAt,
              lastCheckJobId: p?.lastCheckJobId,
            };
          }),
        };
      }),
    };
  });
}
