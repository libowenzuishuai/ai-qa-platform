
import { randomUUID, createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { OracleSpec, type OracleAssertion } from "@ai-qa/contracts";
import { invokeCapability } from "./capability-invoker.js";

/**
 * W04 持久化自主循环（Alpha 核心）：Observe→Plan→Act→Verify→Adapt。
 *
 * - 规划器：本切片为确定性脚本规划器（显式标注 script——不冒充真实模型效果）；
 *   真实模型规划走 Python 通道是 W04 后续切片（A2-04 已定接线方式）。
 * - 每轮持久化：观察（V2Observation）→ 计划（V2StepAttempt plan）→
 *   intent 先行登记（V2ActionIntent + fencingToken）→ 执行（V2Invocation+receipt）→
 *   验证（V2StepAttempt verify）→ 有界调整。
 * - 恢复：重入时先对账——发现"有 intent 无 invocation"的逻辑写入按同一幂等键
 *   重放（服务端幂等返回既有资源，不重复创建），再继续。
 * - 操作层自适应（ROUTE_MOVED→重新观察 meta→新入口）不改 oracleHash；
 *   业务失败不自修复（缺陷构建必须 FAIL）。
 * - 出口：目标达成 / 业务 FAIL / 三次等价无进展 / 预算（轮次上限）。
 */

export interface SessionLoopInput {
  prisma: PrismaClient;
  sessionId: string;
  /** 合成系统 baseUrl（操作层输入）。 */
  baseUrl: string;
  /** 规划器：script（确定性内核验证）| python-real（模型通道，服务端校验护栏）。 */
  planner: "script" | "python-real";
  /** python-real 所需的智能服务连接（script 忽略）。 */
  intelligence?: { url: string; token: string };
  /** 有界轮次上限（防无进展空转）。 */
  maxRounds?: number;
  /** 进程内 kill 钩子（真实 kill 测试由子进程 SIGKILL 完成，不经过本参数）。 */
  killAt?: "after_write_before_receipt";
  killMarkerFile?: string;
}

export interface SessionLoopResult {
  status: "COMPLETED" | "FAILED" | "NO_PROGRESS" | "CANCELLED";
  rounds: number;
  verdict: "pass" | "fail" | "no_progress";
  finalTitle: string | null;
  draftId: string | null;
  reason: string;
}

interface ObservedState {
  renamePath: string;
  draft: { id: string; title: string } | null;
}

export async function runDraftSessionLoop(args: SessionLoopInput): Promise<SessionLoopResult> {
  const { prisma, sessionId } = args;
  const session = await prisma.v2ExecutionSession.findUniqueOrThrow({ where: { id: sessionId } });
  if (args.planner === "python-real" && (!args.intelligence?.url || !args.intelligence?.token))
    throw Object.assign(new Error("python-real 规划器需要智能服务地址与令牌"), { code: "CONFIG_MISSING" });

  const oracleRow = await prisma.v2OracleSpec.findUniqueOrThrow({ where: { id: session.oracleSpecId } });
  const oracle = OracleSpec.safeParse({
    id: oracleRow.id, projectId: oracleRow.projectId, version: oracleRow.version, status: oracleRow.status as "APPROVED",
    ruleVersionIds: oracleRow.ruleVersionIds, assertions: oracleRow.assertions,
    semanticCandidates: oracleRow.semanticCandidates, coverageDeclarations: oracleRow.coverageDeclarations,
    oracleHash: oracleRow.oracleHash, supersedesId: oracleRow.supersedesId,
    createdBy: oracleRow.createdBy, createdAt: oracleRow.createdAt.toISOString(),
    approvedBy: oracleRow.approvedBy, approvedAt: oracleRow.approvedAt?.toISOString() ?? null,
  });
  if (!oracle.success)
    throw Object.assign(new Error("Oracle 读取不符合契约（拒绝执行）"), { code: "CONFLICT" });
  const assertion = oracle.data.assertions.find((a) => a.observationType === "api_field" && a.observationRef === "draft.title");
  if (!assertion)
    throw Object.assign(new Error("Oracle 缺 draft.title 断言（合成循环要求该映射）"), { code: "VALIDATION_ERROR" });
  const targetTitle = String(assertion.expected);

  const maxRounds = args.maxRounds ?? 10;
  const executionKey = `session-${sessionId}`;
  let lastEquivalent = "";
  let equivalentCount = 0;

  // —— 恢复对账：有 intent 无 invocation 的逻辑写入按同幂等键重放。 ——
  const receiptIntentIds = (await prisma.v2Invocation.findMany({ where: {}, select: { intentId: true } })).map((i) => i.intentId);
  const pendingIntents = receiptIntentIds.length
    ? await prisma.v2ActionIntent.findMany({
        where: { sessionId, id: { notIn: receiptIntentIds } },
        orderBy: { createdAt: "asc" },
      })
    : await prisma.v2ActionIntent.findMany({ where: { sessionId }, orderBy: { createdAt: "asc" } });

  let draftId: string | null = null;
  let observed: ObservedState | null = null;

  for (let round = 1; round <= maxRounds; round += 1) {
    // ===== 1) Observe：真实系统状态（meta 路由 + 现有草稿）=====
    const metaResult = await dispatch(prisma, session, args, {
      op: "meta", baseUrl: args.baseUrl,
    }, `round-${round}-observe`, "observe");
    if (!isSuccess(metaResult)) return await terminal(prisma, sessionId, "FAILED", round, "fail", draftId, `观察失败：${metaResult.error?.message}`);
    const meta = (metaResult.output as { meta?: { routes?: { renameDraft?: string } } }).meta;
    const renamePath = meta?.routes?.renameDraft ?? "/api/drafts/:id/rename";
    await prisma.v2Observation.create({
      data: {
        sessionId, round, source: "tool", observedUrl: args.baseUrl,
        evidenceArtifactIds: [], summary: { renamePath, pendingIntents: pendingIntents.length } as never,
      },
    });

    // ===== 2) Plan（script=确定性状态机；python-real=模型提议+护栏）=====
    // 恢复优先：先补未回执的逻辑写入（幂等键不变 → 服务端返回既有资源）。
    let planned: { op: "create" | "rename" | "get"; rationale: string };
    let realPlannerActive = false;
    if (args.planner === "python-real" && pendingIntents.length === 0) {
      realPlannerActive = true;
      const oracleAssertion = assertion as unknown as Record<string, unknown>;
      const planResult = await callRealPlanner(args, {
        goal: session.goal,
        oracleAssertions: [{
          observationType: oracleAssertion.observationType,
          observationRef: oracleAssertion.observationRef,
          operator: oracleAssertion.operator,
          expected: oracleAssertion.expected,
        }],
        observation: { renamePath, draft: observed?.draft ?? null },
        contextManifestId: null,
        contextExcerpt: [],
        promptVersion: "loop-planner-v1",
      });
      if (planResult.action === "blocked")
        return terminal(prisma, sessionId, "FAILED", round, "fail", draftId, `规划器阻塞：${planResult.rationale}`);
      if (planResult.action === "create_draft" || !draftId) {
        planned = { op: "create", rationale: planResult.rationale };
      } else if (planResult.action === "rename_draft") {
        // 护栏：模型提议的 title 必须等于标准 expected（不得改标准）。
        if (planResult.params?.title !== undefined && planResult.params.title !== String(assertion.expected))
          throw Object.assign(new Error(`规划器提议的 title 与标准不符：拒绝`), { code: "MODEL_OUTPUT_INVALID" });
        planned = { op: "rename", rationale: planResult.rationale };
      } else {
        // done/observe_only/get_draft：读回核验（目标是否达成由 verifier 判定，不信模型）。
        planned = { op: "get", rationale: planResult.rationale };
      }
    } else
    if (pendingIntents.length > 0) {
      // 逻辑写入类型从幂等键后缀恢复（键=executionKey:op——R0.4 身份分离约定）。
      const recoverOp = pendingIntents[0]!.idempotencyKey.endsWith(":create") ? "create"
        : pendingIntents[0]!.idempotencyKey.endsWith(":rename") ? "rename" : null;
      if (recoverOp === "create" || recoverOp === "rename")
        planned = { op: recoverOp, rationale: "恢复对账：按原幂等键重放未回执写入" };
      else {
        // 未知逻辑写入类型：无法安全重放（不盲目重做）——暂停人工核对。
        return await terminal(prisma, sessionId, "FAILED", round, "fail", draftId, `存在无法识别的未回执写入（幂等键 ${pendingIntents[0]!.idempotencyKey}）：转人工核对`);
      }
    } else if (!draftId) {
      planned = { op: "create", rationale: "无草稿：创建（幂等键=会话键）" };
    } else {
      const current = await fetchDraft(prisma, session, args, draftId, round);
      if (!current) return await terminal(prisma, sessionId, "FAILED", round, "fail", draftId, `草稿 ${draftId} 不可读`);
      observed = { renamePath, draft: current };
      if (current.title === targetTitle) {
        planned = { op: "get", rationale: "已改名：重新读取核验持久化" };
      } else {
        planned = { op: "rename", rationale: `草稿标题为「${current.title}」≠ 目标「${targetTitle}」：改名（入口来自观察）` };
        // 无进展检测前移：改名已执行过而标题未变 = 等价轮（缺陷构建三次即停）。
        const equivalent = `stuck:${current.title}`;
        if (equivalent === lastEquivalent) equivalentCount += 1;
        else { lastEquivalent = equivalent; equivalentCount = 1; }
        if (equivalentCount >= 3)
          return await terminal(prisma, sessionId, "FAILED", round, "fail", draftId, current.title, "三次等价无进展：改名已执行而标题未变（业务失败，不自修复）");
      }
    }
    await persistAttempt(prisma, sessionId, round, "plan", planned.rationale);

    // ===== 3) Act：intent 先行 → 执行 → receipt（kill 点在写入后回执前）=====
    if (planned.op === "rename" && !draftId) {
      // 恢复 rename 前缺 draftId：按 create 幂等键重放拿回资源标识（不新建）。
      const recover = await dispatch(prisma, session, args, { op: "create", baseUrl: args.baseUrl, title: "初始草稿" }, `round-${round}-recover`, "act", `${executionKey}:create`);
      if (isSuccess(recover)) {
        const draft = (recover.output as { draft?: { id: string } }).draft;
        if (draft) draftId = draft.id;
      }
    }
    const input: Record<string, unknown> =
      planned.op === "create"
        ? { op: "create", baseUrl: args.baseUrl, title: "初始草稿" }
        : planned.op === "rename"
          ? { op: "rename", baseUrl: args.baseUrl, draftId: draftId!, title: targetTitle, renamePath }
          : { op: "get", baseUrl: args.baseUrl, draftId: draftId! };
    const logicalKey = pendingIntents.shift()?.idempotencyKey ?? `${executionKey}:${planned.op}`;
    // 同一逻辑写入复用同一 intent（业务幂等键不变；重试挂新 attempt 到同 intent）。
    const inputHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const intent = await prisma.v2ActionIntent.upsert({
      where: { sessionId_idempotencyKey: { sessionId, idempotencyKey: logicalKey } },
      create: {
        sessionId,
        stepAttemptId: `round-${round}-plan`,
        capabilityId: "synthetic.draft-ops",
        capabilityVersion: "1.0.0",
        inputHash,
        idempotencyKey: logicalKey,
        fencingToken: randomUUID(),
        deadline: new Date(Date.now() + 30_000),
      },
      update: { inputHash, deadline: new Date(Date.now() + 30_000) },
    });
    const actResult = await dispatch(prisma, session, args, input, `round-${round}-act`, "act", logicalKey);
    // kill 点：写已发生（dispatch 已完成）、回执未持久化——真实 kill 由外部 SIGKILL；
    // 进程内钩子仅写标记后挂起，供集成测试观察。
    if (args.killAt === "after_write_before_receipt" && args.killMarkerFile) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(args.killMarkerFile, String(Date.now()));
      await new Promise(() => {}); // 挂起等 SIGKILL（真实进程终止）
    }
    const priorAttempts = await prisma.v2Invocation.count({ where: { intentId: intent.id } });
    await prisma.v2Invocation.create({
      data: {
        intentId: intent.id, attemptNo: priorAttempts + 1,
        status: actResult.status === "SUCCEEDED" ? "SUCCEEDED" : actResult.status === "UNKNOWN" ? "UNKNOWN" : "FAILED",
        receipt: {
          intentId: intent.id,
          outcome: actResult.status === "SUCCEEDED" ? "succeeded" : actResult.status === "UNKNOWN" ? "unknown_write" : "failed",
          resourceKeys: draftId ? [`draft:${draftId}`] : [],
          externalRefs: [], outputHash: null, recordedAt: new Date().toISOString(),
        } as never,
        error: (actResult.error ?? null) as never,
        startedAt: new Date(), finishedAt: new Date(),
      },
    });

    if (!isSuccess(actResult)) {
      // ===== 5) Adapt：操作层失败（定位变化）重新观察；未知写入先对账 =====
      if (actResult.error?.code === "ROUTE_MOVED") {
        await persistAttempt(prisma, sessionId, round, "adapt", "改名入口 404：定位已变化，重新观察 meta 后选新入口（不改标准）");
        continue;
      }
      if (actResult.status === "UNKNOWN") {
        await persistAttempt(prisma, sessionId, round, "adapt", "写入效果未知：按幂等键重放对账（不重复创建）");
        // 用同幂等键重放 create（服务端幂等返回既有资源）。
        const reconcile = await dispatch(prisma, session, args, { op: "create", baseUrl: args.baseUrl, title: "初始草稿" }, `round-${round}-reconcile`, "act", logicalKey);
        if (isSuccess(reconcile)) {
          const draft = (reconcile.output as { draft?: { id: string; title: string } }).draft;
          if (draft) draftId = draft.id;
        }
        continue;
      }
      return await terminal(prisma, sessionId, "FAILED", round, "fail", draftId, `动作失败：${actResult.error?.code} ${actResult.error?.message}`);
    }

    const out = actResult.output as { kind: string; draft?: { id: string; title: string } | null };
    if (planned.op === "create") {
      if (out.draft) draftId = out.draft.id;
      await persistAttempt(prisma, sessionId, round, "act", `草稿 ${draftId}（${out.kind}）`);
      continue;
    }
    if (planned.op === "rename") {
      await persistAttempt(prisma, sessionId, round, "act", `改名请求完成（入口 ${renamePath}）`);
      continue;
    }

    // ===== 4) Verify：独立标准判定（刷新读取，不信任动作回执）=====
    const fresh = observed?.draft?.id === draftId && observed.draft
      ? observed.draft
      : await fetchDraft(prisma, session, args, draftId!, round);
    if (!fresh) return await terminal(prisma, sessionId, "FAILED", round, "fail", draftId, "验证读取失败");
    await prisma.v2Observation.create({
      data: { sessionId, round, source: "tool", observedUrl: args.baseUrl, evidenceArtifactIds: [], summary: { draft: fresh } as never },
    });
    const verdict = evaluateAssertion(assertion, fresh.title);
    await persistAttempt(prisma, sessionId, round, "verify", `实际「${fresh.title}」 vs 期望「${targetTitle}」→ ${verdict}`);

    if (verdict === "pass")
      return await terminal(prisma, sessionId, "COMPLETED", round, "pass", draftId, fresh.title, "目标达成（标准判定通过）");

    // 业务 FAIL：不自修复（缺陷构建必须 FAIL），但有界无进展检测防死循环。
    const equivalent = `fail:${fresh.title}`;
    if (equivalent === lastEquivalent) equivalentCount += 1;
    else { lastEquivalent = equivalent; equivalentCount = 1; }
    if (equivalentCount >= 3)
      return await terminal(prisma, sessionId, "FAILED", round, "fail", draftId, fresh.title, "三次等价无进展：业务失败（标准未达成，不自修复）");
    // 重新改名一次（有界：无进展计数到 3 即停）。
  }
  return await terminal(prisma, sessionId, "FAILED", maxRounds, "no_progress", draftId, null, "轮次上限耗尽（有界停止）");
}

// ---------- helpers ----------

/** python-real 规划调用：真实 HTTP 到智能服务；输出过契约+护栏。 */
async function callRealPlanner(
  args: SessionLoopInput,
  input: Record<string, unknown>,
): Promise<{ action: string; rationale: string; params?: { title?: string; renamePath?: string } }> {
  const { LoopPlannerRequest, LoopPlannerResponse } = await import("@ai-qa/contracts");
  const request = LoopPlannerRequest.parse({
    schemaVersion: "1.0",
    requestId: `loop-plan-${Date.now().toString(36)}`,
    mode: "real",
    timeoutMs: 120000,
    input,
  });
  const response = await fetch(new URL("/v2/loop/plan", args.intelligence!.url), {
    method: "POST", redirect: "error",
    headers: { "content-type": "application/json", authorization: `Bearer ${args.intelligence!.token}` },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw Object.assign(new Error(`规划服务失败：${(body as { message?: string }).message ?? response.status}`), { code: "DEPENDENCY_UNAVAILABLE" });
  }
  const parsed = LoopPlannerResponse.safeParse(await response.json());
  if (!parsed.success)
    throw Object.assign(new Error("规划输出不符合契约"), { code: "MODEL_OUTPUT_INVALID" });
  return parsed.data.output as never;
}

function isSuccess(r: { status: string }) {
  return r.status === "SUCCEEDED";
}

async function loadOracleAssertions(prisma: PrismaClient, oracleSpecId: string): Promise<unknown[]> {
  const spec = await prisma.v2OracleSpec.findUniqueOrThrow({ where: { id: oracleSpecId } });
  return spec.assertions as unknown[];
}

async function fetchDraft(
  prisma: PrismaClient,
  session: { projectId: string; environmentId: string; buildId: string },
  args: SessionLoopInput,
  draftId: string,
  round: number,
): Promise<{ id: string; title: string } | null> {
  const r = await dispatch(prisma, session, args, { op: "get", baseUrl: args.baseUrl, draftId }, `round-${round}-read`, "verify");
  if (!isSuccess(r)) return null;
  return (r.output as { draft?: { id: string; title: string } | null }).draft ?? null;
}

async function dispatch(
  prisma: PrismaClient,
  session: { projectId: string; environmentId: string },
  args: SessionLoopInput,
  input: Record<string, unknown>,
  label: string,
  phase: string,
  idempotencyKey?: string,
) {
  await persistAttempt(prisma, args.sessionId, label, phase, `派发 ${input.op}`);
  return invokeCapability({
    prisma,
    projectId: session.projectId,
    capabilityId: "synthetic.draft-ops",
    capabilityVersion: "1.0.0",
    input,
    environmentId: session.environmentId,
    deadline: Date.now() + 20_000,
    idempotencyKey: idempotencyKey ?? `loop-${args.sessionId}-${label}-${randomUUID().slice(0, 8)}`,
    signal: new AbortController().signal,
    allowedOrigins: [new URL(args.baseUrl).origin],
    invocationId: `loop-${args.sessionId}-${label}`,
  });
}

async function persistAttempt(
  prisma: PrismaClient, sessionId: string, round: number | string, phase: string, rationale: string,
) {
  // round 参数可能为字符串标签——统一转稳定序号（同 phase 幂等 upsert）。
  const seq = typeof round === "number" ? round : Math.abs(hashOf(round) % 10000);
  await prisma.v2StepAttempt.upsert({
    where: { sessionId_round_phase: { sessionId, round: seq, phase } },
    create: { sessionId, round: seq, phase, status: "SUCCEEDED", rationale },
    update: { rationale },
  });
}

function evaluateAssertion(assertion: OracleAssertion, actual: string): "pass" | "fail" {
  switch (assertion.operator) {
    case "equals": return actual === String(assertion.expected) ? "pass" : "fail";
    case "not_equals": return actual !== String(assertion.expected) ? "pass" : "fail";
    case "greater_than": return Number(actual) > Number(assertion.expected) ? "pass" : "fail";
    case "less_than": return Number(actual) < Number(assertion.expected) ? "pass" : "fail";
    case "exists": return actual !== null && actual !== undefined ? "pass" : "fail";
    default: return "fail";
  }
}

function hashOf(value: unknown): number {
  const text = JSON.stringify(value) ?? "";
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return hash;
}

async function terminal(
  prisma: PrismaClient, sessionId: string,
  status: SessionLoopResult["status"], rounds: number, verdict: SessionLoopResult["verdict"],
  draftId: string | null, finalTitleOrReason: string | null, reasonText?: string,
): Promise<SessionLoopResult> {
  const termination = `${reasonText ?? finalTitleOrReason ?? ""}`;
  await prisma.v2ExecutionSession.updateMany({
    where: { id: sessionId, status: { notIn: ["COMPLETED", "FAILED", "CANCELLED"] } },
    data: { status: status === "COMPLETED" ? "COMPLETED" : "FAILED", terminationReason: termination },
  }).catch(() => undefined);
  return {
    status, rounds, verdict, draftId,
    finalTitle: verdict === "pass" || verdict === "fail" ? finalTitleOrReason : null,
    reason: termination,
  };
}




