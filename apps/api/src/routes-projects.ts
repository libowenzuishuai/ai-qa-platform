import { projectSecretPrefix, validateSecretNamespace } from './environment-secrets.js';
import { EnvironmentRuntime } from "@ai-qa/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { ApiError } from "./errors.js";
import { requireAuth, requireProjectAccess } from "./auth.js";
import { validateEnvironmentOrigins } from "./url-policy.js";

/** 项目与环境登记（阶段 0 子集：创建/列表/详情/成员管理/环境登记）。 */

const ProjectCreate = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
});

export function registerProjectRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.post("/api/projects", async (req) => {
    const auth = requireAuth(req);
    const body = ProjectCreate.parse(req.body);
    // 平台 ADMIN / LEAD 可建项目；VIEWER 不可。
    if (auth.platformRole === "VIEWER") {
      throw new ApiError("FORBIDDEN", "查看者不能创建项目");
    }
    const project = await prisma.project.create({
      data: {
        name: body.name,
        settings: { description: body.description ?? "" },
        memberships: {
          create: { userId: auth.userId, role: "ADMIN" },
        },
      },
      include: { memberships: true },
    });
    await prisma.auditEvent.create({
      data: {
        actorId: auth.userId,
        action: "project.create",
        entityType: "Project",
        entityId: project.id,
        afterRef: JSON.stringify({ name: project.name }),
      },
    });
    return { id: project.id, name: project.name, createdAt: project.createdAt };
  });

  app.get("/api/projects", async (req) => {
    const auth = requireAuth(req);
    const memberships = await prisma.projectMembership.findMany({
      where: { userId: auth.userId },
      include: { project: true },
    });
    return {
      projects: memberships.map((m) => ({
        id: m.project.id,
        name: m.project.name,
        role: m.role,
        createdAt: m.project.createdAt,
      })),
    };
  });

  app.get("/api/projects/:projectId", async (req) => {
    const { projectId } = z.object({ projectId: z.string() }).parse(req.params);
    const { role } = await requireProjectAccess(prisma, req, projectId, "VIEWER");
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { _count: { select: { runs: true, documents: true, testCases: true } } },
    });
    if (!project) throw new ApiError("NOT_FOUND", "项目不存在");
    return { ...project, myRole: role };
  });

  app.post("/api/projects/:projectId/members", async (req) => {
    const { projectId } = z.object({ projectId: z.string() }).parse(req.params);
    await requireProjectAccess(prisma, req, projectId, "ADMIN");
    const body = z
      .object({
        username: z.string().min(1),
        role: z.enum(["ADMIN", "LEAD", "VIEWER"]),
      })
      .parse(req.body);
    const user = await prisma.user.findUnique({ where: { username: body.username } });
    if (!user) throw new ApiError("NOT_FOUND", `用户 ${body.username} 不存在`);
    const existing = await prisma.projectMembership.findUnique({
      where: { projectId_userId: { projectId, userId: user.id } },
    });
    if (existing) throw new ApiError("CONFLICT", "用户已是项目成员");
    await prisma.projectMembership.create({
      data: { projectId, userId: user.id, role: body.role },
    });
    return { ok: true };
  });

  const EnvironmentCreate = z.object({
    name: z.string().min(1).max(120),
    baseUrl: z.string().url(),
    allowedOrigins: z.array(z.string().url()).min(1),
    dependencyOrigins: z.array(z.string().url()).default([]),
    isProduction: z.boolean().default(false),
    buildId: z.string().optional(),
    runtime: EnvironmentRuntime.optional(),
  });

  app.post("/api/projects/:projectId/environments", async (req) => {
    const { projectId } = z.object({ projectId: z.string() }).parse(req.params);
    await requireProjectAccess(prisma, req, projectId, "LEAD");
    const body = EnvironmentCreate.parse(req.body);
    if (body.runtime) { await requireProjectAccess(prisma, req, projectId, "ADMIN"); validateSecretNamespace(projectId, body.runtime); }
    // 首版禁止对 production 目标做业务测试（PRD FR-12）：登记即拒绝。
    if (body.isProduction) {
      throw new ApiError(
        "UNSUPPORTED",
        "首版禁止登记生产环境作为业务测试目标",
        { field: "isProduction" },
      );
    }
    // 白名单按规范化 origin 精确比较（评审 R2），不做字符串前缀匹配。
    const originCheck = validateEnvironmentOrigins(body.baseUrl, body.allowedOrigins);
    if (!originCheck.ok) {
      throw new ApiError("VALIDATION_ERROR", originCheck.reason, {
        field: originCheck.field,
      });
    }
    const env = await prisma.environment.create({
      data: {
        projectId,
        name: body.name,
        baseUrl: body.baseUrl,
        allowedOrigins: body.allowedOrigins,
        dependencyOrigins: body.dependencyOrigins,
        isProduction: body.isProduction,
        buildMetadata: body.buildId ? { buildId: body.buildId } : {},
        runtime: body.runtime ?? {},
      },
    });
    return { id: env.id, name: env.name, createdAt: env.createdAt };
  });

  app.get("/api/projects/:projectId/environments", async (req) => {
    const { projectId } = z.object({ projectId: z.string() }).parse(req.params);
    await requireProjectAccess(prisma, req, projectId, "VIEWER");
    const envs = await prisma.environment.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    });
    return {
      environments: envs.map((e) => ({
        id: e.id,
        name: e.name,
        baseUrl: e.baseUrl,
        allowedOrigins: e.allowedOrigins,
        isProduction: e.isProduction,
        buildId: (e.buildMetadata as { buildId?: string }).buildId ?? null,
        revision: e.revision,
      })),
    };
  });
}
