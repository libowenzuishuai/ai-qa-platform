import {runExploration} from './exploration-job.js';
import {runGoalProposal} from './goal-job.js';
import { loadCompletedChunks } from "../../api/src/chunk-results.js";
import {runChangeReview} from "./change-review-job.js";
import { runSnapshotDiff } from "./snapshot-diff-job.js";
import { runDocumentChunk, runChunkExtract } from "./chunk-jobs.js";
import { runLoginCheck } from './login-check-job.js';
import { runDataJob } from './data-plugin-job.js';
import { processProductJob } from "./product-jobs.js";
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
import { runDocumentParse, markDocumentFailed } from "./document-job.js";
import { callIntelligence } from "./intelligence-client.js";
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

async function failJob(prisma: PrismaClient, job: JobRow & { kind: string }, err: unknown): Promise<void> {
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
      : { code: job.kind === "PLAN_PROPOSAL" && err instanceof Error && err.name === "ZodError" ? "MODEL_OUTPUT_INVALID" : "INTERNAL", message: String(err).slice(0, 500), requestId: job.id };
  await prisma.$transaction(async tx => {
  const changed = await tx.job.updateMany({
    where: ownedJob(job),
    data: {
      status: "FAILED",
      error: error as never,
      finishedAt: new Date(),
    },
  });
  if (changed.count) {
    await markDocumentFailed(tx, job);
    if(job.kind==='LOGIN_CHECK')await tx.loginPreparation.updateMany({where:{lastCheckJobId:job.id},data:{lastCheckStatus:'ERROR',lastCheckAt:null,lastCheckDetail:'检查作业失败，请核对配置后重新检查'}});
  }
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
  promptVersion = REFERENCE_PROMPT_VERSION,
): Promise<void> {
  await prisma.modelInvocation.create({
    data: {
      projectId,
      provider: response.provider,
      model: response.model,
      promptVersion,
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
  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    void prisma.job.updateMany({
      where: ownedJob(job), data: { updatedAt: new Date() },
    }).then(r=>{if(!r.count)controller.abort();}).catch(() => controller.abort());
  }, ((job.request as {workflowId?:string}).workflowId||["LOGIN_CHECK","DATA_PREPARE","DATA_CLEANUP","DATA_INSPECT","CHANGE_REVIEW"].includes(job.kind))?250:10_000);
  heartbeat.unref();
  config={...config,executionSignal:AbortSignal.any([controller.signal,...(config.executionSignal?[config.executionSignal]:[])])};
  try {
    const request=job.request as {chunkBatchId?:string;workflowId?:string;workflowBudget?:WorkerConfig['executionBudget']};
    if(request.chunkBatchId&&!await prisma.job.findFirst({where:{id:request.chunkBatchId,projectId:job.projectId,kind:"CHUNK_BATCH",status:"RUNNING"}}))throw Object.assign(new Error("分块父作业已停止"),{code:"CONFLICT"});
    if(request.workflowId){
      const wf=await prisma.workflowRun.findUniqueOrThrow({where:{id:request.workflowId}});
      if(wf.status!=='RUNNING'||!request.workflowBudget||Date.now()>=request.workflowBudget.deadline)throw Object.assign(new Error('工作流已停止或预算到期'),{code:'BUDGET_EXCEEDED'});
      if(config.intelligenceBackend!=='python'&&['DOCUMENT_PARSE','RULE_EXTRACTION','CASE_GENERATION','PLAN_PROPOSAL'].includes(job.kind))throw Object.assign(new Error('受预算约束的工作流要求 Python 网关'),{code:'DEPENDENCY_UNAVAILABLE'});
      config={...config,executionBudget:request.workflowBudget};
    }
    const store = new ArtifactStore(config.artifactDir);
    if(job.kind === "EXPLORATION"){
      await runExploration(prisma,store,job,config.executionSignal,commitJob);
    } else if(job.kind === "GOAL_PROPOSAL"){
      await runGoalProposal(prisma,job,config,commitJob);
    } else if(job.kind === "CHANGE_REVIEW") {
      await runChangeReview(prisma,store,job,config,commitJob);
    } else if(job.kind === "SNAPSHOT_DIFF") {
      await runSnapshotDiff(prisma,store,job,config,commitJob);
    } else if(job.kind === "DOCUMENT_CHUNK") {
      await runDocumentChunk(prisma,store,job,config,commitJob);
    } else if(job.kind === "CHUNK_BATCH") {
      await runChunkBatch(prisma,job,config);
    } else if(job.kind === "CHUNK_EXTRACT") {
      await runChunkExtract(prisma,store,job,config,commitJob);
    } else if(job.kind === "LOGIN_CHECK") {
      await runLoginCheck(prisma,store,job,commitJob,controller.signal);
    } else if(["DATA_PREPARE","DATA_CLEANUP","DATA_INSPECT"].includes(job.kind)){
      await runDataJob(prisma,store,job,commitJob,controller.signal);
    } else if (job.kind === "DOCUMENT_PARSE") {
      await runDocumentParse(prisma, store, job, config, commitJob);
    } else if (job.kind === "RULE_EXTRACTION") {
      await runRuleExtraction(prisma, store, job, config);
    } else if (job.kind === "CASE_GENERATION") {
      await runCaseGeneration(prisma, job, config);
    } else if (["WEB_OBSERVATION", "PLAN_PROPOSAL", "REPO_DISCOVERY"].includes(job.kind)) {
      await processProductJob(prisma, store, config, job, commitJob);
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
    const parentId=(job.request as {chunkBatchId?:string}).chunkBatchId;
    if(parentId){
      const parent=await tx.job.updateMany({where:{id:parentId,projectId:job.projectId,kind:'CHUNK_BATCH',status:'RUNNING'},data:{updatedAt:new Date()}});
      if(!parent.count)throw Object.assign(new Error('分块父作业已停止，拒绝提交'),{code:'CONFLICT'});
    }
    await persist(tx);
  }, { timeout: 30_000 });
}

async function runRuleExtraction(
  prisma: PrismaClient,
  store: ArtifactStore,
  job: JobRow,
  config: WorkerConfig,
): Promise<void> {
  const request = job.request as {
    documentVersionIds: string[];
    glossaryUpdates?: Array<{ term: string; definition: string }>;
    completedChunkManifestHash?: string;
    mode: "real" | "mock";
  };
  const adapter = config.intelligenceBackend === "python" || request.completedChunkManifestHash ? null : adapterFor(request.mode);

  // 加载 bundle（artifact-store）+ 二验 PARSED。
  const bundles = [];
  for (const documentVersionId of request.documentVersionIds) {
    const doc = await prisma.documentVersion.findUnique({ where: { id: documentVersionId }, include: { document: true } });
    if (!doc || doc.document.projectId !== job.projectId || doc.parseStatus !== "PARSED") throw Object.assign(new Error("文档不属于项目或未解析"), { code: "VALIDATION_ERROR" });
    if (request.mode === "real" && doc.mode !== "real" && ["PNG", "JPEG", "PDF_TEXT", "PDF_SCANNED"].includes(doc.format)) throw Object.assign(new Error("模拟视觉转录不能用于真实规则提取"), { code: "VALIDATION_ERROR" });
    const key = doc.bundleStorageKey ?? bundleStorageKey(documentVersionId);
    if (doc.fileSizeBytes !== null && (!doc.bundleStorageKey || !store.verify(key, doc.bundleChecksum))) throw Object.assign(new Error("解析产物缺失或被篡改"), { code: "VALIDATION_ERROR" });
    let raw: string;
    try {
      raw = store.read(key).toString("utf8");
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
    if (parsed.data.documentVersionId !== documentVersionId) throw Object.assign(new Error("解析版本引用不匹配"), { code: "VALIDATION_ERROR" });
    bundles.push(parsed.data);
  }

  const input = RuleExtractionInput.parse({
    projectGlossary: request.glossaryUpdates ?? [],
    documentVersions: bundles,
    images: [],
    promptVersion: config.intelligenceBackend === "python" ? "agents-v2" : REFERENCE_PROMPT_VERSION,
  });
  const chunks = request.completedChunkManifestHash
    ? await loadCompletedChunks(prisma,job.projectId,request.documentVersionIds[0]!,request.completedChunkManifestHash) : null;
  if(chunks && (request.documentVersionIds.length!==1 || chunks.mode!==request.mode))throw Object.assign(new Error('块清单或模式与请求不符'),{code:'VALIDATION_ERROR'});
  const remote = !chunks && config.intelligenceBackend === "python"
    ? await callIntelligence(config, "rules", job.id, request.mode, input) : null;
  const output = chunks ? chunks.merged : remote ? RuleExtractionOutput.parse(remote.output) : await referenceRuleExtractionPipeline(
    input, withInvocationRecording(job.projectId, prisma, adapter!, "RULE_EXTRACTION"),
  );

  // 联合校验（拦编造引用/张冠李戴/单方消解）。
  const validation = validateRuleExtraction(input, output);
  if (!validation.ok) {
    throw Object.assign(new Error("规则提取输出未通过联合校验"), {
      code: "MODEL_OUTPUT_INVALID",
      details: { problems: validation.problems.slice(0, 10) },
    });
  }

  if (remote) {
    for (const invocation of remote.invocations) {
      await recordInvocation(prisma, job.projectId, invocation.response, invocation.purpose, invocation.promptVersion);
    }
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
          generationMode: request.mode,
          promptVersion: input.promptVersion,
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
  promptVersion = REFERENCE_PROMPT_VERSION,
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
    if (row.rule.projectId !== projectId) throw Object.assign(new Error("规则不属于本项目"), { code: "VALIDATION_ERROR" });
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
  if (!roles.length) throw Object.assign(new Error("规则没有确认的业务角色，无法生成用例"), { code: "VALIDATION_ERROR" });
  const related = await prisma.clarification.findMany({ where: { projectId, ruleVersionIds: { hasSome: ruleVersionIds } } });
  if (related.some(c => !c.resolvedAt || !c.answer?.trim() || !c.answerSource?.trim() || !c.resolvedBy)) throw Object.assign(new Error("选定规则仍有未确认的澄清"), { code: "VALIDATION_ERROR" });
  const clarificationRows = related;


  return CaseGenerationInput.parse({
    approvedRuleVersions: approved,
    clarificationSources: clarificationRows.map((c) => ({
      id: c.id,
      ruleVersionIds: c.ruleVersionIds.filter(id => ruleVersionIds.includes(id)),
      question: c.question,
      answer: c.answer,
      answerSource: c.answerSource,
      resolvedBy: c.resolvedBy,
      resolvedAt: c.resolvedAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
    })),
    roles,
    fixtureCapabilities: [],
    executorCapabilities: [...PHASE1_EXECUTOR_ACTIONS],
    promptVersion,
  });
}

async function runCaseGeneration(prisma: PrismaClient, job: JobRow, config: WorkerConfig): Promise<void> {
  const request = job.request as { ruleVersionIds: string[]; mode: "real" | "mock" };
  const adapter = config.intelligenceBackend === "python" ? null : adapterFor(request.mode);

  if (request.mode === "real" && await prisma.ruleVersion.count({ where: { id: { in: request.ruleVersionIds }, origin: "model", OR: [{ generationMode: null }, { generationMode: { not: "real" } }] } })) throw Object.assign(new Error("模拟或模式未核验的规则不能用于真实用例生成"), { code: "VALIDATION_ERROR" });
  const input = await buildCaseGenerationJobInput(prisma, job.projectId, request.ruleVersionIds,
    config.intelligenceBackend === "python" ? "agents-v2" : REFERENCE_PROMPT_VERSION);
  const remote = config.intelligenceBackend === "python"
    ? await callIntelligence(config, "cases", job.id, request.mode, input) : null;
  const output = remote ? CaseGenerationOutput.parse(remote.output) : await referenceCaseGenerationPipeline(
    input, withInvocationRecording(job.projectId, prisma, adapter!, "CASE_GENERATION"),
  );

  const validation = validateCaseGeneration(input, output);
  if (!validation.ok) {
    throw Object.assign(new Error("用例生成输出未通过联合校验"), {
      code: "MODEL_OUTPUT_INVALID",
      details: { problems: validation.problems.slice(0, 10) },
    });
  }

  if (remote) {
    for (const invocation of remote.invocations) {
      await recordInvocation(prisma, job.projectId, invocation.response, invocation.purpose, invocation.promptVersion);
    }
  }
  await commitJob(prisma, job, async (prisma) => {
    const caseVersionIds: string[] = [];
    for (const draft of output.caseDrafts) {
      const testCase = await prisma.testCase.create({ data: { projectId: job.projectId } });
      const normalized = TestCaseVersionSchema.parse({
        ...draft, id: randomUUID(), caseId: testCase.id, version: 1,
        steps: draft.steps.map((step) => ({ ...step, id: randomUUID() })),
        approvalStatus: "DRAFT", origin: "model", promptVersion: input.promptVersion,
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
          generationMode: request.mode,
          promptVersion: input.promptVersion,
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

async function runChunkBatch(prisma:PrismaClient,job:JobRow,config:WorkerConfig){
 const request=job.request as {documentVersionId:string;manifestHash:string;mode:'real'|'mock'};
 const doc=await prisma.documentVersion.findUniqueOrThrow({where:{id:request.documentVersionId},include:{document:true}});
 if(doc.document.projectId!==job.projectId||doc.chunkManifestHash!==request.manifestHash)throw Object.assign(new Error('分块批处理来源已变化'),{code:'CONFLICT'});
 const chunks=await prisma.documentChunk.findMany({where:{documentVersionId:doc.id,manifestHash:request.manifestHash},orderBy:{seq:'asc'}});
 const manifest=doc.chunkManifest as any;
 if(!chunks.length||chunks.length!==manifest?.chunks?.length||chunks.some(c=>!manifest.chunks.some((m:any)=>m.chunkId===c.chunkId)))throw Object.assign(new Error('分块清单与处理记录不一致'),{code:'CONFLICT'});
 for(const chunk of chunks){
  if(config.executionSignal?.aborted)throw new Error('已取消');
  const parent=await prisma.job.findUniqueOrThrow({where:{id:job.id}});if(parent.status!=='RUNNING')throw new Error('父作业已停止');
  if(chunk.status==='completed')continue;
  let childId='';
  await commitJob(prisma,job,async tx=>{
   const child=await tx.job.upsert({where:{projectId_kind_fingerprint:{projectId:job.projectId,kind:'CHUNK_EXTRACT',fingerprint:job.id+':'+chunk.id}},create:{projectId:job.projectId,kind:'CHUNK_EXTRACT',fingerprint:job.id+':'+chunk.id,request:{chunkRowId:chunk.id,mode:request.mode,chunkBatchId:job.id}},update:{}});childId=child.id;
  });
  await processAgentJob(prisma,config,childId);
  const child=await prisma.job.findUniqueOrThrow({where:{id:childId}});
  if(child.status!=='SUCCEEDED')throw Object.assign(new Error('分块未完成；保留已有结果，修复后显式恢复'),{code:(child.error as any)?.code??'CONFLICT'});
 }
 await commitJob(prisma,job,async tx=>{await tx.job.update({where:{id:job.id},data:{status:'SUCCEEDED',result:{documentVersionId:doc.id,completed:chunks.length},finishedAt:new Date()}});});
}
