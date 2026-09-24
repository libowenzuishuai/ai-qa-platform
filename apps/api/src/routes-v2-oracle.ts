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
 * v2 OracleSpec（DES-03，R0.5 修正）：
 * 自然语言 expectation 不自动转成 deterministic 断言——创建时必须提供
 * 显式结构化映射（fact/observationType/operator/expected/precondition/unit/tolerance）；
 * 无映射的规则进入 semanticCandidates（待人工澄清），不伪造可执行断言。
 * supersede 在新版本【批准时】原子完成，新 DRAFT 不使旧批准失效。
 * 批准时重验闭包、哈希、六维覆盖与断言类型。
 */

const AssertionMappingInput = z.object({
  ruleVersionId: z.string().min(1),
  fact: z.string().min(1).max(500),
  observationType: z.enum(["ui_text", "ui_visible", "api_field", "api_status", "db_value"]),
  observationRef: z.string().min(1).max(300),
  operator: z.enum(["equals", "not_equals", "greater_than", "less_than", "exists", "not_exists", "visible", "hidden"]),
  expected: z.union([z.string().regex(/^-?\d+(\.\d+)?$/), z.boolean(), z.string().min(1).max(2000), z.null()]),
  precondition: z.string().max(1000).nullable().default(null),
  unit: z.string().min(1).max(64).nullable().default(null),
  tolerance: z.string().regex(/^-?\d+(\.\d+)?$/).nullable().default(null),
  allowedRoles: z.array(z.string().min(1).max(80)).max(20).default([]),
  required: z.boolean().default(true),
}).strict();

const CoverageDeclarationInput = z.object({
  ruleVersionId: z.string().min(1),
  dimension: z.enum(["normal", "boundary", "permission", "multi_role", "state", "persistence"]),
  status: z.enum(["planned", "blocked", "not_applicable"]),
  reason: z.string().min(1).max(2000),
}).strict();

export function registerV2OracleRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const param = (req: FastifyRequest, key: string) =>
    (req.params as Record<string, string>)[key]!;

  app.post("/api/v2/projects/:id/oracle-specs", async (req, reply) => {
    const projectId = param(req, "id");
    await requireProjectAccess(prisma, req, projectId, "LEAD");
    const body = z
      .object({
        ruleVersionIds: z.array(z.string().min(1)).min(1).max(500),
        /** R0.5：显式结构化映射（缺映射的规则进 semanticCandidates，不伪造断言）。 */
        assertionMappings: z.array(AssertionMappingInput).max(2000).default([]),
        coverageDeclarations: z.array(CoverageDeclarationInput).max(3000).default([]),
        /** 期望替代的旧版本（批准时原子 supersede）。 */
        supersedesId: z.string().optional(),
      })
      .strict()
      .parse(req.body);

    const rules = await prisma.ruleVersion.findMany({
      where: { id: { in: body.ruleVersionIds }, rule: { projectId } },
      orderBy: { id: "asc" },
    });
    if (rules.length !== new Set(body.ruleVersionIds).size)
      throw new ApiError("VALIDATION_ERROR", "存在不属于本项目或不存在的规则版本");
    const notApproved = rules.filter((r) => r.reviewStatus !== "APPROVED");
    if (notApproved.length)
      throw new ApiError("VALIDATION_ERROR", `未批准规则不能冻结为标准：${notApproved.map((r) => r.id).join("、")}`);
    // 映射闭包：映射只能引用声明规则（防伪造来源/跨项目）。
    const ruleIds = new Set(rules.map((r) => r.id));
    for (const m of body.assertionMappings) {
      if (!ruleIds.has(m.ruleVersionId))
        throw new ApiError("VALIDATION_ERROR", `映射引用了未声明规则：${m.ruleVersionId}`);
    }
    for (const c of body.coverageDeclarations) {
      if (!ruleIds.has(c.ruleVersionId))
        throw new ApiError("VALIDATION_ERROR", `覆盖声明引用了未声明规则：${c.ruleVersionId}`);
    }

    // 断言（仅来自显式映射）；未映射规则 → semanticCandidates 待人工。
    const assertions = body.assertionMappings.map((m, index) => ({
      id: `a-${m.ruleVersionId}-${index + 1}`,
      ruleVersionId: m.ruleVersionId,
      kind: "deterministic" as const,
      fact: m.fact,
      observationType: m.observationType,
      observationRef: m.observationRef,
      operator: m.operator,
      expected: m.expected,
      precondition: m.precondition,
      unit: m.unit,
      tolerance: m.tolerance,
      allowedRoles: m.allowedRoles,
      required: m.required,
    }));
    const mappedRules = new Set(assertions.map((a) => a.ruleVersionId));
    const semanticCandidates = rules
      .filter((r) => !mappedRules.has(r.id))
      .map((r) => ({
        id: `sc-${r.id}`,
        ruleVersionId: r.id,
        kind: "semantic_candidate" as const,
        description: `规则「${r.statement}」缺可执行映射（期望「${r.expectation}」为自然语言）：待人工澄清被测事实与观测方式`,
        expected: null,
      }));
    // 至少一条映射或全部声明 blocked——全空则不能产生任何可判定内容。
    if (assertions.length === 0)
      throw new ApiError(
        "VALIDATION_ERROR",
        "未提供任何结构化映射；全部规则只能进入待澄清（先人工映射至少一条或声明 blocked）",
        { unmappedRules: semanticCandidates.map((c) => c.id) },
      );

    const content: OracleSpecContent = {
      projectId,
      ruleVersionIds: rules.map((r) => r.id),
      assertions: assertions as never,
      semanticCandidates,
      coverageDeclarations: body.coverageDeclarations as never,
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

    const saved = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${projectId} FOR UPDATE`;
      const existing = await tx.v2OracleSpec.findFirst({
        where: { projectId, oracleHash, status: { in: ["DRAFT", "APPROVED"] } },
      });
      if (existing)
        return { oracleSpecId: existing.id, version: existing.version, status: existing.status, existed: true, oracleHash, semanticCandidates: semanticCandidates.length };
      if (body.supersedesId) {
        const prior = await tx.v2OracleSpec.findFirst({ where: { id: body.supersedesId, projectId } });
        if (!prior) throw new ApiError("VALIDATION_ERROR", "被替代的 Oracle 不存在");
        // R0.5：新 DRAFT 不使旧批准失效；仅记录链，supersede 在批准时生效。
      }
      const version = (await tx.v2OracleSpec.count({ where: { projectId } })) + 1;
      const created = await tx.v2OracleSpec.create({
        data: {
          projectId, version, status: "DRAFT",
          ruleVersionIds: content.ruleVersionIds,
          assertions: content.assertions as never,
          semanticCandidates: semanticCandidates as never,
          coverageDeclarations: content.coverageDeclarations as never,
          oracleHash, supersedesId: body.supersedesId ?? null,
          createdBy: requireAuth(req).userId,
        },
      });
      await tx.auditEvent.create({
        data: {
          actorId: requireAuth(req).userId, action: "v2.oracle.create",
          entityType: "V2OracleSpec", entityId: created.id,
          metadata: { oracleHash, rules: content.ruleVersionIds.length, mapped: assertions.length, pending: semanticCandidates.length } as never,
        },
      });
      return { oracleSpecId: created.id, version, status: "DRAFT", existed: false, oracleHash, semanticCandidates: semanticCandidates.length };
    });
    return saved.existed
      ? reply.code(200).send(saved)
      : reply.code(202).send(saved);
  });

  app.post("/api/v2/oracle-specs/:id/approve", async (req) => {
    const id = param(req, "id");
    const spec = await prisma.v2OracleSpec.findUnique({ where: { id } });
    if (!spec) throw new ApiError("NOT_FOUND", "Oracle 不存在");
    await requireProjectAccess(prisma, req, spec.projectId, "LEAD");
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "V2OracleSpec" WHERE id=${id} FOR UPDATE`;
      const fresh = await tx.v2OracleSpec.findUniqueOrThrow({ where: { id } });
      if (fresh.status === "APPROVED") return fresh;
      if (fresh.status !== "DRAFT") throw new ApiError("CONFLICT", `状态为 ${fresh.status}，仅 DRAFT 可批准`);
      // R0.5：批准时重验内容哈希与契约（六维/闭包/类型在 superRefine 内）。
      const content: OracleSpecContent = {
        projectId: fresh.projectId,
        ruleVersionIds: fresh.ruleVersionIds,
        assertions: fresh.assertions as never,
        semanticCandidates: fresh.semanticCandidates as never,
        coverageDeclarations: fresh.coverageDeclarations as never,
      };
      if (computeOracleHash(content) !== fresh.oracleHash)
        throw new ApiError("CONFLICT", "内容哈希不一致，拒绝批准（可能被篡改）");
      const check = OracleSpec.safeParse({
        ...content, id: fresh.id, version: fresh.version, status: "APPROVED",
        oracleHash: fresh.oracleHash, supersedesId: fresh.supersedesId,
        createdBy: fresh.createdBy, createdAt: fresh.createdAt.toISOString(),
        approvedBy: requireAuth(req).userId, approvedAt: new Date().toISOString(),
      });
      if (!check.success)
        throw new ApiError("VALIDATION_ERROR", "批准校验未通过", check.error.issues.slice(0, 5));
      // R0.5：supersede 与批准原子完成——旧版本此时才失效，且仅同链。
      if (fresh.supersedesId) {
        const prior = await tx.v2OracleSpec.findUnique({ where: { id: fresh.supersedesId } });
        if (prior && prior.projectId === fresh.projectId && prior.status === "APPROVED" && prior.oracleHash !== fresh.oracleHash) {
          await tx.v2OracleSpec.update({ where: { id: prior.id }, data: { status: "SUPERSEDED" } });
        }
      }
      const updated = await tx.v2OracleSpec.update({
        where: { id },
        data: { status: "APPROVED", approvedBy: requireAuth(req).userId, approvedAt: new Date() },
      });
      await tx.auditEvent.create({
        data: {
          actorId: requireAuth(req).userId, action: "v2.oracle.approve",
          entityType: "V2OracleSpec", entityId: id,
          metadata: { oracleHash: fresh.oracleHash, superseded: fresh.supersedesId ?? null } as never,
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
