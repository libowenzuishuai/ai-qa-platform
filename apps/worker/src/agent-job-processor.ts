import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  ParsedDocumentBundle,
  RuleExtractionInput,
  RuleExtractionOutput,
  validateRuleExtraction,
  CaseGenerationInput,
  CaseGenerationOutput,
  validateCaseGeneration,
  RuleVersion as RuleVersionSchema,
  TestCaseVersion as TestCaseVersionSchema,
  type TextModelAdapter,
  type ModelResponse,
} from "@ai-qa/contracts";
import { ArtifactStore } from "@ai-qa/artifact-store";
import {
  MockTextAdapter,
  MoonshotTextAdapter,
  requireChannelConfig,
} from "@ai-qa/model-adapters";
import type { WorkerConfig } from "./config.js";
import {
  REFERENCE_PROMPT_VERSION,
  referenceRuleExtractionPipeline,
  referenceCaseGenerationPipeline,
  PHASE1_EXECUTOR_ACTIONS,
} from "./pipelines.js";

/**
 * 阶段 2 作业处理器（RULE_EXTRACTION / CASE_GENERATION）。
 *
 * 流程：CAS 认领 → 按模式构造适配器（real 缺配置 = FAILED，不降级）→
 * 加载输入（artifact-store bundle / APPROVED 规则）→ 管线（参考实现，
 * agents 包就绪后注入替换）→ 契约校验（联合校验拦编造）→ 持久化
 * （DRAFT 草稿 + 澄清项 / 用例草稿）→ ModelInvocation 落库 → Job 终态。
 *
 * 事件/进度：阶段 2 作业无 SSE；终态经 GET /api/jobs/:id 轮询。
 */

type JobError = { code: string; message: string; requestId: string; details?: unknown };

async function failJob(prisma: PrismaClient, job: JobRow, err: unknown): Promise<void> {
  const error: JobError =
    err instanceof Error && "code" in err && typeof (err as { code?: unknown }).code === "string"
      ? {
          code: (err as { code: string }).code,
          message: err.message.slice(0, 500),
          requestId: job.id,
          ...((err as { details?: unknown }).details !== undefined
            ? { details: (err as { details?: unknown }).details }
            : {}),
        }
      : { code: "INTERNAL", message: String(err).slice(0, 500), requestId: job.id };
  await prisma.job.updateMany({
    where: ownedJob(job),
    data: {
      status: "FAILED",
      error: error as never,
      finishedAt: new Date(),
    },
  });
}

function adapterFor(mode: string): TextModelAdapter {
  if (mode === "mock") return new MockTextAdapter();
  // real：worker 二验（API 已快失败；防御部署差异）。
  const config = requireChannelConfig("text");
  return new MoonshotTextAdapter({ config });
}

async function recordInvocation(
  prisma: PrismaClient,
  projectId: string,
  response: ModelResponse,
  purpose: string,
): Promise<void> {
  await prisma.modelInvocation.create({
    data: {
      projectId,
      provider: response.provider,
      model: response.model,
      promptVersion: REFERENCE_PROMPT_VERSION,
      requestId: response.requestId,
      usage: {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        purpose,
        outcome: response.outcome,
      } as never,
      latencyMs: response.latencyMs,
      outcome: response.outcome,
    },
  });
}

/** 记录模型的适配器调用（管线内部调用适配器，这里包装以捕获响应）。 */
function withInvocationRecording(
  projectId: string,
  prisma: PrismaClient,
  adapter: TextModelAdapter,
  purpose: string,
): TextModelAdapter {
  return {
    name: adapter.name,
    capabilities: () => adapter.capabilities(),
    completeText: async (req) => {
      const response = await adapter.completeText(req);
      await recordInvocation(prisma, projectId, response, purpose).catch(() => undefined);
      return response;
    },
  };
}

/** bundle 存储 key（B 的 doc-ingestion 与本处理器约定一致）。 */
function bundleStorageKey(documentVersionId: string): string {
  return `bundles/${documentVersionId}/bundle.json`;
}

export async function processAgentJob(
  prisma: PrismaClient,
  config: WorkerConfig,
  jobId: string,
): Promise<void> {
  const startedAt = new Date();
  // —— CAS 认领：仅 QUEUED → RUNNING ——
  const claimed = await prisma.job.updateMany({
    where: { id: jobId, status: "QUEUED" },
    data: { status: "RUNNING", startedAt },
  });
  if (claimed.count === 0) return; // 重复投递 / 已终态。
  const job = { ...await prisma.job.findUniqueOrThrow({ where: { id: jobId } }), startedAt };

  // 心跳只续租仍由本次执行拥有的作业；失联对账后的旧执行不能复活。
  const heartbeat = setInterval(() => {
    void prisma.job.updateMany({
      where: ownedJob(job), data: { updatedAt: new Date() },
    }).catch(() => undefined);
  }, 10_000);
  heartbeat.unref();
  try {
    const store = new ArtifactStore(config.artifactDir);
    if (job.kind === "RULE_EXTRACTION") {
      await runRuleExtraction(prisma, store, job);
    } else if (job.kind === "CASE_GENERATION") {
      await runCaseGeneration(prisma, job);
    } else {
      throw Object.assign(new Error(`未知作业类型：${job.kind}`), { code: "INTERNAL" });
    }
  } catch (err) {
    await failJob(prisma, job, err);
  } finally {
    clearInterval(heartbeat);
  }
}

type JobRow = { id: string; projectId: string; request: unknown; startedAt: Date | null };
function ownedJob(job: JobRow) {
  return { id: job.id, status: "RUNNING", startedAt: job.startedAt };
}

/** 锁定当前租约行，再写全部资产和终态；异常时整批回滚。 */
async function commitJob(
  prisma: PrismaClient, job: JobRow, persist: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const guard = await tx.job.updateMany({ where: ownedJob(job), data: { updatedAt: new Date() } });
    if (guard.count !== 1) throw new Error("作业租约已失效，拒绝提交旧执行结果");
    await persist(tx);
  }, { timeout: 30_000 });
}

async function runRuleExtraction(
  prisma: PrismaClient,
  store: ArtifactStore,
  job: JobRow,
): Promise<void> {
  const request = job.request as {
    documentVersionIds: string[];
    glossaryUpdates?: Array<{ term: string; definition: string }>;
    mode: "real" | "mock";
  };
  const adapter = adapterFor(request.mode);

  // 加载 bundle（artifact-store）+ 二验 PARSED。
  const bundles = [];
  for (const documentVersionId of request.documentVersionIds) {
    let raw: string;
    try {
      raw = store.read(bundleStorageKey(documentVersionId)).toString("utf8");
    } catch {
      throw Object.assign(new Error(`bundle 不存在：${documentVersionId}`), {
        code: "VALIDATION_ERROR",
        details: { documentVersionId },
      });
    }
    const parsed = ParsedDocumentBundle.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw Object.assign(new Error(`bundle 不符合契约：${documentVersionId}`), {
        code: "MODEL_OUTPUT_INVALID",
        details: { issues: parsed.error.issues.slice(0, 3) },
      });
    }
    if (parsed.data.parseStatus === "NEEDS_OCR") {
      throw Object.assign(new Error("该文档版本需要 OCR"), {
        code: "NEEDS_OCR",
        details: { documentVersionId },
      });
    }
    if (parsed.data.parseStatus !== "PARSED") {
      throw Object.assign(new Error(`bundle 状态 ${parsed.data.parseStatus}（须 PARSED）`), {
        code: "VALIDATION_ERROR",
        details: { documentVersionId },
      });
    }
    bundles.push(parsed.data);
  }

  const input = RuleExtractionInput.parse({
    projectGlossary: request.glossaryUpdates ?? [],
    documentVersions: bundles,
    images: [],
    promptVersion: REFERENCE_PROMPT_VERSION,
  });
  const output = await referenceRuleExtractionPipeline(
    input,
    withInvocationRecording(job.projectId, prisma, adapter, "RULE_EXTRACTION"),
  );

  // 联合校验（拦编造引用/张冠李戴/单方消解）。
  const validation = validateRuleExtraction(input, output);
  if (!validation.ok) {
    throw Object.assign(new Error("规则提取输出未通过联合校验"), {
      code: "MODEL_OUTPUT_INVALID",
      details: { problems: validation.problems.slice(0, 10) },
    });
  }

  await commitJob(prisma, job, async (prisma) => {
    // 持久化：Rule + RuleVersion(DRAFT) + Clarification；key → 真 id 映射。
    const keyToRuleVersionId = new Map<string, string>(output.ruleDrafts.map((draft) => [draft.key, randomUUID()]));
    for (const draft of output.ruleDrafts) {
      const rule = await prisma.rule.create({ data: { projectId: job.projectId } });
      const ruleVersion = await prisma.ruleVersion.create({
        data: {
          id: keyToRuleVersionId.get(draft.key)!,
          ruleId: rule.id,
          version: 1,
          statement: draft.statement,
          classification: draft.classification,
          role: draft.role ?? null,
          precondition: draft.precondition ?? null,
          action: draft.action,
          condition: draft.condition ?? null,
          expectation: draft.expectation,
          forbiddenBehaviors: draft.forbiddenBehaviors as never,
          priority: draft.priority,
          businessFields: draft.businessFields as never,
          sources: draft.sources as never,
          conflictsWith: draft.conflictsWith.map((key) => keyToRuleVersionId.get(key)!) as never,
          reviewStatus: "DRAFT",
          origin: "model",
          promptVersion: REFERENCE_PROMPT_VERSION,
        },
      });
      await prisma.rule.update({ where: { id: rule.id }, data: { currentVersionId: ruleVersion.id } });
      keyToRuleVersionId.set(draft.key, ruleVersion.id);
    }
    const clarificationIds: string[] = [];
    for (const clarification of output.clarifications) {
      const ruleVersionIds = clarification.ruleDraftKeys
        .map((key) => keyToRuleVersionId.get(key))
        .filter((id): id is string => Boolean(id));
      if (ruleVersionIds.length === 0) continue; // 引用已由联合校验保证存在。
      const row = await prisma.clarification.create({
        data: {
          projectId: job.projectId,
          ruleVersionIds,
          kind: clarification.kind,
          question: clarification.question,
        },
      });
      clarificationIds.push(row.id);
    }

    const result = {
      documentVersionIds: request.documentVersionIds,
      ruleVersionIds: [...keyToRuleVersionId.values()],
      clarificationIds,
      unparsedSpanIds: output.unparsedRanges.map((r) => r.spanId),
    };
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "SUCCEEDED", result: result as never, finishedAt: new Date() },
    });
  });
}

/** 构造 CaseGenerationInput（processor 与测试共用 → mock hash 必然一致）。 */
export async function buildCaseGenerationJobInput(
  prisma: PrismaClient,
  projectId: string,
  ruleVersionIds: string[],
): Promise<CaseGenerationInput> {
  const ruleRows = await prisma.ruleVersion.findMany({
    where: { id: { in: ruleVersionIds }, reviewStatus: "APPROVED" },
    include: { rule: { select: { projectId: true } } },
  });
  if (ruleRows.length !== ruleVersionIds.length) {
    throw Object.assign(new Error("存在非 APPROVED 或不存在的规则版本"), {
      code: "VALIDATION_ERROR",
      details: {
        missing: ruleVersionIds.filter((id) => !ruleRows.some((r) => r.id === id)),
      },
    });
  }

  const approved = [];
  for (const row of ruleRows) {
    const parsed = RuleVersionSchema.safeParse({
      id: row.id,
      ruleId: row.ruleId,
      version: row.version,
      statement: row.statement,
      classification: row.classification,
      role: row.role ?? undefined,
      precondition: row.precondition ?? undefined,
      action: row.action,
      condition: row.condition ?? undefined,
      expectation: row.expectation,
      forbiddenBehaviors: row.forbiddenBehaviors,
      priority: row.priority,
      businessFields: row.businessFields,
      sources: row.sources,
      conflictsWith: row.conflictsWith,
      reviewStatus: row.reviewStatus,
      supersedesId: row.supersedesId,
      origin: row.origin,
      promptVersion: row.promptVersion,
      reviewedBy: row.reviewedBy,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    });
    if (!parsed.success) {
      throw Object.assign(new Error(`规则 ${row.id} 数据不符合契约`), {
        code: "INTERNAL",
        details: { issues: parsed.error.issues.slice(0, 3) },
      });
    }
    approved.push(parsed.data);
  }

  const roles = [...new Set(approved.map((r) => r.role).filter((r): r is string => Boolean(r)))];
  const clarificationRows = await prisma.clarification.findMany({
    where: { projectId, resolvedAt: null },
  });

  return CaseGenerationInput.parse({
    approvedRuleVersions: approved,
    clarificationSources: clarificationRows.map((c) => ({
      id: c.id,
      ruleVersionIds: c.ruleVersionIds,
      question: c.question,
      answer: c.answer,
      answerSource: c.answerSource,
      resolvedBy: c.resolvedBy,
      resolvedAt: c.resolvedAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
    })),
    roles: roles.length > 0 ? roles : ["applicant"],
    fixtureCapabilities: [],
    executorCapabilities: [...PHASE1_EXECUTOR_ACTIONS],
    promptVersion: REFERENCE_PROMPT_VERSION,
  });
}

async function runCaseGeneration(prisma: PrismaClient, job: JobRow): Promise<void> {
  const request = job.request as { ruleVersionIds: string[]; mode: "real" | "mock" };
  const adapter = adapterFor(request.mode);

  const input = await buildCaseGenerationJobInput(prisma, job.projectId, request.ruleVersionIds);
  const output = await referenceCaseGenerationPipeline(
    input,
    withInvocationRecording(job.projectId, prisma, adapter, "CASE_GENERATION"),
  );

  const validation = validateCaseGeneration(input, output);
  if (!validation.ok) {
    throw Object.assign(new Error("用例生成输出未通过联合校验"), {
      code: "MODEL_OUTPUT_INVALID",
      details: { problems: validation.problems.slice(0, 10) },
    });
  }

  await commitJob(prisma, job, async (prisma) => {
    const caseVersionIds: string[] = [];
    for (const draft of output.caseDrafts) {
      const testCase = await prisma.testCase.create({ data: { projectId: job.projectId } });
      const normalized = TestCaseVersionSchema.parse({
        ...draft, id: randomUUID(), caseId: testCase.id, version: 1,
        steps: draft.steps.map((step) => ({ ...step, id: randomUUID() })),
        approvalStatus: "DRAFT", origin: "model", promptVersion: REFERENCE_PROMPT_VERSION,
        createdAt: new Date().toISOString(),
      });
      const caseVersion = await prisma.testCaseVersion.create({
        data: {
          id: normalized.id,
          caseId: testCase.id,
          version: 1,
          title: draft.title,
          description: draft.description ?? null,
          ruleVersionIds: draft.ruleVersionIds,
          roles: draft.roles,
          preconditions: draft.preconditions as never,
          dataSpec: draft.dataSpec as never,
          steps: normalized.steps as never,
          assertions: draft.assertions as never,
          cleanup: draft.cleanup as never,
          priority: draft.priority,
          approvalStatus: "DRAFT",
          origin: "model",
          promptVersion: REFERENCE_PROMPT_VERSION,
          projectId: job.projectId,
        },
      });
      await prisma.testCase.update({
        where: { id: testCase.id },
        data: { currentVersionId: caseVersion.id },
      });
      caseVersionIds.push(caseVersion.id);
    }

    const result = {
      caseVersionIds,
      blockedRequirementCount: output.blockedRequirements.length,
    };
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "SUCCEEDED", result: result as never, finishedAt: new Date() },
    });
  });
}
