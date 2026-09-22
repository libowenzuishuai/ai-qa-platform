import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { ArtifactStore } from "@ai-qa/artifact-store";
import type { Queue } from "bullmq";
import { z } from "zod";
import {
  MultiFileComparisonInput,
  MultiFileChangeReport,
} from "@ai-qa/contracts";
import { requireAuth, requireProjectAccess } from "./auth.js";
import { ApiError } from "./errors.js";
import { contentHash, loadReviewBundle } from "./change-review-service.js";

/**
 * R02 快照对比（多文件变更闭环）。
 *
 * 服务端从项目内固定 DocumentVersion 装载清单与来源（浏览器不能传任意
 * bundle/资产）；冻结输入哈希；作业幂等（projectId+kind+fingerprint 唯一）；
 * 逐文件复核（modified 需挂接已完成单文件变更复核，removed/uncertain 必须
 * 理由，renamed 确认映射不改 oldDocumentVersionId）；新基线合并已批准资产，
 * 旧基线完整保留。
 */

const FileRef = z.object({
  path: z.string().min(1).max(1024),
  documentVersionId: z.string().min(1),
}).strict();

export function registerSnapshotChangeRoutes(
  app: FastifyInstance,
  db: PrismaClient,
  store: ArtifactStore,
  queue: Pick<Queue, "add">,
) {
  const id = (req: FastifyRequest) =>
    z.object({ id: z.string().min(1) }).parse(req.params).id;

  async function owned(req: FastifyRequest, write = false) {
    const r = await db.snapshotChange.findUnique({
      where: { id: id(req) },
      include: { job: true },
    });
    if (!r) throw new ApiError("NOT_FOUND", "快照对比不存在");
    await requireProjectAccess(db, req, r.projectId, write ? "LEAD" : "VIEWER");
    if (
      contentHash(r.input) !== r.inputHash ||
      (r.output && contentHash(r.output) !== r.outputHash)
    )
      throw new ApiError("CONFLICT", "快照校验失败");
    return r;
  }

  /** 从输出推导逐文件待办（与 Python FileOutcomeKind 一一对应）。 */
  function snapshotTasks(output: unknown) {
    if (!output) return [] as { key: string; kind: string; oldPath: string | null; newPath: string | null }[];
    const o = MultiFileChangeReport.parse(output);
    return o.outcomes
      .filter((x) => x.kind !== "unchanged")
      .map((x) => ({
        key: `${x.kind}:${x.oldPath ?? x.newPath}`,
        kind: x.kind,
        oldPath: x.oldPath,
        newPath: x.newPath,
      }));
  }

  app.get("/api/projects/:id/snapshot-changes", async (req) => {
    const projectId = id(req);
    await requireProjectAccess(db, req, projectId, "VIEWER");
    const q = z
      .object({ page: z.coerce.number().int().min(1).default(1) })
      .parse(req.query);
    const [changes, total] = await Promise.all([
      db.snapshotChange.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        take: 30,
        skip: (q.page - 1) * 30,
        select: {
          id: true,
          createdAt: true,
          baselineId: true,
          oldFiles: true,
          newFiles: true,
          job: { select: { status: true, error: true } },
        },
      }),
      db.snapshotChange.count({ where: { projectId } }),
    ]);
    return { changes, total, page: q.page };
  });

  app.post("/api/projects/:id/snapshot-changes", async (req, reply) => {
    const projectId = id(req);
    await requireProjectAccess(db, req, projectId, "LEAD");
    const body = z
      .object({
        idempotencyKey: z.string().min(8).max(200),
        baselineId: z.string().min(1),
        oldFiles: z.array(FileRef).min(1).max(200),
        newFiles: z.array(FileRef).min(1).max(200),
        excludedPaths: z.array(z.string().min(1).max(1024)).max(200).default([]),
      })
      .strict()
      .parse(req.body);
    const fingerprint = contentHash({ key: body.idempotencyKey });
    const saved = await db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${projectId} FOR UPDATE`;
        const old = await tx.job.findUnique({
          where: {
            projectId_kind_fingerprint: {
              projectId,
              kind: "SNAPSHOT_DIFF",
              fingerprint,
            },
          },
          include: { snapshotChange: true },
        });
        if (old) {
          if ((old.request as { bodyHash?: string }).bodyHash !== contentHash(body))
            throw new ApiError("IDEMPOTENCY_CONFLICT", "该幂等键已用于不同的快照对比");
          return { job: old, change: old.snapshotChange!, existed: true };
        }
        // —— 服务端装载与校验（浏览器只传 documentVersionId 清单）——
        const baseline = await tx.baseline.findFirst({
          where: { id: body.baselineId, projectId },
        });
        if (!baseline) throw new ApiError("VALIDATION_ERROR", "基线不属于当前项目");
        const input = { oldFiles: [], newFiles: [] } as {
          oldFiles: { path: string; bundle: unknown }[];
          newFiles: { path: string; bundle: unknown }[];
        };
        const mode = { mock: false };
        for (const side of ["oldFiles", "newFiles"] as const) {
          const seen = new Set<string>();
          for (const entry of body[side]) {
            if (seen.has(entry.path))
              throw new ApiError("VALIDATION_ERROR", `${side} 路径重复：${entry.path}`);
            seen.add(entry.path);
            // 装载点复用单文件复核的校验：归属/解析状态/证据校验和/片段一致性。
            const loaded = await loadReviewBundle(tx, store, projectId, entry.documentVersionId);
            if (loaded.row.mode === "mock") mode.mock = true;
            input[side].push({ path: entry.path, bundle: loaded.bundle });
          }
        }
        // 同一路径新旧必须是同一 Document 的两个版本（与单文件复核一致）。
        const oldById = new Map(
          body.oldFiles.map((f) => [f.path, f.documentVersionId]),
        );
        for (const f of body.newFiles) {
          const oldId = oldById.get(f.path);
          if (!oldId) continue;
          const [o, n] = await Promise.all([
            tx.documentVersion.findUnique({ where: { id: oldId }, include: { document: true } }),
            tx.documentVersion.findUnique({ where: { id: f.documentVersionId }, include: { document: true } }),
          ]);
          if (!o || !n || o.documentId !== n.documentId)
            throw new ApiError("VALIDATION_ERROR", `同路径文件必须是同一资料：${f.path}`);
        }
        const frozen = MultiFileComparisonInput.parse({
          oldFiles: input.oldFiles,
          newFiles: input.newFiles,
          excludedPaths: body.excludedPaths,
        });
        const job = await tx.job.create({
          data: {
            projectId,
            kind: "SNAPSHOT_DIFF",
            fingerprint,
            request: { ...body, bodyHash: contentHash(body), mode: mode.mock ? "mock" : "real" },
          },
        });
        const change = await tx.snapshotChange.create({
          data: {
            projectId,
            jobId: job.id,
            baselineId: body.baselineId,
            oldFiles: body.oldFiles as never,
            newFiles: body.newFiles as never,
            excludedPaths: body.excludedPaths as never,
            input: frozen as never,
            inputHash: contentHash(frozen),
          },
        });
        await tx.auditEvent.create({
          data: {
            actorId: requireAuth(req).userId,
            action: "snapshotChange.create",
            entityType: "SnapshotChange",
            entityId: change.id,
            metadata: { baselineId: body.baselineId, oldCount: body.oldFiles.length, newCount: body.newFiles.length },
          },
        });
        return { job, change, existed: false };
      },
      { timeout: 30000 },
    );
    if (saved.job.status === "QUEUED")
      try {
        await queue.add("run", { jobId: saved.job.id }, { removeOnComplete: true, removeOnFail: 200 });
      } catch {
        /* Durable reconciliation enqueues it again. */
      }
    return reply.code(saved.existed ? 200 : 202).send({
      snapshotChangeId: saved.change.id,
      jobId: saved.job.id,
      existed: saved.existed,
    });
  });

  app.get("/api/snapshot-changes/:id", async (req) => {
    const r = await owned(req);
    if (r.output) MultiFileChangeReport.parse(r.output); // 读取时二次校验
    const tasks = snapshotTasks(r.output);
    const resolutions = r.resolutions as Record<string, unknown>;
    return { ...r, tasks, pendingCount: tasks.filter((t) => !resolutions[t.key]).length };
  });

  app.post("/api/snapshot-changes/:id/resolve", async (req) => {
    const initial = await owned(req, true);
    const body = z
      .object({
        fileKey: z.string().min(3).max(2100),
        decision: z.enum(["MODIFIED_REVIEWED", "ADDED_APPROVED", "REMOVED_WITH_REASON", "UNCERTAIN_MANUAL", "RENAMED_CONFIRMED", "EXCLUDED"]),
        /** MODIFIED_REVIEWED：挂接已完成单文件变更复核。 */
        changeReviewId: z.string().optional(),
        /** REMOVED/UNCERTAIN/EXCLUDED：必填理由（审计保留）。 */
        reason: z.string().min(5).max(2000).optional(),
      })
      .strict()
      .parse(req.body);
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "SnapshotChange" WHERE id=${initial.id} FOR UPDATE`;
      const r = await tx.snapshotChange.findUniqueOrThrow({
        where: { id: initial.id },
        include: { job: true },
      });
      if (r.job.status !== "SUCCEEDED" || !r.output)
        throw new ApiError("CONFLICT", "对比尚未完成");
      const task = snapshotTasks(r.output).find((t) => t.key === body.fileKey);
      if (!task) throw new ApiError("VALIDATION_ERROR", "文件不在本次对比待办中");
      const resolutions = r.resolutions as Record<string, { fingerprint: string }>;
      if (resolutions[body.fileKey]) {
        if (resolutions[body.fileKey]!.fingerprint !== contentHash(body))
          throw new ApiError("CONFLICT", "已确认决策不可覆盖，请新建对比");
        return resolutions[body.fileKey];
      }
      const files = {
        old: (r.oldFiles as Array<{ path: string; documentVersionId: string }>)
          .find((f) => f.path === task.oldPath),
        new: (r.newFiles as Array<{ path: string; documentVersionId: string }>)
          .find((f) => f.path === task.newPath),
      };
      if (body.decision === "MODIFIED_REVIEWED") {
        if (task.kind !== "modified" || !body.changeReviewId)
          throw new ApiError("VALIDATION_ERROR", "仅 modified 待办可挂接单文件复核");
        // 挂接的复核必须覆盖同一对 documentVersion 且已完成。
        const review = await tx.changeReview.findFirst({
          where: { id: body.changeReviewId, projectId: r.projectId },
          include: { job: true },
        });
        if (!review || review.job.status !== "SUCCEEDED")
          throw new ApiError("VALIDATION_ERROR", "挂接的变更复核不存在或未完成");
        if (
          review.oldDocumentVersionId !== files.old?.documentVersionId ||
          review.newDocumentVersionId !== files.new?.documentVersionId
        )
          throw new ApiError("VALIDATION_ERROR", "挂接的复核与该文件的版本对不一致");
      } else if (body.decision === "ADDED_APPROVED") {
        if (task.kind !== "added")
          throw new ApiError("VALIDATION_ERROR", "仅 added 待办可确认新增来源");
        if (!files.new) throw new ApiError("VALIDATION_ERROR", "新增文件信息缺失");
        // 新增来源的规则必须已批准（提取 DRAFT → 人工批准完成）。
        // sources 是 JSON 列：取项目全部 APPROVED 规则后按来源过滤。
        const candidates = await tx.ruleVersion.findMany({
          where: { reviewStatus: "APPROVED", rule: { projectId: r.projectId } },
          select: { sources: true },
        });
        const approved = candidates.filter((x) =>
          z
            .array(z.object({ documentVersionId: z.string() }))
            .parse(x.sources)
            .some((s) => s.documentVersionId === files.new!.documentVersionId),
        ).length;
        if (!approved)
          throw new ApiError("CONFLICT", "新增来源尚无已批准规则，请先完成提取与批准");
      } else if (body.decision === "RENAMED_CONFIRMED") {
        if (task.kind !== "renamed")
          throw new ApiError("VALIDATION_ERROR", "仅 renamed 待办可确认重命名");
        // oldDocumentVersionId 由冻结清单决定，此处不可篡改（只确认）。
      } else {
        // REMOVED_WITH_REASON / UNCERTAIN_MANUAL / EXCLUDED：必填理由。
        if (!body.reason)
          throw new ApiError("VALIDATION_ERROR", "该决策必须填写理由");
      }
      const result = {
        ...body,
        fingerprint: contentHash(body),
        actorId: requireAuth(req).userId,
        createdAt: new Date().toISOString(),
      };
      await tx.snapshotChange.update({
        where: { id: r.id },
        data: { resolutions: { ...resolutions, [body.fileKey]: result } },
      });
      await tx.auditEvent.create({
        data: {
          actorId: requireAuth(req).userId,
          action: "snapshotChange.resolve",
          entityType: "SnapshotChange",
          entityId: r.id,
          metadata: result,
        },
      });
      return result;
    });
  });

  app.post("/api/snapshot-changes/:id/baseline", async (req) => {
    const initial = await owned(req, true);
    const body = z
      .object({ name: z.string().trim().min(1).max(200) })
      .strict()
      .parse(req.body);
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "SnapshotChange" WHERE id=${initial.id} FOR UPDATE`;
      const r = await tx.snapshotChange.findUniqueOrThrow({
        where: { id: initial.id },
        include: { job: true },
      });
      const resolutions = r.resolutions as Record<string, any>;
      if (resolutions.BASELINE)
        return tx.baseline.findUniqueOrThrow({ where: { id: resolutions.BASELINE.id } });
      if (
        r.job.status !== "SUCCEEDED" ||
        !r.output ||
        snapshotTasks(r.output).some((t) => !resolutions[t.key])
      )
        throw new ApiError("CONFLICT", "请先完成全部文件待办");
      const old = await tx.baseline.findFirstOrThrow({
        where: { id: r.baselineId, projectId: r.projectId },
      });
      const report = MultiFileChangeReport.parse(r.output);
      const files = {
        old: new Map(
          (r.oldFiles as Array<{ path: string; documentVersionId: string }>).map(
            (f) => [f.path, f.documentVersionId] as const,
          ),
        ),
        new: new Map(
          (r.newFiles as Array<{ path: string; documentVersionId: string }>).map(
            (f) => [f.path, f.documentVersionId] as const,
          ),
        ),
      };
      let ruleVersionIds = [...old.ruleVersionIds];
      let caseVersionIds = [...old.caseVersionIds];
      const dropped: string[] = [];
      for (const outcome of report.outcomes) {
        const key = `${outcome.kind}:${outcome.oldPath ?? outcome.newPath}`;
        const resolution = resolutions[key];
        if (!resolution) continue;
        if (outcome.kind === "modified" && resolution.decision === "MODIFIED_REVIEWED") {
          // 采用挂接单文件复核创建的新基线资产映射。
          const review = await tx.changeReview.findUniqueOrThrow({
            where: { id: resolution.changeReviewId },
          });
          const reviewResolutions = review.resolutions as Record<string, any>;
          if (reviewResolutions.BASELINE) {
            const reviewed = await tx.baseline.findUniqueOrThrow({
              where: { id: reviewResolutions.BASELINE.id },
            });
            const replace = (type: string, rid: string) =>
              reviewResolutions[`${type}:${rid}`]?.replacementVersionId ?? rid;
            ruleVersionIds = ruleVersionIds.map((rid) => replace("RULE", rid));
            caseVersionIds = caseVersionIds.map((cid) => replace("CASE", cid));
          }
        } else if (outcome.kind === "added" && resolution.decision === "ADDED_APPROVED") {
          // 纳入新增来源的已批准规则与引用这些规则的已批准用例。
          const newVersionId = files.new.get(outcome.newPath!)!;
          const candidateRules = await tx.ruleVersion.findMany({
            where: { reviewStatus: "APPROVED", rule: { projectId: r.projectId } },
            select: { id: true, sources: true },
          });
          const addedRules = candidateRules.filter((x) =>
            z
              .array(z.object({ documentVersionId: z.string() }))
              .parse(x.sources)
              .some((s) => s.documentVersionId === newVersionId),
          );
          const addedRuleIds = addedRules.map((x) => x.id).filter((x) => !ruleVersionIds.includes(x));
          if (addedRuleIds.length) {
            const included = new Set([...ruleVersionIds, ...addedRuleIds]);
            const addedCases = await tx.testCaseVersion.findMany({
              where: {
                projectId: r.projectId,
                approvalStatus: "APPROVED",
                id: { notIn: caseVersionIds },
                ruleVersionIds: { hasSome: addedRuleIds },
              },
              select: { id: true, ruleVersionIds: true },
            });
            ruleVersionIds.push(...addedRuleIds);
            for (const c of addedCases) {
              if (c.ruleVersionIds.every((rid) => included.has(rid) || addedRuleIds.includes(rid)))
                caseVersionIds.push(c.id);
            }
          }
        } else if (
          outcome.kind === "removed" &&
          resolution.decision !== "EXCLUDED"
        ) {
          // 删除文件的独占规则随之下线（有理由与审计）；引用它们的用例一并下线。
          const oldVersionId = files.old.get(outcome.oldPath!)!;
          const rules = await tx.ruleVersion.findMany({
            where: { id: { in: ruleVersionIds }, rule: { projectId: r.projectId } },
          });
          const exclusive = rules
            .filter((x) => {
              const sources = z
                .array(z.object({ documentVersionId: z.string() }))
                .parse(x.sources);
              return sources.length > 0 && sources.every((s) => s.documentVersionId === oldVersionId);
            })
            .map((x) => x.id);
          if (exclusive.length) {
            ruleVersionIds = ruleVersionIds.filter((rid) => !exclusive.includes(rid));
            const dependentCases = await tx.testCaseVersion.findMany({
              where: { id: { in: caseVersionIds }, ruleVersionIds: { hasSome: exclusive } },
              select: { id: true },
            });
            caseVersionIds = caseVersionIds.filter(
              (cid) => !dependentCases.some((c) => c.id === cid),
            );
            dropped.push(...exclusive);
          }
        }
      }
      // 终检：全部资产已批准且用例引用闭合。
      const rules = await tx.ruleVersion.findMany({
        where: { id: { in: ruleVersionIds }, rule: { projectId: r.projectId }, reviewStatus: "APPROVED" },
      });
      const cases = await tx.testCaseVersion.findMany({
        where: { id: { in: caseVersionIds }, projectId: r.projectId, approvalStatus: "APPROVED" },
      });
      if (
        rules.length !== new Set(ruleVersionIds).size ||
        cases.length !== new Set(caseVersionIds).size ||
        cases.some((c) => c.ruleVersionIds.some((rid) => !ruleVersionIds.includes(rid)))
      )
        throw new ApiError("CONFLICT", "新版基线规则与用例引用不一致");
      const ruleSet = [...new Set(ruleVersionIds)];
      const baseline = await tx.baseline.create({
        data: {
          projectId: r.projectId,
          name: body.name,
          ruleVersionIds: ruleSet,
          caseVersionIds: [...new Set(caseVersionIds)],
          scope: old.scope as never,
          exclusions: old.exclusions as never,
        },
      });
      await tx.snapshotChange.update({
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
          action: "snapshotChange.baseline",
          entityType: "Baseline",
          entityId: baseline.id,
          beforeRef: old.id,
          metadata: { snapshotChangeId: r.id, droppedRuleVersionIds: dropped },
        },
      });
      return baseline;
    });
  });
}
