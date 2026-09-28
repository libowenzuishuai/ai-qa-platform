import { randomUUID, createHash } from "node:crypto";
import type { PrismaClient, Prisma } from "@prisma/client";
import { ArtifactStore } from "@ai-qa/artifact-store";
import { OracleSpec, computeOracleHash, canonicalStringify, SessionBudget, LoopPlannerRequest, LoopPlannerResponse } from "@ai-qa/contracts";
import type { CapabilityResult } from "@ai-qa/adapter-sdk";
import { invokeCapability } from "./capability-invoker.js";

/** Synthetic draft workflow only. The durable host does not imply general website autonomy. */
export interface SessionLoopInput {
  prisma: PrismaClient; sessionId: string; baseUrl: string;
  planner: "script" | "python-real";
  intelligence?: { url: string; token: string };
  maxRounds?: number; artifactDir?: string; signal?: AbortSignal;
  killAt?: "after_write_before_receipt"; killMarkerFile?: string;
}
export interface SessionLoopResult {
  status: "COMPLETED" | "FAILED" | "NO_PROGRESS" | "CANCELLED" | "PAUSED";
  rounds: number; verdict: "pass" | "fail" | "no_progress" | "blocked" | "review";
  finalTitle: string | null; draftId: string | null; reason: string;
}
type Draft = { id: string; title: string };
type Checkpoint = { round?: number; draftId?: string | null; pendingIntentId?: string | null; lastEquivalent?: string; equivalentCount?: number; toolCalls?: number; modelCalls?: number; installationId?: string; activeMs?: number; renameSucceeded?: boolean; tokensCharged?: number; tokensUsed?: number; contextManifestId?: string };
const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED"];
const LEASE_MS = 10_000;
const hash = (v: unknown) => createHash("sha256").update(canonicalStringify(v)).digest("hex");
const fault = (code: string, message: string) => Object.assign(new Error(message), { code });

export async function runDraftSessionLoop(args: SessionLoopInput): Promise<SessionLoopResult> {
  const { prisma, sessionId } = args;
  let session = await prisma.v2ExecutionSession.findUniqueOrThrow({ where: { id: sessionId } });
  const savedResult = () => session.result as unknown as SessionLoopResult | null;
  if (TERMINAL.includes(session.status)) return savedResult() ?? { status: session.status as SessionLoopResult["status"], verdict: "review", rounds: 0, finalTitle: null, draftId: null, reason: session.terminationReason ?? session.status };
  if (session.status === "PAUSED") return { status: "PAUSED", verdict: "no_progress", rounds: 0, finalTitle: null, draftId: null, reason: "会话已暂停" };
  if (args.planner === "python-real" && (!args.intelligence?.url || !args.intelligence?.token)) throw fault("CONFIG_MISSING", "python-real 规划器需要智能服务地址与令牌");
  const budget = SessionBudget.parse(session.budget);
  const leaseToken = randomUUID();
  const claimed = await prisma.v2ExecutionSession.updateMany({
    where: { id: sessionId, status: { in: ["QUEUED", "PREPARING", "RUNNING"] }, OR: [{ leaseToken: null }, { leaseExpiresAt: { lte: new Date() } }] },
    data: { status: "RUNNING", leaseToken, leaseExpiresAt: new Date(Date.now() + LEASE_MS), startedAt: session.startedAt ?? new Date(), targetBaseUrl: session.targetBaseUrl ?? args.baseUrl },
  });
  if (!claimed.count) throw fault("LEASE_BUSY", "会话由另一执行进程持有");
  session = await prisma.v2ExecutionSession.findUniqueOrThrow({ where: { id: sessionId } });
  let cp = session.checkpoint as Checkpoint;
  const started = Date.now();
  const activeBaseline = cp.activeMs ?? 0;
  const deadline = Math.min(session.startedAt!.getTime() + budget.maxWallClockMs, started + budget.maxActiveMs - (cp.activeMs ?? 0));
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, ...(args.signal ? [args.signal] : [])]);
  const store = new ArtifactStore(args.artifactDir ?? process.env.AIQA_ARTIFACT_DIR ?? "data/artifacts");
  const ownership = () => ({ id: sessionId, leaseToken, status: "RUNNING", leaseExpiresAt: { gt: new Date() } });
  async function guard() {
    if (signal.aborted) throw fault("EXECUTION_STOPPED", "执行已中止，待对账");
    if (Date.now() >= deadline) throw fault("BUDGET_EXCEEDED", "会话时间预算耗尽");
    const row = await prisma.v2ExecutionSession.findFirst({ where: ownership() });
    if (!row) throw fault("LEASE_LOST", "会话已暂停、取消或租约失效");
  }
  async function commit<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async tx => {
      const own = await tx.v2ExecutionSession.updateMany({ where: ownership(), data: { updatedAt: new Date() } });
      if (!own.count) throw fault("LEASE_LOST", "旧执行拒绝提交");
      return fn(tx);
    });
  }
  async function checkpoint() {
    const activeMs = activeBaseline;
    cp.activeMs = activeMs + Date.now() - started;
    await commit(tx => tx.v2ExecutionSession.update({ where: { id: sessionId }, data: {
      checkpoint: { ...cp, activeMs: activeMs + Date.now() - started } as never,
      usage: { wallClockMsUsed: Date.now() - session.startedAt!.getTime(), activeMsUsed: activeMs + Date.now() - started,
        modelCallsUsed: cp.modelCalls ?? 0, modelCallsReserved: 0, tokensUsed: cp.tokensUsed ?? 0, tokensReserved: Math.max(0, (cp.tokensCharged ?? 0) - (cp.tokensUsed ?? 0)),
        toolCallsUsed: cp.toolCalls ?? 0, toolCallsReserved: 0, resourcesCreated: cp.draftId ? 1 : 0, costKnownMicros: null },
    } }));
  }
  const heartbeat = setInterval(() => {
    void prisma.v2ExecutionSession.updateMany({ where: ownership(), data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) } })
      .then(r => { if (!r.count) controller.abort(); }).catch(() => controller.abort());
  }, 250);
  heartbeat.unref();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
  timeout.unref();
  async function finish(status: SessionLoopResult["status"], verdict: SessionLoopResult["verdict"], reason: string, finalTitle: string | null = null) {
    const result: SessionLoopResult = { status, verdict, reason, finalTitle, draftId: cp.draftId ?? null, rounds: cp.round ?? 0 };
    await checkpoint();
    await commit(async tx => {
      await tx.v2ExecutionSession.update({ where: { id: sessionId }, data: {
        status: status === "NO_PROGRESS" ? "FAILED" : status, terminationReason: reason, result: result as never, leaseToken: null, leaseExpiresAt: null,
      } });
      await tx.v2SessionEvent.create({data:{sessionId,type:"state",payload:result as never}});
    });
    return result;
  }
  async function phase(name: string, status: string, rationale: string, refs: string[] = []) {
    await commit(async tx => {
      await tx.v2SessionEvent.create({data:{sessionId,type:"phase",payload:{round:cp.round!,phase:name,status,rationale,refs}}});
      return tx.v2StepAttempt.upsert({ where: { sessionId_round_phase: { sessionId, round: cp.round!, phase: name } },
      create: { sessionId, round: cp.round!, phase: name, status, rationale, outputRefs: refs },
      update: { status, rationale, outputRefs: refs },
    }); });
  }
  async function artifact(value: unknown, label: string) {
    const stored = store.put({ runId: sessionId, attemptId: `round-${cp.round ?? 0}`, filename: `${label}-${randomUUID()}.json`, data: Buffer.from(canonicalStringify(value)) });
    return commit(tx => tx.artifact.create({ data: { projectId: session.projectId, storageKey: stored.storageKey, checksum: stored.checksum, type: "OBSERVATION", sensitivity: "RESTRICTED_RAW" } }));
  }
  async function loadArtifact(id: string) {
    const a = await prisma.artifact.findFirst({ where: { id, projectId: session.projectId } });
    if (!a || !a.storageKey.startsWith(`${sessionId}/`) || !store.verify(a.storageKey, a.checksum)) throw fault("EVIDENCE_INVALID", "恢复证据缺失或校验和不符");
    return JSON.parse(store.read(a.storageKey).toString());
  }
  async function call(input: Record<string, unknown>, recoveringId?: string): Promise<CapabilityResult> {
    await guard();
    if ((cp.toolCalls ?? 0) >= budget.maxToolCalls) throw fault("BUDGET_EXCEEDED", "工具调用预算耗尽");
    const write = input.op === "create" || input.op === "rename";
    if (input.op === "create" && !cp.draftId && budget.maxResources < 1) throw fault("BUDGET_EXCEEDED", "资源预算耗尽");
    let intent = recoveringId ? await prisma.v2ActionIntent.findFirstOrThrow({ where: { id: recoveringId, sessionId } }) : null;
    if (intent && intent.inputHash !== hash(input)) throw fault("CONFLICT", "恢复输入与原始意图不一致");
    if (!intent) {
      const ref = await artifact(input, "input");
      const step = await commit(tx => tx.v2StepAttempt.upsert({ where: { sessionId_round_phase: { sessionId, round: cp.round!, phase: write ? "act" : "observe" } },
        create: { sessionId, round: cp.round!, phase: write ? "act" : "observe", status: "RUNNING", rationale: `派发 ${input.op}` }, update: {} }));
      intent = await commit(tx => tx.v2ActionIntent.create({ data: {
        sessionId, stepAttemptId: step.id, capabilityId: "synthetic.draft-ops", capabilityVersion: "1.0.0",
        inputHash: hash(input), inputArtifactId: ref.id, idempotencyKey: `session-${sessionId}-${randomUUID()}`,
        fencingToken: leaseToken, deadline: new Date(deadline),
      } }));
    }
    if (recoveringId) await commit(tx => tx.v2Invocation.updateMany({where:{intentId:intent!.id,status:"RUNNING"},data:{status:"UNKNOWN",error:{code:"WORKER_LOST",message:"上次执行失联，效果未知"}}}));
    const attemptNo = await prisma.v2Invocation.count({ where: { intentId: intent.id } }) + 1;
    if (attemptNo > 10) throw fault("BUDGET_EXCEEDED", "同一意图恢复次数耗尽");
    cp.toolCalls = (cp.toolCalls ?? 0) + 1;
    if (write) cp.pendingIntentId = intent.id;
    await checkpoint();
    const invocation = await commit(tx => tx.v2Invocation.create({ data: { intentId: intent!.id, attemptNo, status: "RUNNING", startedAt: new Date() } }));
    let result: CapabilityResult;
    try {
      result = await invokeCapability({ prisma, projectId: session.projectId, capabilityId: intent.capabilityId, capabilityVersion: intent.capabilityVersion,
        installationId: cp.installationId, input, environmentId: session.environmentId, actionScope: ["draft:ops"], deadline: Math.min(deadline, Date.now() + 20_000),
        signal, allowedOrigins: [new URL(args.baseUrl).origin], idempotencyKey: intent.idempotencyKey, invocationId: invocation.id });
    } catch (e) {
      result = { status: write ? "UNKNOWN" : "FAILED", output: null, resourceKeys: [], retryable: false, error: { code: "DEPENDENCY_UNAVAILABLE", message: (e as Error).message } };
    }
    if (write && args.killAt && args.killMarkerFile) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(args.killMarkerFile, "written");
      await new Promise(() => {});
    }
    // Cancellation of an in-flight write is uncertain; never label it safely retryable.
    if (write && result.status === "CANCELLED") result = { ...result, status: "UNKNOWN", retryable: false };
    const output = await artifact(result, "receipt");
    const draft = (result.output as { draft?: Draft } | null)?.draft;
    if (result.status === "SUCCEEDED" && draft?.id && input.op === "create") cp.draftId = draft.id;
    if (result.status === "SUCCEEDED" && input.op === "rename") cp.renameSucceeded = true;
    if (result.status !== "UNKNOWN") cp.pendingIntentId = null;
    await commit(async tx => {
      await tx.v2Invocation.update({ where: { id: invocation.id }, data: { status: result.status, finishedAt: new Date(), error: result.error as never,
        receipt: { intentId: intent!.id, outcome: result.status === "SUCCEEDED" ? "succeeded" : result.status === "UNKNOWN" ? "unknown_write" : "failed",
          resourceKeys: draft?.id ? [`draft:${draft.id}`] : result.resourceKeys, externalRefs: [output.id], outputHash: hash(result), recordedAt: new Date().toISOString() },
      } });
      await tx.v2ExecutionSession.update({ where: { id: sessionId }, data: { checkpoint: cp as never } });
    });
    if (result.status === "SUCCEEDED") {
      await commit(tx => tx.v2Observation.create({ data: { sessionId, round: cp.round!, source: "api", observedUrl: args.baseUrl, evidenceArtifactIds: [output.id], summary: { op: input.op, output: result.output } as never } }));
    }
    await phase(write ? "act" : "observe", result.status === "SUCCEEDED" ? "SUCCEEDED" : "FAILED", result.error?.message ?? `完成 ${input.op}`, [invocation.id]);
    return result;
  }
  try {
    if (session.targetBaseUrl !== args.baseUrl) throw fault("CONFLICT", "目标地址与冻结会话不一致");
    const environment = await prisma.environment.findFirst({ where: { id: session.environmentId, projectId: session.projectId, isProduction: false } });
    if (!environment?.allowedOrigins.includes(new URL(args.baseUrl).origin)) throw fault("FORBIDDEN", "目标已不在环境白名单");
    if (!cp.installationId) {
      const install = await prisma.v2AdapterInstallation.findFirst({ where: { projectId: session.projectId, capabilityId: "synthetic.draft-ops", capabilityVersion: "1.0.0", status: "AUTHORIZED" }, orderBy: { installedAt: "desc" } });
      if (!install) throw fault("FORBIDDEN", "能力未安装或授权已撤销");
      cp.installationId = install.id;
      await checkpoint();
    }
    const row = await prisma.v2OracleSpec.findFirstOrThrow({ where: { id: session.oracleSpecId, projectId: session.projectId } });
    const oracle = OracleSpec.parse({ ...row, createdAt: row.createdAt.toISOString(), approvedAt: row.approvedAt?.toISOString() ?? null });
    if (!["APPROVED", "SUPERSEDED"].includes(row.status) || !row.approvedAt || !row.approvedBy || row.oracleHash !== session.oracleHash || computeOracleHash(oracle) !== session.oracleHash) throw fault("CONFLICT", "固定标准哈希或批准记录不符");
    // This adapter only observes a draft title. Reject unsupported standards before any effect.
    if (!oracle.assertions.length || oracle.semanticCandidates.length || oracle.assertions.some(a => a.observationType !== "api_field" || a.observationRef !== "draft.title" || a.operator !== "equals" || typeof a.expected !== "string" || a.precondition !== null || a.allowedRoles.length)) throw fault("UNSUPPORTED_ORACLE", "草稿模板仅支持无条件 draft.title 文本相等断言；其余标准需要相应观察器");
    const targetTitle = String(oracle.assertions[0]!.expected);
    if (oracle.assertions.some(a => a.expected !== targetTitle)) throw fault("ORACLE_CONFLICT", "标准之间存在冲突，需人工澄清");
    const maxRounds = args.maxRounds ?? 10;
    for (let round = (cp.round ?? 0) + 1; round <= maxRounds; round++) {
      cp.round = round;
      await guard(); await checkpoint();
      if (cp.pendingIntentId) {
        const intent = await prisma.v2ActionIntent.findFirstOrThrow({ where: { id: cp.pendingIntentId, sessionId } });
        if (!intent.inputArtifactId) throw fault("RECOVERY_REQUIRED", "旧意图没有冻结输入，需人工核对");
        const original = await loadArtifact(intent.inputArtifactId);
        if (!["create", "rename"].includes(original.op)) throw fault("RECOVERY_REQUIRED", "未识别的写入，拒绝重放");
        await phase("plan", "SUCCEEDED", "恢复对账：同一已声明幂等操作、原输入与原幂等键");
        const recovered = await call(original, intent.id);
        if (recovered.status !== "SUCCEEDED" && recovered.status !== "UNKNOWN") return await finish("FAILED", "blocked", `恢复失败：${recovered.error?.message}`);
        continue;
      }
      const metaResult = await call({ op: "meta", baseUrl: args.baseUrl });
      if (metaResult.status !== "SUCCEEDED") return await finish("FAILED", "blocked", `观察失败：${metaResult.error?.message}`);
      const renamePath = (metaResult.output as { meta?: { routes?: { renameDraft?: string } } }).meta?.routes?.renameDraft;
      if (!renamePath) throw fault("MODEL_OUTPUT_INVALID", "目标未提供操作入口");
      let fresh: Draft | null = null;
      if (cp.draftId) {
        const read = await call({ op: "get", baseUrl: args.baseUrl, draftId: cp.draftId });
        if (read.status !== "SUCCEEDED") return await finish("FAILED", "blocked", `验证读取失败：${read.error?.message}`);
        fresh = (read.output as { draft?: Draft }).draft ?? null;
        if (!fresh || fresh.id !== cp.draftId || typeof fresh.title !== "string") throw fault("MODEL_OUTPUT_INVALID", "观察资源与会话资源不匹配");
      }
      if (args.planner === "python-real") {
        await guard();
        if ((cp.modelCalls ?? 0) >= budget.maxModelCalls) throw fault("BUDGET_EXCEEDED", "模型调用预算耗尽");
        if (budget.maxCostMicros !== null) throw fault("CONFIG_MISSING", "配置费用上限前需要可信模型价格，未知费用不按零计");
        const remainingTokens = budget.maxTokens - (cp.tokensCharged ?? 0);
        if (remainingTokens < 1000) throw fault("BUDGET_EXCEEDED", "模型令牌预算不足");
        const context = cp.contextManifestId
          ? await prisma.v2ContextManifest.findFirst({ where: { id: cp.contextManifestId, projectId: session.projectId, sessionId } })
          : await prisma.v2ContextManifest.findFirst({ where: { projectId: session.projectId, sessionId }, orderBy: { generatedAt: "desc" } });
        const contextExcerpt: Array<{spanId:string; text:string}> = [];
        if (context) {
          const { loadReviewBundle } = await import("../../../api/src/change-review-service.js");
          const selections = context.selections as Array<{decision:string;kind:string;documentVersionId:string;ref:string}>;
          const docs = new Map<string, Awaited<ReturnType<typeof loadReviewBundle>>>();
          for (const selection of selections.filter(x => x.decision === "selected" && x.kind === "span").slice(0, 50)) {
            let doc = docs.get(selection.documentVersionId);
            if (!doc) { doc = await loadReviewBundle(prisma, store, session.projectId, selection.documentVersionId); docs.set(selection.documentVersionId, doc); }
            const span = doc.bundle.spans.find(x => x.id === selection.ref);
            if (!span || span.extractionQuality === "UNPARSED") throw fault("CONFLICT", "上下文来源不可用");
            contextExcerpt.push({ spanId: `${selection.documentVersionId}:${selection.ref}`, text: (span.quotedText ?? "").slice(0, 2000) });
          }
          cp.contextManifestId = context.id;
        }
        const timeoutMs = Math.min(120000, deadline - Date.now());
        if (timeoutMs < 1000) throw fault("BUDGET_EXCEEDED", "剩余时间不足以规划");
        const request = LoopPlannerRequest.parse({ schemaVersion: "1.0", requestId: randomUUID(), mode: "real", timeoutMs,
          input: { goal: session.goal, oracleAssertions: oracle.assertions.map(({observationType,observationRef,operator,expected}) => ({observationType,observationRef,operator,expected})),
            observation: {renamePath,draft:fresh}, contextManifestId: context?.id ?? null, contextExcerpt, promptVersion: "loop-planner-v1" } });
        // Charge before the HTTP call. A timeout/crash keeps its reservation; recovery cannot spend it again.
        cp.modelCalls = (cp.modelCalls ?? 0) + 1;
        cp.tokensCharged = (cp.tokensCharged ?? 0) + remainingTokens;
        await checkpoint();
        const requestRef = await artifact(request, "planner-request");
        await phase("plan", "RUNNING", `模型规划，实际请求 sha256=${hash(request)}`, [requestRef.id]);
        const response = await fetch(new URL("/v2/loop/plan", args.intelligence!.url), {
          method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
          headers: { "content-type": "application/json", authorization: `Bearer ${args.intelligence!.token}`, "x-aiqa-model-calls": "1", "x-aiqa-model-tokens": String(remainingTokens) },
          body: JSON.stringify(request),
        });
        if (!response.ok) throw fault("DEPENDENCY_UNAVAILABLE", `规划服务 HTTP ${response.status}`);
        const parsed = LoopPlannerResponse.parse(await response.json());
        if (parsed.requestId !== request.requestId || parsed.mode !== request.mode || parsed.invocations.length !== 1) throw fault("MODEL_OUTPUT_INVALID", "规划响应身份或调用数量不符");
        const used = parsed.invocations.reduce((n,i) => n + i.response.usage.inputTokens + i.response.usage.outputTokens, 0);
        if (!Number.isSafeInteger(used) || used < 0 || parsed.invocations.some(i=>i.response.outcome!=="SUCCESS"||i.response.usage.inputTokens<0||i.response.usage.outputTokens<0) || used > remainingTokens) throw fault("BUDGET_EXCEEDED", "模型返回用量超过预留");
        cp.tokensCharged -= remainingTokens - used;
        cp.tokensUsed = (cp.tokensUsed ?? 0) + used;
        await checkpoint();
        await commit(async tx=>{
          for(const invocation of parsed.invocations) await tx.modelInvocation.create({data:{
            projectId:session.projectId,provider:invocation.response.provider,model:invocation.response.model,
            requestId:invocation.response.requestId,promptVersion:invocation.promptVersion,
            usage:{...invocation.response.usage,sessionId,requestHash:hash(request)},latencyMs:invocation.response.latencyMs,outcome:invocation.response.outcome,
          }});
        });
        const responseRef = await artifact(parsed, "planner-response");
        const plan = parsed.output;
        await phase("plan", "SUCCEEDED", plan.rationale, [requestRef.id,responseRef.id]);
        if (plan.action === "blocked") return await finish("FAILED", "blocked", `规划器阻塞：${plan.rationale}`);
        if (plan.action === "create_draft" && fresh) throw fault("MODEL_OUTPUT_INVALID", "已有资源，拒绝重复创建");
        if (!fresh && plan.action !== "create_draft") throw fault("MODEL_OUTPUT_INVALID", "资源不存在，拒绝执行依赖资源的动作");
        if (plan.action === "rename_draft" && (plan.params.title !== targetTitle || (plan.params.renamePath !== undefined && plan.params.renamePath !== renamePath))) throw fault("MODEL_OUTPUT_INVALID", "规划器修改了标准或编造入口");
        if (fresh && ["done","get_draft","observe_only"].includes(plan.action)) {
          const passed = oracle.assertions.every(a => fresh!.title === a.expected);
          await phase("verify", passed ? "SUCCEEDED" : "FAILED", `独立观察「${fresh.title}」对账全部标准`);
          if (passed) return await finish("COMPLETED", "pass", "独立读回与全部标准相符", fresh.title);
          cp.equivalentCount = (cp.equivalentCount ?? 0) + 1;
          await checkpoint();
          if (cp.equivalentCount >= 3) return await finish("NO_PROGRESS", "no_progress", "模型反复观察但未采取有效动作");
          continue;
        }
      }
      if (!fresh) {
        if(args.planner === "script") await phase("plan", "SUCCEEDED", "无草稿：创建一次隔离资源");
        const created = await call({ op: "create", baseUrl: args.baseUrl, title: "初始草稿" });
        if (created.status === "UNKNOWN") continue;
        if (created.status !== "SUCCEEDED" || !cp.draftId) return await finish("FAILED", "blocked", `创建失败：${created.error?.message ?? "缺少资源标识"}`);
        continue;
      }
      const passed = oracle.assertions.every(a => fresh!.title === a.expected);
      await phase("verify", passed ? "SUCCEEDED" : "FAILED", `实际「${fresh.title}」vs 期望「${targetTitle}」：${passed ? "pass" : "fail"}（${oracle.assertions.length} 条标准）`);
      if (passed) return await finish("COMPLETED", "pass", "目标达成：独立读回与全部标准相符", fresh.title);
      cp.equivalentCount = cp.lastEquivalent === fresh.title ? (cp.equivalentCount ?? 0) + 1 : 1;
      cp.lastEquivalent = fresh.title;
      await checkpoint();
      if (cp.equivalentCount >= 3 && cp.renameSucceeded) return await finish("FAILED", "fail", "三次等价无进展：业务失败，不自修复", fresh.title);
      if(args.planner === "script") await phase("plan", "SUCCEEDED", "依据最新观察选择改名入口，保持批准标准不变");
      const renamed = await call({ op: "rename", baseUrl: args.baseUrl, draftId: cp.draftId, title: targetTitle, renamePath });
      if (renamed.error?.code === "ROUTE_MOVED") { await phase("adapt", "SUCCEEDED", "定位入口变化：下一轮重新观察，不改标准"); continue; }
      if (renamed.status === "UNKNOWN") continue;
      if (renamed.status !== "SUCCEEDED") return await finish("FAILED", "blocked", `动作失败：${renamed.error?.message}`);
    }
    return await finish("NO_PROGRESS", "no_progress", "轮次上限耗尽；恢复不重置预算");
  } catch (error) {
    const current = await prisma.v2ExecutionSession.findUniqueOrThrow({ where: { id: sessionId } });
    if (TERMINAL.includes(current.status) || current.status === "PAUSED") return current.result as unknown as SessionLoopResult ?? { status: current.status as SessionLoopResult["status"], verdict: "no_progress", rounds: cp.round ?? 0, draftId: cp.draftId ?? null, finalTitle: null, reason: current.terminationReason ?? current.status };
    if (current.leaseToken !== leaseToken || (current.leaseExpiresAt?.getTime() ?? 0) <= Date.now()) throw fault("LEASE_LOST", "租约失效，旧执行不能提交");
    // Parent worker lost ownership: preserve pending write for the next owner, never assert a business failure.
    if (args.signal?.aborted) throw fault("EXECUTION_STOPPED", "父作业停止，保留检查点等待恢复");
    return await finish("FAILED", "blocked", `${(error as { code?: string }).code ?? "EXECUTION_ERROR"}：${(error as Error).message}`);
  } finally {
    clearInterval(heartbeat); clearTimeout(timeout);
    await prisma.v2ExecutionSession.updateMany({ where: { id: sessionId, leaseToken }, data: { leaseToken: null, leaseExpiresAt: null } });
  }
}
