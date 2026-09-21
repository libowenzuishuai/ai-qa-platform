import { z } from 'zod';
import { EntityId, IsoDateTime } from './common.js';

/**
 * R00：能力目录与组合模板契约（PRD FR-AGENT-01）。
 *
 * CapabilityVersion 描述一个可注册的原子能力（解析/提取/观察/执行等）。
 * WorkflowTemplateVersion 描述一个 DAG 组合模板。
 */

export const CapabilityEffect = z.enum(['READ', 'WRITE', 'CREATE', 'DELETE']);

/** 能力的恢复策略。 */
export const CapabilityRecovery = z.enum([
  'idempotent',        // 幂等，可直接重试
  'read_only',         // 只读，有界重试
  'write_uncertain',   // 写入结果不明，先 inspect 再决定
  'manual',            // 需人工介入
]);

export const CapabilityVersion = z.object({
  id: EntityId,
  key: z.string().regex(/^[a-z][a-z0-9-]*$/, '能力 key 使用小写 kebab-case'),
  version: z.number().int().min(1),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  /** JSON Schema 描述输入/输出。 */
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  effects: z.array(CapabilityEffect).min(1),
  /** 所需角色。 */
  requiredRoles: z.array(z.string()).default([]),
  /** 所需环境类型。 */
  requiresEnvironment: z.boolean().default(false),
  /** 预算类别。 */
  budgetCategory: z.enum(['none', 'model', 'browser', 'compute']).default('none'),
  /** 幂等策略。 */
  idempotencyStrategy: CapabilityRecovery,
  /** 恢复策略。 */
  recoveryStrategy: CapabilityRecovery,
  /** 清理责任（哪些资源由本能力负责清理）。 */
  cleanupResponsibility: z.string().max(1000).optional(),
  enabled: z.boolean().default(true),
  createdBy: z.string(),
  createdAt: IsoDateTime,
}).strict();

// ---------- DAG 模板 ----------

export const TemplateNodeDefinition = z.object({
  /** 节点 key（模板内唯一）。 */
  key: z.string().regex(/^[a-z][a-z0-9-]*$/),
  /** 引用的能力 key + 版本。 */
  capabilityKey: z.string().regex(/^[a-z][a-z0-9-]*$/),
  capabilityVersion: z.number().int().min(1),
  /** 依赖的前序节点 key 列表（DAG 边）。 */
  dependsOn: z.array(z.string()).default([]),
  /** 是否为人工审批门。 */
  isApprovalGate: z.boolean().default(false),
  /** 受限条件表达式（不 eval，仅支持简单比较）。 */
  condition: z
    .object({
      variable: z.string(),
      operator: z.enum(['eq', 'ne', 'gt', 'lt', 'exists', 'not_exists']),
      value: z.union([z.string(), z.number(), z.boolean()]),
    })
    .optional(),
  /** 输入映射（从前序节点输出/全局输入/常量映射到本节点输入）。 */
  inputMapping: z.record(z.string(), z.string()).default({}),
  /** 该节点的预算覆盖。 */
  budgetOverride: z
    .object({
      maxModelCalls: z.number().int().min(0).optional(),
      maxToolCalls: z.number().int().min(0).optional(),
      maxWallClockMs: z.number().int().min(0).optional(),
    })
    .optional(),
});

export const WorkflowTemplateVersion = z.object({
  id: EntityId,
  key: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: z.number().int().min(1),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  /** DAG 节点列表。 */
  nodes: z.array(TemplateNodeDefinition).min(1).max(64),
  /** 模板默认预算。 */
  defaultBudget: z.object({
    maxWallClockMs: z.number().int().min(60_000).default(3_600_000),
    maxModelCalls: z.number().int().min(1).default(50),
    maxToolCalls: z.number().int().min(1).default(200),
    maxTokens: z.number().int().min(1000).default(2_000_000),
  }),
  /** 默认并行上限（服务端硬限制为 2，可按项目配置但不超过此值）。 */
  defaultParallelism: z.number().int().min(1).max(2).default(1),
  status: z.enum(['DRAFT', 'PUBLISHED', 'DEPRECATED']).default('DRAFT'),
  createdBy: z.string(),
  createdAt: IsoDateTime,
  publishedAt: IsoDateTime.nullable().default(null),
}).strict().superRefine((t, ctx) => {
  // DAG 校验：无环。
  const nodeKeys = new Set(t.nodes.map(n => n.key));
  if (nodeKeys.size !== t.nodes.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nodes'], message: '节点 key 重复' });
  }
  for (const node of t.nodes) {
    for (const dep of node.dependsOn) {
      if (!nodeKeys.has(dep)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes'],
          message: `节点 ${node.key} 依赖不存在的 ${dep}`,
        });
      }
    }
  }
  // 检测环（拓扑排序）。
  const inDegree = new Map<string, number>();
  const edges = new Map<string, string[]>();
  for (const n of t.nodes) {
    inDegree.set(n.key, n.dependsOn.length);
    for (const dep of n.dependsOn) {
      if (!edges.has(dep)) edges.set(dep, []);
      edges.get(dep)!.push(n.key);
    }
  }
  const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([k]) => k);
  const visited: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    visited.push(current);
    for (const next of edges.get(current) ?? []) {
      const d = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (visited.length !== t.nodes.length) {
    const cycleNodes = t.nodes.filter(n => !visited.includes(n.key)).map(n => n.key);
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['nodes'],
      message: `检测到环：${cycleNodes.join(', ')}`,
    });
  }
});
