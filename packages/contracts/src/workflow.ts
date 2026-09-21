import { z } from 'zod';
import { EntityId, IsoDateTime } from './common.js';

/**
 * P0-3 持久化任务编排契约。
 */

export const WorkflowRunStatus = z.enum([
  'QUEUED',
  'RUNNING',
  'WAITING_HUMAN',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

export const WorkflowNodeStatus = z.enum([
  'queued',
  'running',
  'waiting_human',
  'completed',
  'failed',
  'skipped',
]);

/** 首版模板节点 key（显式图，按序执行）。 */
export const WORKFLOW_TEMPLATE_V1_NODES = [
  'document_parse',
  'rule_suggest',
  'rule_approval_gate',
  'case_suggest',
  'case_approval_gate',
  'page_observation',
  'plan_proposal_gate',
  'preparation_check',
  'execution',
  'evaluation',
] as const;

export type WorkflowTemplateNode = (typeof WORKFLOW_TEMPLATE_V1_NODES)[number];

export const WorkflowBudget = z.object({
  maxWallClockMs: z.number().int().min(60_000).max(86_400_000).default(3_600_000),
  maxModelCalls: z.number().int().min(1).max(500).default(50),
  maxToolCalls: z.number().int().min(1).max(10000).default(200),
  maxTokens: z.number().int().min(1000).max(20_000_000).default(2_000_000),
});

export const WorkflowRunRequest = z.object({
  idempotencyKey: z.string().min(1).max(120),
  missionId: EntityId.optional(),
  templateVersion: z.literal('v1'),
  inputs: z.object({
    documentVersionIds: z.array(EntityId).max(20).default([]),
    baselineId: EntityId.optional(),
    environmentId: EntityId,
    buildId: z.string().min(1).max(200).optional(),
    observationPages: z.array(z.object({role:z.string().min(1).max(80),path:z.string().regex(/^\/(?!\/)[^\\\r\n]*$/)}).strict()).max(20).optional(),
    goal: z.string().max(4000).optional(),
  }).strict(),
  budget: WorkflowBudget.default({}),
}).strict();

/** 节点状态（对外 API）。 */
export const WorkflowNodeView = z.object({
  id: EntityId,
  nodeKey: z.string(),
  seq: z.number().int(),
  status: WorkflowNodeStatus,
  humanTodo: z.unknown().nullable(),
  error: z.string().nullable(),
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
});

export const WorkflowRunView = z.object({
  id: EntityId,
  status: WorkflowRunStatus,
  templateVersion: z.string(),
  currentGate: z.string().nullable(),
  budget: WorkflowBudget,
  nodes: z.array(WorkflowNodeView),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

/** 人工待办。 */
export const HumanTodo = z.object({
  nodeId: EntityId,
  nodeKey: z.string(),
  description: z.string().min(1).max(2000),
  /** 可选的操作引用（如批准路由）。 */
  actionRef: z.string().optional(),
  createdAt: IsoDateTime,
});

/** 工作流事件（SSE 按游标恢复）。 */
export const WorkflowEventType = z.enum([
  'workflow.created',
  'workflow.node_started',
  'workflow.node_completed',
  'workflow.node_failed',
  'workflow.waiting_human',
  'workflow.resumed',
  'workflow.cancelled',
  'workflow.completed',
  'workflow.failed',
]);
