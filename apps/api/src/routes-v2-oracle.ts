import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  OracleSpec,
  computeOracleHash,
  type OracleSpecContent,
} from "@ai-qa/contracts";
import { requireAuth, requireProjectAccess } from "./auth.js";
import { ApiError } from "./errors.js";

/**
 * v2 OracleSpec（DES-03）：从批准规则生成不可变判定契约。
 * 服务端确定性生成（不调用模型）：每条 APPROVED 规则冻结一条必需断言
 * （expectation 原文/数值），六维覆盖初始 planned；批准后不可变。
 */

export function registerV2OracleRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const param = (req: FastifyRequest, key: string) =>
    (req.params as Record<string, string>)[key]!;

  app.post("/api/v2/projects/:id/oracle-specs", async (req, reply) => {
    const projectId = param(req, "id");
    await requireProjectAccess(prisma, req, projectId, "LEAD");
    const body = z
      .object({
        ruleVersionIds: z.array(z.string().min(1)).min(1).max(500),
        supersedesId: z.string().optional(),
      })
      .strict()
      .parse(req.body);

    // 引用闭包：全部 APPROVED 且同项目（DRAFT/REJECTED 拒绝）。
    const rules = await prisma.ruleVersion.findMany({
      where: { id: { in: body.ruleVersionIds }, rule: { projectId } },
      orderBy: { id: "asc" },
    });
    if (rules.length !== new Set(body.ruleVersionIds).size)
      throw new ApiError("VALIDATION_ERROR", "存在不属于本项目或不存在的规则版本");
    const notApproved = rules.filter((r) => r.reviewStatus !== "APPROVED");
    if (notApproved.length)
      throw new ApiError("VALIDATION_ERROR", `未批准规则不能冻结为标准：${notApproved.map((r) => r.id).join("、")}`);

    // 确定性生成：每条规则一条必需断言（expectation 冻结为期望值）。
    const content: OracleSpecContent = {
      projectId,
      ruleVersionIds: rules.map((r) => r.id),
      assertions: rules.map((rule) => {
        const expectation = String(rule.expectation ?? "");
        return {
          id: `a-${rule.id}`,
          ruleVersionId: rule.id,
          kind: "deterministic" as const,
          operator: "equals" as const,
          expected: expectation.length > 0 ? expectation : null,
          unit: null,
          allowedRoles: rule.role ? [rule.role] : [],
          required: true,
        };
      }),
      semanticCandidates: [],
      coverageDeclarations: rules.flatMap((rule) =>
        (["normal", "boundary"] as const).map((dimension) => ({
          ruleVersionId: rule.id,
          dimension,
          status: "planned" as const,
          reason: "初始生成：正常与边界维度待计划",
        })),
      ),
    };
    const oracleHash = computeOracleHash(content);
    const parsed = OracleSpec.safeParse({
      ...content,
      id: "pending", version: 1, status: "DRAFT",
      oracleHash, supersedesId: body.supersedesId ?? null,
      createdBy: requireAuth(req).userId, createdAt: new Date().toISOString(),
    });
    if (!parsed.success)
      throw new ApiError("VALIDATION_ERROR", "生成的 Oracle 不符合契约", parsed.error.issues.slice(0, 5));

    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${projectId} FOR UPDATE`;
      // 同内容幂等：已有同哈希 DRAFT/APPROVED 直接返回。
      const existing = await tx.v2OracleSpec.findFirst({
        where: { projectId, oracleHash, status: { in: ["DRAFT", "APPROVED"] } },
      });
      if (existing) return { oracleSpecId: existing.id, version: existing.version, status: existing.status, existed: true, oracleHash };
      // supersedes 链：前置版本标记 SUPERSEDED（历史可查，不可改）。
      if (body.supersedesId) {
        const prior = await tx.v2OracleSpec.findFirst({
          where: { id: body.supersedesId, projectId },
        });
        if (!prior) throw new ApiError("VALIDATION_ERROR", "被替代的 Oracle 不存在");
        if (prior.status === "APPROVED" && prior.oracleHash === oracleHash)
          throw new ApiError("CONFLICT", "内容与被替代版本相同：需求未变不应新版本");
        await tx.v2OracleSpec.update({ where: { id: prior.id }, data: { status: "SUPERSEDED" } });
      }
      const version = (await tx.v2OracleSpec.count({ where: { projectId } })) + 1;
      const created = await tx.v2OracleSpec.create({
        data: {
          projectId, version, status: "DRAFT",
          ruleVersionIds: content.ruleVersionIds,
          assertions: content.assertions as never,
          semanticCandidates: [],
          coverageDeclarations: content.coverageDeclarations as never,
          oracleHash, supersedesId: body.supersedesId ?? null,
          createdBy: requireAuth(req).userId,
        },
      });
      await tx.auditEvent.create({
        data: {
          actorId: requireAuth(req).userId, action: "v2.oracle.create",
          entityType: "V2OracleSpec", entityId: created.id,
          metadata: { oracleHash, rules: content.ruleVersionIds.length } as never,
        },
      });
      return reply.code(202).send({ oracleSpecId: created.id, version, status: "DRAFT", existed: false, oracleHash });
    });
  });

  app.post("/api/v2/oracle-specs/:id/approve", async (req) => {
    const id = param(req, "id");
    const spec = await prisma.v2OracleSpec.findUnique({ where: { id } });
    if (!spec) throw new ApiError("NOT_FOUND", "Oracle 不存在");
    await requireProjectAccess(prisma, req, spec.projectId, "LEAD");
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "V2OracleSpec" WHERE id=${id} FOR UPDATE`;
      const fresh = await tx.v2OracleSpec.findUniqueOrThrow({ where: { id } });
      if (fresh.status === "APPROVED") return fresh; // 幂等
      if (fresh.status !== "DRAFT") throw new ApiError("CONFLICT", `状态为 ${fresh.status}，仅 DRAFT 可批准`);
      const updated = await tx.v2OracleSpec.update({
        where: { id },
        data: { status: "APPROVED", approvedBy: requireAuth(req).userId, approvedAt: new Date() },
      });
      await tx.auditEvent.create({
        data: {
          actorId: requireAuth(req).userId, action: "v2.oracle.approve",
          entityType: "V2OracleSpec", entityId: id,
          metadata: { oracleHash: fresh.oracleHash } as never,
        },
      });
      return updated;
    });
  });

  app.get("/api/v2/projects/:id/oracle-specs", async (req) => {
    const projectId = param(req, "id");
    await requireProjectAccess(prisma, req, projectId, "VIEWER");
    const specs = await prisma.v2OracleSpec.findMany({
      where: { projectId },
      orderBy: { version: "desc" },
      take: 50,
    });
    return {
      oracleSpecs: specs.map((s) => ({
        id: s.id, version: s.version, status: s.status, oracleHash: s.oracleHash,
        ruleVersionIds: s.ruleVersionIds, createdAt: s.createdAt,
        approvedAt: s.approvedAt, supersedesId: s.supersedesId,
      })),
    };
  });

  app.get("/api/v2/oracle-specs/:id", async (req) => {
    const id = param(req, "id");
    const spec = await prisma.v2OracleSpec.findUnique({ where: { id } });
    if (!spec) throw new ApiError("NOT_FOUND", "Oracle 不存在");
    await requireProjectAccess(prisma, req, spec.projectId, "VIEWER");
    // 读取时契约复验（哈希与内容一致）。
    const content: OracleSpecContent = {
      projectId: spec.projectId,
      ruleVersionIds: spec.ruleVersionIds,
      assertions: spec.assertions as never,
      semanticCandidates: spec.semanticCandidates as never,
      coverageDeclarations: spec.coverageDeclarations as never,
    };
    if (computeOracleHash(content) !== spec.oracleHash)
      throw new ApiError("CONFLICT", "Oracle 内容与哈希不一致（拒绝读取）");
    return { ...spec, assertions: content.assertions, semanticCandidates: content.semanticCandidates, coverageDeclarations: content.coverageDeclarations };
  });
}
