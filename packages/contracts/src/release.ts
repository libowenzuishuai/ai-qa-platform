import { z } from 'zod';
import { EntityId, IsoDateTime } from './common.js';

/**
 * R00：发布决策 + 目标规划契约。
 */

// ---------- 发布决策（PRD FR-RESULT-02） ----------

export const ReleaseDecisionKind = z.enum(['ACCEPT', 'REJECT', 'ACCEPT_WITH_RISK']);

export const ReleaseDecision = z.object({
  id: EntityId,
  projectId: EntityId,
  /** 决策关联的 Run（可选多个）。 */
  runIds: z.array(EntityId).min(1),
  decision: ReleaseDecisionKind,
  /** 决策人。 */
  decidedBy: z.string(),
  reason: z.string().min(1).max(4000),
  /** 决策范围说明。 */
  scope: z.string().max(2000).optional(),
  /** 决策时引用的证据快照（不影响原始证据）。 */
  evidenceSnapshot: z.record(z.string(), z.unknown()).default({}),
  decidedAt: IsoDateTime,
}).strict().superRefine((d, ctx) => {
  if (d.decision === 'ACCEPT_WITH_RISK' && !d.reason.includes('风险')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reason'],
      message: '接受风险的决策必须说明风险内容',
    });
  }
});

// ---------- 目标规划（PRD FR-AGENT-02） ----------

export const GoalProposalStatus = z.enum(['DRAFT', 'APPROVED', 'REJECTED', 'EXECUTED']);

export const GoalProposal = z.object({
  id: EntityId,
  projectId: EntityId,
  /** 用户描述的验收目标。 */
  goal: z.string().min(1).max(4000),
  /** 模型建议的可用工具列表。 */
  suggestedTools: z.array(
    z.object({
      capabilityKey: z.string(),
      reason: z.string().max(1000),
    }),
  ),
  /** 建议的范围。 */
  suggestedScope: z
    .object({
      documentVersionIds: z.array(EntityId).default([]),
      baselineId: EntityId.optional(),
      environmentId: EntityId.optional(),
    })
    .default({}),
  /** 建议的预算。 */
  suggestedBudget: z
    .object({
      maxWallClockMs: z.number().int().min(60_000).optional(),
      maxModelCalls: z.number().int().min(1).optional(),
      maxToolCalls: z.number().int().min(1).optional(),
    })
    .default({}),
  /** 阻塞条件（缺资料/账号/定位等）。 */
  blockers: z.array(
    z.object({
      kind: z.enum(['MISSING_DATA', 'MISSING_ACCOUNT', 'MISSING_ENV', 'MISSING_SCOPE', 'INSUFFICIENT_INFO']),
      description: z.string().min(1).max(2000),
    }),
  ).default([]),
  status: GoalProposalStatus.default('DRAFT'),
  createdBy: z.string(),
  createdAt: IsoDateTime,
  reviewedBy: z.string().nullable().default(null),
  reviewedAt: IsoDateTime.nullable().default(null),
}).strict();

// ---------- 项目记忆（PRD FR-AGENT-02） ----------

export const MemoryRecord = z.object({
  id: EntityId,
  projectId: EntityId,
  /** 记忆内容。 */
  content: z.string().min(1).max(10_000),
  /** 记忆来源。 */
  source: z.object({
    kind: z.enum(['observation', 'execution', 'diagnosis', 'manual']),
    /** 引用的 Run/Job/Artifact。 */
    referenceId: z.string().optional(),
    sourceSpanId: z.string().optional(),
  }),
  /** 版本信息（来源资料版本、环境版本）。 */
  context: z.object({
    documentVersionId: EntityId.optional(),
    environmentRevision: z.number().int().optional(),
    buildId: z.string().optional(),
  }).default({}),
  /** 有效期与失效条件。 */
  validUntil: IsoDateTime.nullable().default(null),
  invalidationTriggers: z.array(
    z.object({
      kind: z.enum(['document_change', 'environment_change', 'build_change', 'manual']),
      condition: z.string(),
    }),
  ).default([]),
  /** 是否已失效。 */
  invalidated: z.boolean().default(false),
  invalidatedReason: z.string().max(1000).optional(),
  createdAt: IsoDateTime,
}).strict();

// ---------- 诊断（PRD FR-AGENT-02） ----------

export const DiagnosisCategory = z.enum([
  'PRODUCT_FAILURE',   // 业务失败
  'ACCOUNT',           // 账号问题
  'ENVIRONMENT',       // 环境问题
  'MODEL',             // 模型输出问题
  'SCRIPT',            // 脚本/定位问题
  'EVIDENCE_GAP',      // 证据缺口
]);

export const DiagnosisEntry = z.object({
  id: EntityId,
  projectId: EntityId,
  runId: EntityId.optional(),
  attemptId: EntityId.optional(),
  category: DiagnosisCategory,
  /** 事实（有证据支撑）。 */
  facts: z.array(z.object({ text: z.string(), evidenceId: EntityId.optional() })),
  /** 推测（需标注依据）。 */
  hypotheses: z.array(z.object({ text: z.string(), basis: z.string() })).default([]),
  /** 建议下一步（不执行，仅供参考）。 */
  suggestions: z.array(z.object({ text: z.string(), riskNote: z.string().optional() })).default([]),
  confidence: z.enum(['high', 'medium', 'low']),
  createdBy: z.string(),
  createdAt: IsoDateTime,
}).strict();

/** Explicit opt-in. Only terminal-run artifacts are eligible; requirement/observation sources are retained. */
export const EvidenceRetentionPolicy = z.object({
  enabled: z.boolean().default(false),
  normalDays: z.number().int().min(1).max(3650).default(90),
  restrictedDays: z.number().int().min(1).max(3650).default(30),
}).strict();
