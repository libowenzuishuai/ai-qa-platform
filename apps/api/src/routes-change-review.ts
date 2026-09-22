import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { ArtifactStore } from "@ai-qa/artifact-store";
import type { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ChangeReviewJobRequest,
  ChangeReviewResolution,
  ChangeReviewAnalysisInput,
  ChangeReviewAnalysisOutput,
  RuleVersion,
  BusinessField,
  RuleSource,
} from "@ai-qa/contracts";
import { requireAuth, requireProjectAccess } from "./auth.js";
import { ApiError } from "./errors.js";
import {
  contentHash,
  freezeReviewInput,
  loadReviewBundle,
  reviewTasks,
  ruleWire,
  verifyReviewOutput,
} from "./change-review-service.js";

export function registerChangeReviewRoutes(
  app: FastifyInstance,
  db: PrismaClient,
  store: ArtifactStore,
  queue: Pick<Queue, "add">,
) {
  const id = (req: any) =>
    z.object({ id: z.string().min(1) }).parse(req.params).id;
  async function owned(req: any, write = false) {
    const r = await db.changeReview.findUnique({
      where: { id: id(req) },
      include: { job: true },
    });
    if (!r) throw new ApiError("NOT_FOUND", "变更复核不存在");
    await requireProjectAccess(db, req, r.projectId, write ? "LEAD" : "VIEWER");
    if (
      contentHash(r.input) !== r.inputHash ||
      (r.output && contentHash(r.output) !== r.outputHash)
    )
      throw new ApiError("CONFLICT", "复核快照校验失败");
    return r;
  }
  app.get("/api/projects/:id/changes", async (req) => {
    const projectId = id(req);
    await requireProjectAccess(db, req, projectId, "VIEWER");
    const q = z
      .object({ page: z.coerce.number().int().min(1).default(1) })
      .parse(req.query);
    const [reviews, total, documents, baselines] = await Promise.all([
      db.changeReview.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        take: 30,
        skip: (q.page - 1) * 30,
        select: {
          id: true,
          createdAt: true,
          baselineId: true,
          oldDocumentVersionId: true,
          newDocumentVersionId: true,
          job: { select: { status: true, error: true } },
        },
      }),
      db.changeReview.count({ where: { projectId } }),
      db.document.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        take:30,skip:(q.page-1)*30,
        include: {
          versions: {
            where: { parseStatus: { in: ["PARSED", "NEEDS_OCR"] } },
            orderBy: { version: "desc" },
            select: { id: true, version: true, parseStatus: true },
          },
        },
      }),
      db.baseline.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        take:30,skip:(q.page-1)*30,
        select: { id: true, name: true },
      }),
    ]);
    return {
      reviews,
      total,
      page: q.page,
      documents,
      baselines,
      selectionLimit:30,selectionTotal:Math.max(await db.document.count({where:{projectId}}),await db.baseline.count({where:{projectId}})),
    };
  });
  app.post("/api/projects/:id/changes", async (req, reply) => {
    const projectId = id(req);
    await requireProjectAccess(db, req, projectId, "LEAD");
    const body = ChangeReviewJobRequest.parse(req.body),
      fingerprint = contentHash({ key: body.idempotencyKey });
    const saved = await db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${projectId} FOR UPDATE`;
        const old = await tx.job.findUnique({
          where: {
            projectId_kind_fingerprint: {
              projectId,
              kind: "CHANGE_REVIEW",
              fingerprint,
            },
          },
          include: { changeReview: true },
        });
        if (old) {
          if ((old.request as any).bodyHash !== contentHash(body))
            throw new ApiError(
              "IDEMPOTENCY_CONFLICT",
              "该幂等键已用于不同的变更",
            );
          return { job: old, review: old.changeReview!, existed: true };
        }
        const frozen = await freezeReviewInput(
          tx,
          store,
          projectId,
          body.baselineId,
          body.oldDocumentVersionId,
          body.newDocumentVersionId,
        );
        const job = await tx.job.create({
          data: {
            projectId,
            kind: "CHANGE_REVIEW",
            fingerprint,
            request: {
              ...body,
              bodyHash: contentHash(body),
              mode: frozen.mode,
            },
          },
        });
        const review = await tx.changeReview.create({
          data: {
            projectId,
            jobId: job.id,
            baselineId: body.baselineId,
            oldDocumentVersionId: body.oldDocumentVersionId,
            newDocumentVersionId: body.newDocumentVersionId,
            input: frozen.input as never,
            inputHash: contentHash(frozen.input),
          },
        });
        await tx.auditEvent.create({
          data: {
            actorId: requireAuth(req).userId,
            action: "changeReview.create",
            entityType: "ChangeReview",
            entityId: review.id,
            metadata: { baselineId: body.baselineId },
          },
        });
        return { job, review, existed: false };
      },
      { timeout: 30000 },
    );
    if (saved.job.status === "QUEUED")
      try {
        await queue.add(
          "run",
          { jobId: saved.job.id },
          { removeOnComplete: true, removeOnFail: 200 },
        );
      } catch {
        /* Durable reconciliation enqueues it again. */
      }
    return reply
      .code(saved.existed ? 200 : 202)
      .send({
        reviewId: saved.review.id,
        jobId: saved.job.id,
        existed: saved.existed,
      });
  });
  app.get("/api/changes/:id", async (req) => {
    const r = await owned(req);
    if (r.output) verifyReviewOutput(r.input, r.output);
    const input = ChangeReviewAnalysisInput.parse(r.input),
      tasks = reviewTasks(r.output),
      resolutions = r.resolutions as Record<string, unknown>;
    const [rules, cases, runs] = await Promise.all([
      db.ruleVersion.findMany({
        where: {
          rule: { projectId: r.projectId },
          ruleId: { in: input.approvedRuleVersions.map((x) => x.ruleId) },
        },
        orderBy: { version: "desc" },
      }),
      db.testCaseVersion.findMany({
        where: {
          projectId: r.projectId,
          caseId: { in: input.approvedCaseVersions.map((x) => x.caseId) },
        },
        include: { plans: { select: { id: true } } },
        orderBy: { version: "desc" },
      }),
      db.run.findMany({
        where: {
          projectId: r.projectId,
          baselineId: r.baselineId,
          lifecycle: { in: ["FINISHED", "ERROR", "CANCELLED"] },
        },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: {
          id: true,
          buildId: true,
          lifecycle: true,
          acceptanceStatus: true,
        },
      }),
    ]);
    return {
      ...r,
      tasks,
      pendingCount: tasks.filter((t) => !resolutions[t.key]).length,
      rules,
      cases,
      runs,
    };
  });
  app.post("/api/changes/:id/resolve", async (req) => {
    const initial = await owned(req, true),
      body = ChangeReviewResolution.parse(req.body);
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ChangeReview" WHERE id=${initial.id} FOR UPDATE`;
      const r = await tx.changeReview.findUniqueOrThrow({
        where: { id: initial.id },
        include: { job: true },
      });
      if (r.job.status !== "SUCCEEDED" || !r.output)
        throw new ApiError("CONFLICT", "分析尚未完成");
      const key = body.assetType + ":" + body.assetVersionId;
      if (!reviewTasks(r.output).some((t) => t.key === key))
        throw new ApiError("VALIDATION_ERROR", "资产不在本次受影响范围");
      const resolutions = r.resolutions as Record<string, any>;
      if (resolutions[key]) {
        if (resolutions[key].fingerprint !== contentHash(body))
          throw new ApiError("CONFLICT", "已确认决策不可覆盖，请新建分析");
        return resolutions[key];
      }
      if (body.decision === "REPLACED") {
        const frozen = ChangeReviewAnalysisInput.parse(r.input);
        const ruleId = frozen.approvedRuleVersions.find(
          (x) => x.id === body.assetVersionId,
        )?.ruleId;
        const caseId = frozen.approvedCaseVersions.find(
          (x) => x.id === body.assetVersionId,
        )?.caseId;
        const replacement =
          body.assetType === "RULE"
            ? await tx.ruleVersion.findFirst({
                where: {
                  id: body.replacementVersionId,
                  rule: { projectId: r.projectId },
                  reviewStatus: "APPROVED",
                  ruleId,
                  supersedesId: body.assetVersionId,
                },
              })
            : await tx.testCaseVersion.findFirst({
                where: {
                  id: body.replacementVersionId,
                  projectId: r.projectId,
                  approvalStatus: "APPROVED",
                  caseId,
                  supersedesId: body.assetVersionId,
                },
              });
        if (!replacement)
          throw new ApiError(
            "VALIDATION_ERROR",
            "请选择同项目中直接替代旧版本且已批准的新版本",
          );
      }
      if (body.assetType === "CASE") {
        const input = ChangeReviewAnalysisInput.parse(r.input),
          old = input.approvedCaseVersions.find(
            (c) => c.id === body.assetVersionId,
          )!;
        const affected = ChangeReviewAnalysisOutput.parse(
          r.output,
        ).impact.affectedRules.map((r) => r.ruleVersionId);
        for (const rid of old.ruleVersionIds.filter((id) =>
          affected.includes(id),
        )) {
          const decision = resolutions["RULE:" + rid];
          if (!decision)
            throw new ApiError("CONFLICT", "请先完成该用例关联规则的复核");
          if (decision.decision === "REPLACED") {
            if (body.decision !== "REPLACED")
              throw new ApiError(
                "CONFLICT",
                "规则已更新，用例必须使用批准的新版本",
              );
            const next = await tx.testCaseVersion.findUniqueOrThrow({
              where: { id: body.replacementVersionId! },
            });
            if (
              !next.ruleVersionIds.includes(decision.replacementVersionId) ||
              next.ruleVersionIds.includes(rid)
            )
              throw new ApiError("CONFLICT", "新用例未引用更新后的规则");
          }
        }
      }
      const result = {
        ...body,
        fingerprint: contentHash(body),
        actorId: requireAuth(req).userId,
        createdAt: new Date().toISOString(),
      };
      await tx.changeReview.update({
        where: { id: r.id },
        data: { resolutions: { ...resolutions, [key]: result } },
      });
      await tx.auditEvent.create({
        data: {
          actorId: requireAuth(req).userId,
          action: "changeReview.resolve",
          entityType: "ChangeReview",
          entityId: r.id,
          metadata: result,
        },
      });
      return result;
    });
  });
  app.post("/api/changes/:id/revise-rule", async (req) => {
    const r = await owned(req, true);
    if (r.job.status !== "SUCCEEDED" || !r.output)
      throw new ApiError("CONFLICT", "分析尚未完成");
    const body = z
      .object({
        ruleVersionId: z.string(),
        statement: z.string().trim().min(1),
        classification: z.enum(["EXPLICIT", "INFERRED", "UNKNOWN"]),
        role: z.string().trim().min(1),
        action: z.string().trim().min(1),
        expectation: z.string().trim().min(1),
        sourceSpanIds: z.array(z.string()).min(1),
        businessFields: z.array(BusinessField).default([]),
        precondition: z.string().default(""),
        condition: z.string().default(""),
        forbiddenBehaviors: z.array(z.string()).default([]),
        reason: z.string().trim().min(5),
      })
      .strict()
      .parse(req.body);
    if (
      !reviewTasks(r.output).some((t) => t.key === "RULE:" + body.ruleVersionId)
    )
      throw new ApiError("VALIDATION_ERROR", "规则不在受影响清单");
    const next = await loadReviewBundle(
      db,
      store,
      r.projectId,
      r.newDocumentVersionId,
    );
    const selected = next.bundle.spans.filter((s) =>
      body.sourceSpanIds.includes(s.id),
    );
    if (
      selected.length !== new Set(body.sourceSpanIds).size ||
      selected.some(
        (s) =>
          s.extractionQuality === "UNPARSED" ||
          (body.classification === "EXPLICIT" &&
            s.extractionQuality !== "GOOD"),
      )
    )
      throw new ApiError("VALIDATION_ERROR", "所选来源不支持该规则的依据等级");
    return db.$transaction(async (tx) => {
      const old = await tx.ruleVersion.findFirstOrThrow({
        where: { id: body.ruleVersionId, rule: { projectId: r.projectId } },
      });
      await tx.$queryRaw`SELECT id FROM "Rule" WHERE id=${old.ruleId} FOR UPDATE`;
      // Exact duplicate form submission reuses its previously created revision.
      const marker = contentHash({ review: r.id, ...body });
      const prior = await tx.auditEvent.findFirst({
        where: { action: "changeReview.reviseRule", beforeRef: marker },
      });
      if (prior)
        return tx.ruleVersion.findUniqueOrThrow({
          where: { id: prior.entityId },
        });
      const latest = await tx.ruleVersion.findFirstOrThrow({
        where: { ruleId: old.ruleId },
        orderBy: { version: "desc" },
      });
      const sources = [
        ...z
          .array(RuleSource)
          .parse(old.sources)
          .filter((s) => s.documentVersionId !== r.oldDocumentVersionId),
        {
          documentVersionId: r.newDocumentVersionId,
          sourceSpanIds: [...new Set(body.sourceSpanIds)],
        },
      ];
      const draft = RuleVersion.parse({
        ...ruleWire(old),
        id: randomUUID(),
        version: latest.version + 1,
        supersedesId: old.id,
        statement: body.statement,
        classification: body.classification,
        role: body.role,
        action: body.action,
        expectation: body.expectation,
        businessFields: body.businessFields,
        precondition: body.precondition,
        condition: body.condition,
        forbiddenBehaviors: body.forbiddenBehaviors,
        sources,
        reviewStatus: "DRAFT",
        reviewedAt: null,
        reviewedBy: null,
        origin: "manual",
        promptVersion: null,
        createdAt: new Date().toISOString(),
      });
      const saved = await tx.ruleVersion.create({
        data: {
          ...draft,
          reviewedAt: null,
          createdAt: new Date(draft.createdAt),
        } as never,
      });
      await tx.rule.update({
        where: { id: old.ruleId },
        data: { currentVersionId: saved.id },
      });
      await tx.auditEvent.create({
        data: {
          actorId: requireAuth(req).userId,
          action: "changeReview.reviseRule",
          entityType: "RuleVersion",
          entityId: saved.id,
          beforeRef: marker,
          metadata: {
            reviewId: r.id,
            reason: body.reason,
            oldVersionId: old.id,
          },
        },
      });
      return saved;
    });
  });
  app.post("/api/changes/:id/baseline", async (req) => {
    const initial = await owned(req, true);
    const body = z
      .object({ name: z.string().trim().min(1).max(200) })
      .strict()
      .parse(req.body);
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ChangeReview" WHERE id=${initial.id} FOR UPDATE`;
      const r = await tx.changeReview.findUniqueOrThrow({
        where: { id: initial.id },
        include: { job: true },
      });
      const resolutions = r.resolutions as Record<string, any>;
      if (resolutions.BASELINE)
        return tx.baseline.findUniqueOrThrow({
          where: { id: resolutions.BASELINE.id },
        });
      if (
        r.job.status !== "SUCCEEDED" ||
        !r.output ||
        reviewTasks(r.output).some((t) => !resolutions[t.key])
      )
        throw new ApiError("CONFLICT", "请先完成全部变更待办");
      const old = await tx.baseline.findFirstOrThrow({
        where: { id: r.baselineId, projectId: r.projectId },
      });
      const replace = (type: string, id: string) =>
        resolutions[type + ":" + id]?.replacementVersionId ?? id;
      const ruleVersionIds = old.ruleVersionIds.map((id) =>
          replace("RULE", id),
        ),
        caseVersionIds = old.caseVersionIds.map((id) => replace("CASE", id));
      const rules = await tx.ruleVersion.findMany({
        where: {
          id: { in: ruleVersionIds },
          rule: { projectId: r.projectId },
          reviewStatus: "APPROVED",
        },
      });
      const cases = await tx.testCaseVersion.findMany({
        where: {
          id: { in: caseVersionIds },
          projectId: r.projectId,
          approvalStatus: "APPROVED",
        },
      });
      if (
        rules.length !== ruleVersionIds.length ||
        cases.length !== caseVersionIds.length ||
        cases.some((c) =>
          c.ruleVersionIds.some((id) => !ruleVersionIds.includes(id)),
        )
      )
        throw new ApiError("CONFLICT", "新版基线规则与用例引用不一致");
      const baseline = await tx.baseline.create({
        data: {
          projectId: r.projectId,
          name: body.name,
          ruleVersionIds,
          caseVersionIds,
          scope: old.scope as never,
          exclusions: old.exclusions as never,
        },
      });
      await tx.changeReview.update({
        where: { id: r.id },
        data: {
          resolutions: {
            ...resolutions,
            BASELINE: { id: baseline.id, actorId: requireAuth(req).userId },
          },
        },
      });
      await tx.auditEvent.create({
        data: {
          actorId: requireAuth(req).userId,
          action: "changeReview.baseline",
          entityType: "Baseline",
          entityId: baseline.id,
          beforeRef: old.id,
          metadata: { reviewId: r.id },
        },
      });
      return baseline;
    });
  });
}
