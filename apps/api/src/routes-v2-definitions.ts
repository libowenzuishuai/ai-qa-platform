import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  WorkflowDefinitionContent,
  computeAstHash,
  validateGraph,
} from "@ai-qa/contracts";
import { requireAuth, requireProjectAccess } from "./auth.js";
import { ApiError } from "./errors.js";

/**
 * W06（HAR-05）：组合定义 API——画布与表单共享同一 AST（本表即 AST 权威）。
 * 草稿可编辑；发布版本不可变；发布前静态校验（环/闭包/递归/无界）。
 */

export function registerV2DefinitionRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const param = (req: FastifyRequest, key: string) =>
    (req.params as Record<string, string>)[key]!;

  app.post("/api/v2/projects/:id/definitions", async (req, reply) => {
    const projectId = param(req, "id");
    await requireProjectAccess(prisma, req, projectId, "LEAD");
    const content = WorkflowDefinitionContent.parse(req.body);
    const problems = validateGraph(content);
    if (!problems.ok)
      throw new ApiError("VALIDATION_ERROR", "图静态校验未通过（不保存）", { problems: problems.problems.slice(0, 10) });
    const astHash = computeAstHash(content);
    const saved = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${projectId} FOR UPDATE`;
      const existing = await tx.v2WorkflowDefinition.findFirst({
        where: { projectId, name: content.name, astHash, status: { in: ["DRAFT", "PUBLISHED"] } },
      });
      if (existing) return { definitionId: existing.id, version: existing.version, status: existing.status, existed: true, astHash };
      const version = (await tx.v2WorkflowDefinition.count({ where: { projectId, name: content.name } })) + 1;
      const created = await tx.v2WorkflowDefinition.create({
        data: {
          projectId, name: content.name, version, status: "DRAFT",
          content: content as never, astHash, createdBy: requireAuth(req).userId,
        },
      });
      return { definitionId: created.id, version, status: "DRAFT", existed: false, astHash };
    });
    return saved.existed
      ? reply.code(200).send(saved)
      : reply.code(202).send(saved);
  });

  app.get("/api/v2/projects/:id/definitions", async (req) => {
    const projectId = param(req, "id");
    await requireProjectAccess(prisma, req, projectId, "VIEWER");
    return {
      definitions: await prisma.v2WorkflowDefinition.findMany({
        where: { projectId },
        orderBy: [{ name: "asc" }, { version: "desc" }],
        take: 100,
        select: { id: true, name: true, version: true, status: true, astHash: true, createdAt: true, publishedAt: true },
      }),
    };
  });

  app.post("/api/v2/definitions/:id/publish", async (req) => {
    const id = param(req, "id");
    const row = await prisma.v2WorkflowDefinition.findUnique({ where: { id } });
    if (!row) throw new ApiError("NOT_FOUND", "定义不存在");
    await requireProjectAccess(prisma, req, row.projectId, "LEAD");
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "V2WorkflowDefinition" WHERE id=${id} FOR UPDATE`;
      const fresh = await tx.v2WorkflowDefinition.findUniqueOrThrow({ where: { id } });
      if (fresh.status === "PUBLISHED") return fresh; // 幂等
      if (fresh.status !== "DRAFT") throw new ApiError("CONFLICT", `状态 ${fresh.status} 不能发布`);
      // 发布重校验：内容哈希一致 + 静态校验通过。
      const content = fresh.content as unknown as WorkflowDefinitionContent;
      if (computeAstHash(content) !== fresh.astHash)
        throw new ApiError("CONFLICT", "AST 哈希不一致（拒绝发布）");
      const check = validateGraph(content);
      if (!check.ok)
        throw new ApiError("VALIDATION_ERROR", "发布前静态校验未通过", { problems: check.problems.slice(0, 10) });
      const updated = await tx.v2WorkflowDefinition.update({
        where: { id }, data: { status: "PUBLISHED", publishedAt: new Date() },
      });
      await tx.auditEvent.create({
        data: {
          actorId: requireAuth(req).userId, action: "v2.definition.publish",
          entityType: "V2WorkflowDefinition", entityId: id,
          metadata: { astHash: fresh.astHash } as never,
        },
      });
      return updated;
    });
  });
}
