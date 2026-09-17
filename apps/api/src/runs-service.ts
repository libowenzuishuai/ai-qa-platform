import type { PrismaClient, Prisma } from "@prisma/client";
import { TestCaseVersion, verifyStoredPlan } from "@ai-qa/contracts";
import { ApiError } from "./errors.js";

/**
 * 运行创建 repository（阶段 1 提示词 B/A.3）：
 * - 校验所有 ID/数组/JSON 引用真实存在且属于同一项目；
 * - 用例必须 APPROVED 且有绑定计划；执行前 verifyStoredPlan（服务端哈希核验）；
 * - 幂等键项目内唯一：同键同请求返回原 run，同键不同请求 409；
 * - 环境快照（含 secretRef 引用，不含明文）随 run 固化。
 */

export interface CreateRunInput {
  projectId: string;
  baselineId: string;
  environmentId: string;
  caseVersionIds: string[];
  buildId?: string | null;
  mode: "real" | "mock";
  idempotencyKey: string;
  actorId: string;
}

export interface CreateRunResult {
  runId: string;
  existed: boolean;
}

export async function createRun(
  prisma: PrismaClient,
  input: CreateRunInput,
): Promise<CreateRunResult> {
  const { projectId, baselineId, environmentId, caseVersionIds } = input;

  if (!Array.isArray(caseVersionIds) || caseVersionIds.length === 0) {
    throw new ApiError("VALIDATION_ERROR", "caseVersionIds 不能为空：空运行无验收意义", {
      field: "caseVersionIds",
    });
  }
  if (new Set(caseVersionIds).size !== caseVersionIds.length) {
    throw new ApiError("VALIDATION_ERROR", "caseVersionIds 存在重复", { field: "caseVersionIds" });
  }
  if (input.mode !== "real") {
    throw new ApiError("UNSUPPORTED", "阶段 1 仅支持 mode=real；mock 不得用于真实验收", {
      field: "mode",
    });
  }

  const baseline = await prisma.baseline.findFirst({ where: { id: baselineId, projectId } });
  if (!baseline) throw new ApiError("NOT_FOUND", "基线不存在或不属于该项目");

  const environment = await prisma.environment.findFirst({ where: { id: environmentId, projectId } });
  if (!environment) throw new ApiError("NOT_FOUND", "环境不存在或不属于该项目");
  if (environment.isProduction) {
    throw new ApiError("UNSUPPORTED", "禁止对生产环境执行业务测试", { field: "environmentId" });
  }

  // 用例引用闭合校验：同项目、APPROVED、有计划、计划与批准语义一致。
  const caseVersions = await prisma.testCaseVersion.findMany({
    where: { id: { in: caseVersionIds }, projectId },
  });
  const found = new Set(caseVersions.map((c) => c.id));
  const missing = caseVersionIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new ApiError("VALIDATION_ERROR", `用例版本不存在或不属于该项目：${missing.join(",")}`, {
      field: "caseVersionIds",
    });
  }
  for (const caseVersion of caseVersions) {
    if (caseVersion.approvalStatus !== "APPROVED" || !caseVersion.approvalHash) {
      throw new ApiError("VALIDATION_ERROR", `用例 ${caseVersion.id} 未批准（不能作为验收标准）`, {
        field: "caseVersionIds",
      });
    }
    const planVersion = await prisma.testPlanVersion.findFirst({
      where: { caseVersionId: caseVersion.id },
      orderBy: { version: "desc" },
    });
    if (!planVersion) {
      throw new ApiError("VALIDATION_ERROR", `用例 ${caseVersion.id} 没有已绑定的执行计划`, {
        field: "caseVersionIds",
      });
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
    // 基线一致性：选定的用例应属于基线范围（防绕过基线挑选用例）。
    if (!baseline.caseVersionIds.includes(caseVersion.id)) {
      throw new ApiError("VALIDATION_ERROR", `用例 ${caseVersion.id} 不在基线 ${baseline.id} 范围内`, {
        field: "caseVersionIds",
      });
    }
  }

  // 环境快照：worker 只使用快照（不读“最新版本”）；仅存 secretRef 引用。
  const environmentSnapshot = {
    baseUrl: environment.baseUrl,
    allowedOrigins: environment.allowedOrigins,
    dependencyOrigins: environment.dependencyOrigins,
    secretRefs: environment.secretRefs,
    buildId: environment.buildMetadata,
    environmentRevision: environment.revision,
  };

  const budget = {
    maxToolActionsPerCase: 50,
    maxModelRequestsPerCase: 0,
    maxWallClockMsPerCase: 300_000,
    maxModelRequestsPerRun: 0,
    maxTokensPerRun: 0,
    maxWallClockMsPerRun: 3_600_000,
  };

  // —— 幂等 ——
  const identity = {
    baselineId,
    environmentId,
    caseVersionIds: [...caseVersionIds].sort(),
    buildId: input.buildId ?? null,
    mode: input.mode,
  };
  const existing = await prisma.run.findUnique({
    where: { projectId_idempotencyKey: { projectId, idempotencyKey: input.idempotencyKey } },
  });
  if (existing) {
    const existingIdentity = {
      baselineId: existing.baselineId,
      environmentId: existing.environmentId,
      caseVersionIds: [...existing.selectedCaseVersionIds].sort(),
      buildId: existing.buildId,
      mode: existing.mode,
    };
    if (JSON.stringify(existingIdentity) === JSON.stringify(identity)) {
      return { runId: existing.id, existed: true };
    }
    throw new ApiError("IDEMPOTENCY_CONFLICT", "相同幂等键对应不同的请求体", {
      idempotencyKey: input.idempotencyKey,
    });
  }

  const run = await prisma.run.create({
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
    },
  });
  await prisma.runEvent.create({
    data: {
      runId: run.id,
      seq: 1,
      type: "run.created",
      payload: { runId: run.id, caseVersionIds, buildId: input.buildId ?? null },
    },
  });
  return { runId: run.id, existed: false };
}
