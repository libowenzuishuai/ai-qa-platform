import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { ClarificationResolveRequest } from "@ai-qa/contracts";
import { requireAuth, requireProjectAccess } from "./auth.js";
import { ApiError } from "./errors.js";

export async function reviewRule(prisma: PrismaClient, req: import("fastify").FastifyRequest, status: "APPROVED" | "REJECTED") {
  const auth = requireAuth(req);
  const { id } = z.object({ id: z.string() }).parse(req.params);
  const rule = await prisma.ruleVersion.findUnique({ where: { id }, include: { rule: true } });
  if (!rule) throw new ApiError("NOT_FOUND", "规则不存在");
  await requireProjectAccess(prisma, req, rule.rule.projectId, "LEAD");
  return prisma.$transaction(async tx => {
    // Serialize review/clarification changes in this project, including conflicting approvals.
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${rule.rule.projectId} FOR UPDATE`;
    const current = await tx.ruleVersion.findUniqueOrThrow({ where: { id } });
    if (current.reviewStatus === status) return { ok: true, id, reviewStatus: status };
    if (!["DRAFT", "NEEDS_REVIEW"].includes(current.reviewStatus)) throw new ApiError("CONFLICT", "已审阅版本不能原地变更，请新建版本");
    if (status === "APPROVED") {
      const pending = await tx.clarification.count({ where: { projectId: rule.rule.projectId, ruleVersionIds: { has: id }, resolvedAt: null } });
      if (pending) throw new ApiError("CONFLICT", "请先回答并确认该规则的澄清问题");
      const conflicts = z.array(z.string()).parse(current.conflictsWith);
      if (conflicts.length) {
        const others = await tx.ruleVersion.findMany({ where: { id: { in: conflicts } }, include: { rule: true } });
        if (others.length !== conflicts.length || others.some(r => r.rule.projectId !== rule.rule.projectId || !["REJECTED", "SUPERSEDED"].includes(r.reviewStatus))) throw new ApiError("CONFLICT", "冲突规则须先明确取舍并驳回或替代，不能同时批准");
      }
    }
    await tx.ruleVersion.update({ where: { id }, data: { reviewStatus: status, reviewedBy: auth.username, reviewedAt: new Date() } });
    await tx.auditEvent.create({ data: { actorId: auth.userId, action: status === "APPROVED" ? "ruleVersion.approve" : "ruleVersion.reject", entityType: "RuleVersion", entityId: id, afterRef: JSON.stringify({ reviewStatus: status }) } });
    return { ok: true, id, reviewStatus: status };
  });
}

export function registerReviewRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.post("/api/rule-versions/:id/reject", req => reviewRule(prisma, req, "REJECTED"));
  app.post("/api/clarifications/:id/resolve", async req => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = ClarificationResolveRequest.parse(req.body);
    const clarification = await prisma.clarification.findUnique({ where: { id } });
    if (!clarification) throw new ApiError("NOT_FOUND", "澄清不存在");
    await requireProjectAccess(prisma, req, clarification.projectId, "LEAD");
    return prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${clarification.projectId} FOR UPDATE`;
      const current = await tx.clarification.findUniqueOrThrow({ where: { id } });
      if (current.resolvedAt) {
        if (current.answer === body.answer && current.answerSource === body.answerSource) return { ok: true, id };
        throw new ApiError("CONFLICT", "已确认回答不可覆盖；需求变更请新增规则版本与澄清");
      }
      const rules = await tx.ruleVersion.findMany({ where: { id: { in: current.ruleVersionIds } }, include: { rule: true } });
      if (rules.length !== current.ruleVersionIds.length || rules.some(r => r.rule.projectId !== current.projectId || r.semanticFrozen)) throw new ApiError("CONFLICT", "关联规则不存在、跨项目或已冻结，不能追加改变批准依据");
      await tx.clarification.update({ where: { id }, data: { ...body, resolvedBy: auth.username, resolvedAt: new Date() } });
      await tx.auditEvent.create({ data: { actorId: auth.userId, action: "clarification.resolve", entityType: "Clarification", entityId: id, afterRef: JSON.stringify(body) } });
      return { ok: true, id };
    });
  });
  app.get("/api/projects/:id/review", async req => {
    requireAuth(req);
    const { id: projectId } = z.object({ id: z.string() }).parse(req.params);
    await requireProjectAccess(prisma, req, projectId, "VIEWER");
    const page=z.coerce.number().int().min(1).max(100000).default(1).parse((req.query as {page?:unknown}).page),pageSize=30;
    const paging={orderBy:[{createdAt:'desc' as const},{id:'asc' as const}],skip:(page-1)*pageSize,take:pageSize};
    const [rules,clarifications,cases,jobs,ruleCount,clarificationCount,caseCount,jobCount]=await Promise.all([
      prisma.ruleVersion.findMany({where:{rule:{projectId}},...paging}),
      prisma.clarification.findMany({where:{projectId},...paging}),
      prisma.testCaseVersion.findMany({where:{projectId},...paging}),
      prisma.job.findMany({where:{projectId},...paging}),
      prisma.ruleVersion.count({where:{rule:{projectId}}}),prisma.clarification.count({where:{projectId}}),
      prisma.testCaseVersion.count({where:{projectId}}),prisma.job.count({where:{projectId}}),
    ]);
    return {rules,clarifications,cases,jobs,page,pageSize,totals:{rules:ruleCount,clarifications:clarificationCount,cases:caseCount,jobs:jobCount},totalPages:Math.max(1,Math.ceil(Math.max(ruleCount,clarificationCount,caseCount,jobCount)/pageSize))};
  });
}
