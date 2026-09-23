import { z } from "zod";
import { EntityId, IsoDateTime } from "../common.js";

/**
 * v2 执行会话与调用账本（LOOP-02/05/06、OPS-01）。
 *
 * ExecutionSession：一次自主测试目标的持久化循环宿主（v2 权威；
 * v1 WorkflowRun 语义不变，二者只按 id 关联不双写状态）。
 * StepAttempt / Invocation：intent→执行→回执→提交 的账本；fencing token
 * 保证过期 worker 不能提交；UNKNOWN 是一等状态，不是错误。
 * 预算：恢复不重置已用量；费用未知是 null，不是 0。
 */

export const ExecutionSessionStatus = z.enum([
  "QUEUED", "PREPARING", "RUNNING",
  "WAITING_HUMAN", "WAITING_AUTH", "PAUSED",
  "COMPLETED", "FAILED", "CANCELLED",
]);

/** 合法状态迁移（闭环校验用；无效迁移必须拒绝）。 */
export const EXECUTION_SESSION_TRANSITIONS: Record<string, string[]> = {
  QUEUED: ["PREPARING", "RUNNING", "CANCELLED", "FAILED"],
  PREPARING: ["RUNNING", "FAILED", "CANCELLED"],
  RUNNING: ["WAITING_HUMAN", "WAITING_AUTH", "PAUSED", "COMPLETED", "FAILED", "CANCELLED"],
  WAITING_HUMAN: ["RUNNING", "PAUSED", "CANCELLED", "FAILED"],
  WAITING_AUTH: ["RUNNING", "CANCELLED", "FAILED"],
  PAUSED: ["RUNNING", "CANCELLED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export const SessionBudget = z.object({
  maxWallClockMs: z.number().int().min(60_000).max(86_400_000),
  maxActiveMs: z.number().int().min(60_000).max(86_400_000),
  maxModelCalls: z.number().int().min(1).max(10_000),
  maxTokens: z.number().int().min(1000).max(100_000_000),
  maxToolCalls: z.number().int().min(1).max(100_000),
  maxResources: z.number().int().min(1).max(10_000),
  /** 预算上限（微元/千次调用等单位由部署方声明）；null = 价格未知。 */
  maxCostMicros: z.number().int().min(1).nullable(),
}).strict().superRefine((b, ctx) => {
  if (b.maxActiveMs > b.maxWallClockMs)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "maxActiveMs 不能超过 maxWallClockMs" });
});
export type SessionBudget = z.infer<typeof SessionBudget>;

/** 实际用量（只增不减；恢复不重置）。reserved 在 intent 登记时占用。 */
export const SessionUsage = z.object({
  wallClockMsUsed: z.number().int().min(0),
  activeMsUsed: z.number().int().min(0),
  modelCallsUsed: z.number().int().min(0),
  modelCallsReserved: z.number().int().min(0),
  tokensUsed: z.number().int().min(0),
  tokensReserved: z.number().int().min(0),
  toolCallsUsed: z.number().int().min(0),
  toolCallsReserved: z.number().int().min(0),
  resourcesCreated: z.number().int().min(0),
  /** 已知费用（未知为 null；超时请求费用按不确定记录，不归零）。 */
  costKnownMicros: z.number().int().min(0).nullable(),
}).strict();
export type SessionUsage = z.infer<typeof SessionUsage>;

export const ExecutionSession = z.object({
  id: EntityId,
  projectId: EntityId,
  /** v2 目标（自然语言）+ 固定 Oracle 引用（判定依据不可变）。 */
  goal: z.string().min(1).max(4000),
  oracleSpecId: EntityId,
  oracleHash: z.string().regex(/^[a-f0-9]{64}$/),
  /** 固定的 HarnessProfile 与组合图版本。 */
  profileId: EntityId,
  profileHash: z.string().regex(/^[a-f0-9]{64}$/),
  definitionId: EntityId,
  definitionVersion: z.number().int().min(1),
  /** v1 关联（只引用不双写）。 */
  workflowRunId: EntityId.nullable().default(null),
  environmentId: EntityId,
  buildId: z.string().min(1).max(200),
  status: ExecutionSessionStatus.default("QUEUED"),
  budget: SessionBudget,
  usage: SessionUsage,
  /** 终止原因（COMPLETED/FAILED/CANCELLED 必填）。 */
  terminationReason: z.string().max(2000).nullable().default(null),
  cancelRequestedAt: IsoDateTime.nullable().default(null),
  pauseRequestedAt: IsoDateTime.nullable().default(null),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).strict().superRefine((s, ctx) => {
  if (["COMPLETED", "FAILED", "CANCELLED"].includes(s.status) && !s.terminationReason)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["terminationReason"], message: "终态必须记录终止原因" });
});
export type ExecutionSession = z.infer<typeof ExecutionSession>;

export function sessionCanTransition(from: string, to: string): boolean {
  return (EXECUTION_SESSION_TRANSITIONS[from] ?? []).includes(to);
}

// ---------- 循环节拍（Observe→Plan→Act→Verify→Adapt 的持久化记录） ----------

export const LoopPhase = z.enum(["observe", "plan", "act", "verify", "adapt"]);

export const StepAttempt = z.object({
  id: EntityId,
  sessionId: EntityId,
  /** 循环轮次 + 阶段（一轮内 phase 有序）。 */
  round: z.number().int().min(1),
  phase: LoopPhase,
  status: z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "SKIPPED"]).default("PENDING"),
  /** 观察/决策理由摘要（可审计；不要求私有思维链）。 */
  rationale: z.string().max(4000).nullable().default(null),
  /** 本阶段输入输出引用（Observation/Invocation id）。 */
  inputRefs: z.array(EntityId).max(100).default([]),
  outputRefs: z.array(EntityId).max(100).default([]),
  /** 是否取得进展（防空转判定依据）。 */
  progressMarked: z.boolean().nullable().default(null),
  createdAt: IsoDateTime,
}).strict();
export type StepAttempt = z.infer<typeof StepAttempt>;

// ---------- Invocation / Intent / Receipt ----------

export const InvocationStatus = z.enum(["PENDING", "CLAIMED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "UNKNOWN"]);

export const INVOCATION_TRANSITIONS: Record<string, string[]> = {
  PENDING: ["CLAIMED", "CANCELLED"],
  CLAIMED: ["RUNNING", "CANCELLED", "FAILED"],
  RUNNING: ["SUCCEEDED", "FAILED", "CANCELLED", "UNKNOWN"],
  SUCCEEDED: [],
  FAILED: ["PENDING"], // 显式重试（新 attempt 语义，不擦首败）
  CANCELLED: [],
  UNKNOWN: ["PENDING"], // reconcile 后允许受控重查（先核对再决定）
};

export const ActionIntent = z.object({
  id: EntityId,
  sessionId: EntityId,
  stepAttemptId: EntityId,
  capabilityId: z.string(),
  capabilityVersion: z.string(),
  /** 输入内容哈希（明文不入账本；按需引用 Artifact）。 */
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().min(8).max(200),
  /** 租约 fencing token：提交必须携带且匹配当前值。 */
  fencingToken: z.string().min(1).max(128),
  deadline: IsoDateTime,
  createdAt: IsoDateTime,
}).strict();
export type ActionIntent = z.infer<typeof ActionIntent>;

export const EffectReceipt = z.object({
  intentId: EntityId,
  /** 技术结果（SUCCEEDED 的工具可承载业务 FAIL）。 */
  outcome: z.enum(["succeeded", "failed", "unknown_write", "cancelled"]),
  /** 外部资源台账键（创建/修改的资源；核对与清理依据）。 */
  resourceKeys: z.array(z.string().min(1).max(300)).max(100).default([]),
  externalRefs: z.array(z.string().min(1).max(500)).max(100).default([]),
  /** 输出 Schema 校验结果与内容哈希。 */
  outputHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  recordedAt: IsoDateTime,
}).strict();
export type EffectReceipt = z.infer<typeof EffectReceipt>;

export const Invocation = z.object({
  id: EntityId,
  intentId: EntityId,
  attemptNo: z.number().int().min(1).max(10),
  status: InvocationStatus.default("PENDING"),
  /** 业务判定候选（工具技术成功也可能业务 FAIL）。 */
  businessOutcome: z.enum(["pass", "fail", "blocked", "review", "not_evaluated", "unknown"]).nullable().default(null),
  receipt: EffectReceipt.nullable().default(null),
  error: z.object({ code: z.string().max(100), message: z.string().max(2000) }).nullable().default(null),
  startedAt: IsoDateTime.nullable().default(null),
  finishedAt: IsoDateTime.nullable().default(null),
}).strict();
export type Invocation = z.infer<typeof Invocation>;

export function invocationCanTransition(from: string, to: string): boolean {
  return (INVOCATION_TRANSITIONS[from] ?? []).includes(to);
}

// ---------- Observation ----------

export const ObservationSnapshot = z.object({
  id: EntityId,
  sessionId: EntityId,
  round: z.number().int().min(1),
  /** 观察来源：页面（URL+截图+DOM 摘要）/ API 响应 / 工具输出。 */
  source: z.enum(["page", "api", "tool", "model"]),
  observedUrl: z.string().url().nullable().default(null),
  /** 截图/DOM/响应证据 Artifact 引用（归属本项目+本次会话）。 */
  evidenceArtifactIds: z.array(EntityId).max(200).default([]),
  /** 结构化摘要（元素引用版本化：绑定页面/角色/frame/时间）。 */
  summary: z.record(z.string(), z.unknown()),
  observedAt: IsoDateTime,
}).strict();
export type ObservationSnapshot = z.infer<typeof ObservationSnapshot>;
