import type { Prisma } from "@prisma/client";
import { TestCaseVersion, verifyStoredPlan } from "@ai-qa/contracts";
import type { ArtifactStore } from "@ai-qa/artifact-store";
import { emitRunEvent } from "@ai-qa/run-events";
import { ApiError } from "./errors.js";

/**
 * 运行创建 repository（阶段 1.1：R3/R4/R8/R9）。
 *
 * - R3 版本固定：创建时在事务中固定每个用例的 planVersionId 与
 *   acceptanceHash（casePlanPins）；worker 只按固定版本执行。
 * - R4 可信引用：逐项核验规则（存在/同项目/APPROVED）、规则来源
 *   （SourceSpan 存在且文档属于本项目）、基线成员、计划观察证据
 *   （Artifact 存在/同项目/类型 OBSERVATION/文件真实存在）。
 * - R8 并发幂等：唯一约束冲突后重读并按规范指纹比对（同体返回原 run，
 *   异体 409），绝不 500。
 * - R9 预算：解析并保存调用者预算（范围校验，超限拒绝）。
 */

export interface CreateRunInput {
  /** Internal retest path only: preserve the original plan versions. */
  pinnedPlans?: Array<{ caseVersionId: string; planVersionId: string; acceptanceHash: string }>;
  projectId: string;
  baselineId: string;
  environmentId: string;
  caseVersionIds: string[];
  buildId?: string | null;
  mode: "real" | "mock";
  idempotencyKey: string;
  budget?: {
    maxToolActionsPerCase?: number;
    maxWallClockMsPerCase?: number;
    maxWallClockMsPerRun?: number;
  };
}

export interface CreateRunResult {
  runId: string;
  existed: boolean;
}

const BUDGET_LIMITS = {
  maxToolActionsPerCase: { min: 1, max: 1000, def: 50 },
  maxWallClockMsPerCase: { min: 10_000, max: 600_000, def: 300_000 },
  maxWallClockMsPerRun: { min: 60_000, max: 7_200_000, def: 3_600_000 },
} as const;

type BudgetShape = {
  maxToolActionsPerCase: number;
  maxWallClockMsPerCase: number;
  maxWallClockMsPerRun: number;
  maxModelRequestsPerCase: number;
  maxModelRequestsPerRun: number;
  maxTokensPerRun: number;
};

function validateBudget(input: CreateRunInput["budget"]): BudgetShape {
  const merged: BudgetShape = {
    maxToolActionsPerCase: BUDGET_LIMITS.maxToolActionsPerCase.def,
    maxWallClockMsPerCase: BUDGET_LIMITS.maxWallClockMsPerCase.def,
    maxWallClockMsPerRun: BUDGET_LIMITS.maxWallClockMsPerRun.def,
    maxModelRequestsPerCase: 0,
    maxModelRequestsPerRun: 0,
    maxTokensPerRun: 0,
  };
  if (!input) return merged;
  for (const key of ["maxToolActionsPerCase", "maxWallClockMsPerCase", "maxWallClockMsPerRun"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    const limits = BUDGET_LIMITS[key];
    if (!Number.isInteger(value) || value < limits.min || value > limits.max) {
      throw new ApiError("VALIDATION_ERROR", `budget.${key} 必须是 ${limits.min}–${limits.max} 之间的整数`, {
        field: `budget.${key}`,
      });
    }
    merged[key] = value;
  }
  return merged;
}

export async function createRun(
  prisma: import("@prisma/client").PrismaClient,
  store: ArtifactStore,
  input: CreateRunInput,
): Promise<CreateRunResult> {
  const { projectId, baselineId, environmentId, caseVersionIds } = input;

  if (!Array.isArray(caseVersionIds) || caseVersionIds.length === 0) {
    throw new ApiError("VALIDATION_ERROR", "caseVersionIds 不能为空：空运行无验收意义", { field: "caseVersionIds" });
  }
  if (new Set(caseVersionIds).size !== caseVersionIds.length) {
    throw new ApiError("VALIDATION_ERROR", "caseVersionIds 存在重复", { field: "caseVersionIds" });
  }
  if (input.mode !== "real") {
    throw new ApiError("UNSUPPORTED", "阶段 1 仅支持 mode=real；mock 不得用于真实验收", { field: "mode" });
  }
  const budget = validateBudget(input.budget);

  const identity = {
    baselineId,
    environmentId,
    caseVersionIds: [...caseVersionIds].sort(),
    buildId: input.buildId ?? null,
    mode: input.mode,
    budget,
  };

  // —— R8：先查重（快速路径）——
  const existing = await prisma.run.findUnique({
    where: { projectId_idempotencyKey: { projectId, idempotencyKey: input.idempotencyKey } },
  });
  if (existing) {
    return resolveIdempotent(existing, identity, input.idempotencyKey, input.pinnedPlans);
  }



  const baseline = await prisma.baseline.findFirst({ where: { id: baselineId, projectId } });
  if (!baseline) throw new ApiError("NOT_FOUND", "基线不存在或不属于该项目");

  const environment = await prisma.environment.findFirst({ where: { id: environmentId, projectId } });
  if (!environment) throw new ApiError("NOT_FOUND", "环境不存在或不属于该项目");
  if (environment.isProduction) {
    throw new ApiError("UNSUPPORTED", "禁止对生产环境执行业务测试", { field: "environmentId" });
  }

  // —— R4：真实引用核验（数据库事实，不只是 schema/哈希形状） ——
  const caseVersions = await prisma.testCaseVersion.findMany({
    where: { id: { in: caseVersionIds }, projectId },
  });
  const found = new Set(caseVersions.map((c) => c.id));
  const missing = caseVersionIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new ApiError("VALIDATION_ERROR", `用例版本不存在或不属于该项目：${missing.join(",")}`, { field: "caseVersionIds" });
  }

  const pins: Array<{ caseVersionId: string; planVersionId: string; acceptanceHash: string }> = [];
  for (const caseVersion of caseVersions) {
    if (caseVersion.approvalStatus !== "APPROVED" || !caseVersion.approvalHash) {
      throw new ApiError("VALIDATION_ERROR", `用例 ${caseVersion.id} 未批准（不能作为验收标准）`, { field: "caseVersionIds" });
    }
    if (!baseline.caseVersionIds.includes(caseVersion.id)) {
      throw new ApiError("VALIDATION_ERROR", `用例 ${caseVersion.id} 不在基线 ${baseline.id} 范围内`, { field: "caseVersionIds" });
    }

    // R4：规则存在、同项目、APPROVED。
    const ruleVersions = await prisma.ruleVersion.findMany({
      where: { id: { in: caseVersion.ruleVersionIds } },
      include: { rule: { select: { projectId: true } } },
    });
    for (const ruleId of caseVersion.ruleVersionIds) {
      const rule = ruleVersions.find((r) => r.id === ruleId);
      if (!rule || rule.rule.projectId !== projectId) {
        throw new ApiError("VALIDATION_ERROR", `用例 ${caseVersion.id} 引用的规则 ${ruleId} 不存在或跨项目`, { field: "caseVersionIds" });
      }
      if (rule.reviewStatus !== "APPROVED") {
        throw new ApiError("VALIDATION_ERROR", `用例 ${caseVersion.id} 引用的规则 ${ruleId} 状态为 ${rule.reviewStatus}（须 APPROVED）`, { field: "caseVersionIds" });
      }
      // R4：规则来源（SourceSpan 存在且文档属于本项目）。
      const sources = (rule.sources ?? []) as Array<{ documentVersionId: string; sourceSpanIds: string[] }>;
      for (const source of sources) {
        const spanCount = await prisma.sourceSpan.count({
          where: { id: { in: source.sourceSpanIds }, documentVersionId: source.documentVersionId },
        });
        if (spanCount !== source.sourceSpanIds.length) {
          throw new ApiError("VALIDATION_ERROR", `规则 ${ruleId} 的来源 Span 不存在`, { field: "ruleVersionIds" });
        }
        const docVersion = await prisma.documentVersion.findUnique({
          where: { id: source.documentVersionId },
          include: { document: { select: { projectId: true } } },
        });
        if (!docVersion || docVersion.document.projectId !== projectId) {
          throw new ApiError("VALIDATION_ERROR", `规则 ${ruleId} 的来源文档不属于本项目`, { field: "ruleVersionIds" });
        }
      }
    }

    // Only a plan observed against this environment revision can run here.
    // R3：固定当前最新计划版本（worker 只执行它）。
    const fixed = input.pinnedPlans?.find(p => p.caseVersionId === caseVersion.id);
    if (input.pinnedPlans && !fixed) throw new ApiError("VALIDATION_ERROR", "原运行缺少固定计划");
    const planVersion = await prisma.testPlanVersion.findFirst({
      where: { caseVersionId: caseVersion.id, ...(fixed ? { id: fixed.planVersionId, acceptanceHash: fixed.acceptanceHash } : {}) },
      orderBy: { version: "desc" },
    });
    if (!planVersion) {
      throw new ApiError("VALIDATION_ERROR", `用例 ${caseVersion.id} 没有已绑定的执行计划`, { field: "caseVersionIds" });
    }

    if (planVersion.environmentId && (planVersion.environmentId !== environment.id || planVersion.environmentRevision !== environment.revision)) {
      throw new ApiError("VALIDATION_ERROR", "计划绑定的环境或配置版本已变化，请重新观察和批准");
    }
    const parsedCase = TestCaseVersion.safeParse({
      ...caseVersion,
      description: caseVersion.description ?? undefined,
      preconditions: caseVersion.preconditions,
      dataSpec: caseVersion.dataSpec,
      steps: caseVersion.steps,
      assertions: caseVersion.assertions,
      cleanup: caseVersion.cleanup,
      approvalHash: caseVersion.approvalHash ?? undefined,
      createdAt: caseVersion.createdAt.toISOString(),
    });
    if (!parsedCase.success) {
      throw new ApiError("VALIDATION_ERROR", `用例 ${caseVersion.id} 数据不符合契约`, {
        details: parsedCase.error.issues.slice(0, 3),
      });
    }
    const verification = verifyStoredPlan(planVersion.plan, parsedCase.data);
    if (!verification.ok) {
      throw new ApiError("VALIDATION_ERROR", `用例 ${caseVersion.id} 计划校验失败：${verification.problems.slice(0, 2).join("; ")}`);
    }

    if (planVersion.acceptanceHash !== (planVersion.plan as { acceptanceHash: string }).acceptanceHash) {
      throw new ApiError("VALIDATION_ERROR", "计划登记哈希与实际内容不一致");
    }
    // R4：计划观察证据（存在/同项目/OBSERVATION/文件真实存在）。
    const bindings = ((planVersion.plan as { bindings?: Array<{ evidenceId: string }> }).bindings) ?? [];
    for (const binding of bindings) {
      const artifact = await prisma.artifact.findUnique({ where: { id: binding.evidenceId } });
      if (!artifact || artifact.projectId !== projectId) {
        throw new ApiError("VALIDATION_ERROR", `计划观察证据 ${binding.evidenceId} 不存在或跨项目`, { field: "caseVersionIds" });
      }
      if (artifact.type !== "OBSERVATION") {
        throw new ApiError("VALIDATION_ERROR", `计划观察证据 ${binding.evidenceId} 类型为 ${artifact.type}（须 OBSERVATION）`, { field: "caseVersionIds" });
      }
      if (!store.exists(artifact.storageKey)) {
        throw new ApiError("VALIDATION_ERROR", `计划观察证据文件缺失：${artifact.storageKey}`, { field: "caseVersionIds" });
      }
      if (!store.verify(artifact.storageKey, artifact.checksum) ||
          (artifact.expiresAt && artifact.expiresAt <= new Date())) {
        throw new ApiError("VALIDATION_ERROR", `计划观察证据损坏或过期：${binding.evidenceId}`);
      }
    }

    pins.push({
      caseVersionId: caseVersion.id,
      planVersionId: planVersion.id,
      acceptanceHash: planVersion.acceptanceHash,
    });
  }

  const templateIds = new Set<string>();
  for (const pin of pins) {
    const plan = await prisma.testPlanVersion.findUniqueOrThrow({where:{id:pin.planVersionId}});
    for (const action of (plan.plan as { actions: Array<{type:string;templateId?:string}> }).actions) if(action.type === "apiCheck" && action.templateId) templateIds.add(action.templateId);
  }
  const templates = await prisma.apiTemplate.findMany({where:{id:{in:[...templateIds]},projectId,environmentId}});
  if(templates.length !== templateIds.size) throw new ApiError("VALIDATION_ERROR","API 模板不存在或不属于目标环境");
  const environmentSnapshot = {
    apiTemplates: Object.fromEntries(templates.map(t=>[t.id,t.request])),
    baseUrl: environment.baseUrl,
    allowedOrigins: environment.allowedOrigins,
    dependencyOrigins: environment.dependencyOrigins,
    secretRefs: environment.secretRefs,
    runtime: environment.runtime,
    buildId: environment.buildMetadata,
    environmentRevision: environment.revision,
  };

  // —— 插入（唯一约束兜底并发）——
  try {
    return await prisma.$transaction(async (tx) => {
      const run = await tx.run.create({
        data: {
          projectId,
          baselineId,
          environmentId,
          buildId: input.buildId ?? null,
          mode: input.mode,
          selectedCaseVersionIds: caseVersionIds,
          budget,
          idempotencyKey: input.idempotencyKey,
          environmentSnapshot: environmentSnapshot as unknown as Prisma.InputJsonValue,
          modelConfigSnapshot: { note: "stage1-fixed-cases-no-model" },
          casePlanPins: pins as unknown as Prisma.InputJsonValue,
        },
      });
      await emitRunEvent(tx, run.id, "run.created", {
        runId: run.id, caseVersionIds, buildId: input.buildId ?? null,
        planPins: pins.map((p) => ({ caseVersionId: p.caseVersionId, planVersionId: p.planVersionId })),
      });
      return { runId: run.id, existed: false };
    });
  } catch (err) {
    // R8：并发插入唯一冲突 → 重读并按指纹比对，绝不 500。
    if (String(err).includes("Unique constraint") || (err as { code?: string }).code === "P2002") {
      const raced = await prisma.run.findUnique({
        where: { projectId_idempotencyKey: { projectId, idempotencyKey: input.idempotencyKey } },
      });
      if (raced) return resolveIdempotent(raced, identity, input.idempotencyKey, input.pinnedPlans);
    }
    throw err;
  }
}

/** 幂等指纹中的预算投影：只比较调用者可设置的三键（按默认值归一）。 */
function budgetFingerprint(budget: unknown): Record<string, number> {
  const b = (budget ?? {}) as Record<string, unknown>;
  return {
    maxToolActionsPerCase: Number(b.maxToolActionsPerCase ?? BUDGET_LIMITS.maxToolActionsPerCase.def),
    maxWallClockMsPerCase: Number(b.maxWallClockMsPerCase ?? BUDGET_LIMITS.maxWallClockMsPerCase.def),
    maxWallClockMsPerRun: Number(b.maxWallClockMsPerRun ?? BUDGET_LIMITS.maxWallClockMsPerRun.def),
  };
}

function resolveIdempotent(
  existing: { id: string; baselineId: string; environmentId: string; selectedCaseVersionIds: string[]; buildId: string | null; mode: string; budget: unknown; casePlanPins: unknown },
  identity: Record<string, unknown>,
  idempotencyKey: string,
  pinnedPlans?: CreateRunInput["pinnedPlans"],
): CreateRunResult {
  const normalizePins = (value: unknown) => JSON.stringify((value as NonNullable<CreateRunInput["pinnedPlans"]>).map(p => ({ caseVersionId:p.caseVersionId, planVersionId:p.planVersionId, acceptanceHash:p.acceptanceHash })).sort((a,b)=>a.caseVersionId.localeCompare(b.caseVersionId)));
  if (pinnedPlans && normalizePins(existing.casePlanPins) !== normalizePins(pinnedPlans)) throw new ApiError("IDEMPOTENCY_CONFLICT", "相同幂等键对应不同的复测计划");
  const existingIdentity = {
    baselineId: existing.baselineId,
    environmentId: existing.environmentId,
    caseVersionIds: [...existing.selectedCaseVersionIds].sort(),
    buildId: existing.buildId,
    mode: existing.mode,
    budget: budgetFingerprint(existing.budget),
  };
  const same =
    JSON.stringify(existingIdentity) === JSON.stringify({ ...identity, budget: budgetFingerprint(identity.budget) });
  if (same) return { runId: existing.id, existed: true };
  throw new ApiError("IDEMPOTENCY_CONFLICT", "相同幂等键对应不同的请求体", { idempotencyKey });
}
