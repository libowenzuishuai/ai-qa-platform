import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { Finding } from "@ai-qa/contracts";
import { requireAuth, requireProjectAccess } from "./auth.js";
import { ApiError } from "./errors.js";

/**
 * W07（INT-01～03）Finding：缺陷候选完整链。
 * 候选（无证据）→ reproduced（需证据）→ human_confirmed / fix_verified；
 * 假设（支持/反对证据分栏）；最小复现；severity 必须有依据。
 * 单次定位失败只能 candidate/investigating——证据缺失不得 reproduced。
 */

export function registerV2FindingRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const param = (req: FastifyRequest, key: string) =>
    (req.params as Record<string, string>)[key]!;

  app.post("/api/v2/projects/:id/findings", async (req, reply) => {
    const projectId = param(req, "id");
    await requireProjectAccess(prisma, req, projectId, "LEAD");
    const FindingCreate = z.object({
      oracleSpecId: z.string().optional(), ruleVersionId: z.string().optional(),
      status: z.enum(["candidate", "reproduced", "human_confirmed", "investigating", "fix_verified", "rejected"]).default("candidate"),
      expected: z.string().min(1).max(4000), actual: z.string().min(1).max(4000),
      firstFailure: z.object({
        sessionId: z.string().nullable().default(null),
        attemptId: z.string().nullable().default(null),
        runId: z.string().nullable().default(null),
        evidenceIds: z.array(z.string()).max(100).default([]),
        observedAt: z.string(),
      }).strict(),
      hypotheses: z.array(z.object({
        text: z.string().min(1).max(2000),
        supportingEvidence: z.array(z.object({ kind: z.enum(["network", "console", "auth_log", "code_diff", "observation", "tool_output"]), ref: z.string().min(1).max(500) }).strict()).max(50).default([]),
        contradictingEvidence: z.array(z.object({ kind: z.enum(["network", "console", "auth_log", "code_diff", "observation", "tool_output"]), ref: z.string().min(1).max(500) }).strict()).max(50).default([]),
        status: z.enum(["open", "supported", "refuted", "unknown"]).default("open"),
      }).strict()).max(50).default([]),
      minimalReproduction: z.object({
        steps: z.array(z.object({ action: z.string().min(1).max(500), target: z.string().max(500).nullable().default(null) }).strict()).min(1).max(100),
        resourceKeys: z.array(z.string().max(300)).max(100).default([]),
        verifiedAt: z.string().nullable().default(null),
      }).strict().nullable().default(null),
      severity: z.object({
        level: z.enum(["blocker", "critical", "major", "minor", "trivial"]),
        basis: z.string().min(1).max(2000),
      }).strict().nullable().default(null),
      dedupeKey: z.string().min(8).max(300), buildId: z.string().min(1).max(200),
      role: z.string().max(80).nullable().default(null),
    }).strict();
    const parsed = FindingCreate.safeParse(req.body);
    if (!parsed.success)
      throw new ApiError("VALIDATION_ERROR", "不符合 Finding 契约", parsed.error.issues.slice(0, 4));
    const body = parsed.data;
    // Oracle 归属（可选但须同项目）。
    if (body.oracleSpecId) {
      const oracle = await prisma.v2OracleSpec.findFirst({ where: { id: body.oracleSpecId, projectId } });
      if (!oracle) throw new ApiError("VALIDATION_ERROR", "Oracle 不属于本项目");
    }
    // 去重：同项目同 dedupeKey 已存在 → 返回既有（同根因不重复立缺陷）。
    const existing = await prisma.v2Finding.findFirst({ where: { projectId, dedupeKey: body.dedupeKey } });
    if (existing) return { findingId: existing.id, existed: true, status: existing.status };
    const created = await prisma.v2Finding.create({
      data: {
        projectId,
        oracleSpecId: body.oracleSpecId ?? null,
        ruleVersionId: body.ruleVersionId ?? null,
        status: body.status,
        expected: body.expected,
        actual: body.actual,
        firstFailure: body.firstFailure as never,
        hypotheses: body.hypotheses as never,
        minimalReproduction: body.minimalReproduction as never,
        severity: body.severity as never,
        dedupeKey: body.dedupeKey,
        buildId: body.buildId,
        role: body.role ?? null,
      },
    });
    await prisma.auditEvent.create({
      data: {
        actorId: requireAuth(req).userId, action: "v2.finding.create",
        entityType: "V2Finding", entityId: created.id,
        metadata: { dedupeKey: body.dedupeKey, status: body.status } as never,
      },
    });
    return reply.code(202).send({ findingId: created.id, existed: false, status: created.status });
  });

  app.get("/api/v2/projects/:id/findings", async (req) => {
    const projectId = param(req, "id");
    await requireProjectAccess(prisma, req, projectId, "VIEWER");
    const q = z.object({ status: z.string().optional() }).strict().parse(req.query);
    return {
      findings: await prisma.v2Finding.findMany({
        where: { projectId, status: q.status },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
    };
  });

  app.post("/api/v2/findings/:id/status", async (req) => {
    const id = param(req, "id");
    const finding = await prisma.v2Finding.findUnique({ where: { id } });
    if (!finding) throw new ApiError("NOT_FOUND", "Finding 不存在");
    await requireProjectAccess(prisma, req, finding.projectId, "LEAD");
    const body = z.object({ status: z.enum(["candidate", "reproduced", "human_confirmed", "investigating", "fix_verified", "rejected"]) }).strict().parse(req.body);
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "V2Finding" WHERE id=${id} FOR UPDATE`;
      const fresh = await tx.v2Finding.findUniqueOrThrow({ where: { id } });
      // reproduced 及以上必须已有证据（首败 evidenceIds 非空）。
      if (["reproduced", "human_confirmed", "fix_verified"].includes(body.status)) {
        const evidence = (fresh.firstFailure as { evidenceIds?: string[] }).evidenceIds ?? [];
        if (evidence.length === 0)
          throw new ApiError("CONFLICT", "无证据不得进入 reproduced/confirmed（单次定位失败≠缺陷）");
      }
      if (body.status === "fix_verified") {
        const repro = fresh.minimalReproduction as { verifiedAt?: string | null } | null;
        if (!repro?.verifiedAt)
          throw new ApiError("CONFLICT", "fix_verified 需要已验证的最小复现");
      }
      // 撤回保护：human_confirmed 后不能静默降级回 candidate（防误报洗白）。
      if (fresh.status === "human_confirmed" && body.status === "candidate")
        throw new ApiError("CONFLICT", "已人工确认的缺陷不能降级回候选（如需驳回用 rejected+依据）");
      const updated = await tx.v2Finding.update({ where: { id }, data: { status: body.status } });
      await tx.auditEvent.create({
        data: {
          actorId: requireAuth(req).userId, action: "v2.finding.status",
          entityType: "V2Finding", entityId: id,
          metadata: { from: fresh.status, to: body.status } as never,
        },
      });
      return updated;
    });
  });

  app.post("/api/v2/findings/:id/hypotheses", async (req) => {
    const id = param(req, "id");
    const finding = await prisma.v2Finding.findUnique({ where: { id } });
    if (!finding) throw new ApiError("NOT_FOUND", "Finding 不存在");
    await requireProjectAccess(prisma, req, finding.projectId, "LEAD");
    const body = z.object({
      text: z.string().min(1).max(2000),
      supportingEvidence: z.array(z.object({ kind: z.enum(["network", "console", "auth_log", "code_diff", "observation", "tool_output"]), ref: z.string().min(1).max(500) }).strict()).max(50).default([]),
      contradictingEvidence: z.array(z.object({ kind: z.enum(["network", "console", "auth_log", "code_diff", "observation", "tool_output"]), ref: z.string().min(1).max(500) }).strict()).max(50).default([]),
    }).strict().parse(req.body);
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "V2Finding" WHERE id=${id} FOR UPDATE`;
      const fresh = await tx.v2Finding.findUniqueOrThrow({ where: { id } });
      const hypotheses = (fresh.hypotheses as unknown[]) ?? [];
      hypotheses.push({
        text: body.text,
        supportingEvidence: body.supportingEvidence,
        contradictingEvidence: body.contradictingEvidence,
        status: body.supportingEvidence.length === 0 ? "unknown" : "open",
      });
      const updated = await tx.v2Finding.update({ where: { id }, data: { hypotheses: hypotheses as never } });
      return { hypotheses: updated.hypotheses };
    });
  });
}
