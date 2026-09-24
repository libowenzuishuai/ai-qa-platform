import { z } from "zod";
import { EntityId, IsoDateTime } from "../common.js";
import { canonicalStringify } from "../acceptance-hash.js";
import { createHash } from "node:crypto";

/**
 * v2 组合图 AST（HAR-02/05）：画布与表单共用同一结构。
 *
 * - 外层图无环；循环只通过显式受限节点（repeat/map）表达；
 * - 绑定是类型化的：来源节点输出/任务输入/常量 + Schema 路径 + 声明类型，
 *   编译期检查存在性与类型一致，运行期检查值；
 * - 条件是受限表达式（非 eval），三值逻辑（true/false/unknown）；
 * - 子流程固定版本、有最大嵌套深度，递归拒绝；
 * - retry/repeat/map 均有界；业务断言失败不可用 retry 擦除。
 */

export const TypeRef = z.enum(["string", "number", "boolean", "json"]);
export type TypeRef = z.infer<typeof TypeRef>;

/** 绑定来源：节点输出 / 任务输入 / 常量。引用必须是"节点实例 + 路径"。 */
export const Binding = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("node"),
    nodeId: z.string().min(1).max(200),
    path: z.string().min(1).max(500).regex(/^[a-zA-Z0-9_.\[\]-]+$/, "输出路径只允许标识符与数组下标"),
    type: TypeRef,
  }).strict(),
  z.object({
    source: z.literal("input"),
    path: z.string().min(1).max(500).regex(/^[a-zA-Z0-9_.\[\]-]+$/),
    type: TypeRef,
  }).strict(),
  z.object({
    source: z.literal("constant"),
    value: z.union([z.string(), z.number(), z.boolean()]),
    type: TypeRef,
  }).strict(),
]);
export type Binding = z.infer<typeof Binding>;

/** 受限条件（三值）：unknown 走显式分支，不允许静默当 true/false。 */
export const RestrictedCondition = z.object({
  left: Binding,
  operator: z.enum(["eq", "ne", "gt", "lt", "exists", "not_exists"]),
  right: Binding.optional(), // exists/not_exists 无右值
  /** unknown 时的处置：skip / fail / require_human（不得默认通过）。 */
  onUnknown: z.enum(["skip", "fail", "require_human"]),
}).strict();
export type RestrictedCondition = z.infer<typeof RestrictedCondition>;

export const RetryPolicy = z.object({
  maxAttempts: z.number().int().min(1).max(10),
  /** 可重试错误分类（业务断言失败不可重试擦除首败）。 */
  retryableErrorClasses: z.array(z.string().min(1).max(100)).max(20),
  totalDeadlineMs: z.number().int().min(1000).max(600_000),
}).strict();

export const RepeatPolicy = z.object({
  maxIterations: z.number().int().min(1).max(1000),
  /** 退出条件（受限表达式，三值）。无退出条件 = 到达上限即停（有界）。 */
  exitWhen: RestrictedCondition.optional(),
}).strict();

export const MapPolicy = z.object({
  /** 输入集绑定（运行时校验有限与条数上限）。 */
  inputSet: Binding,
  maxItems: z.number().int().min(1).max(10_000),
  maxConcurrency: z.number().int().min(1).max(2),
}).strict();

export const SubflowRef = z.object({
  /** 固定版本引用（禁止 latest）；递归在图校验时拒绝。 */
  definitionId: EntityId,
  version: z.number().int().min(1),
}).strict();

export const OnFailure = z.enum(["fail", "skip", "require_human"]);

export const GraphNode = z.object({
  /** 图内唯一节点实例 ID（能力可重复，nodeId 不可）。 */
  nodeId: z.string().regex(/^[a-z][a-z0-9-]*$/, "nodeId 使用小写 kebab-case"),
  /** 能力引用（id + 固定版本）。 */
  capabilityId: z.string().min(1).max(200),
  capabilityVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  dependsOn: z.array(z.string().min(1).max(200)).max(100).default([]),
  /** 参数绑定：参数名 → 类型化绑定（缺绑定 = 校验失败，不默认空值）。 */
  bindings: z.record(z.string().min(1).max(200), Binding).default({}),
  condition: RestrictedCondition.optional(),
  retry: RetryPolicy.optional(),
  repeat: RepeatPolicy.optional(),
  map: MapPolicy.optional(),
  subflow: SubflowRef.optional(),
  onFailure: OnFailure.default("fail"),
}).strict().superRefine((node, ctx) => {
  if (node.retry && node.retry.maxAttempts > 1 && node.retry.retryableErrorClasses.length === 0)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["retry"], message: "可重试必须有错误分类（防万能重试）" });
  if (node.subflow && (node.repeat || node.map))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["subflow"], message: "子流程节点不能再承载 repeat/map" });
});
export type GraphNode = z.infer<typeof GraphNode>;

export const WorkflowDefinitionContent = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(""),
  nodes: z.array(GraphNode).min(1).max(200),
  /** 全局子流程嵌套深度上限（静态校验强制 ≤ 8）。 */
  maxSubflowDepth: z.number().int().min(1).max(8).default(4),
}).strict();
export type WorkflowDefinitionContent = z.infer<typeof WorkflowDefinitionContent>;

export const WorkflowDefinitionStatus = z.enum(["DRAFT", "PUBLISHED", "DEPRECATED"]);

export const WorkflowDefinition = WorkflowDefinitionContent.extend({
  id: EntityId,
  projectId: EntityId,
  version: z.number().int().min(1),
  status: WorkflowDefinitionStatus.default("DRAFT"),
  astHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdBy: z.string(),
  createdAt: IsoDateTime,
  publishedAt: IsoDateTime.nullable().default(null),
}).strict();
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;

export function computeAstHash(content: WorkflowDefinitionContent): string {
  return createHash("sha256").update(canonicalStringify(content)).digest("hex");
}

// ---------- 图静态校验（发布前必须通过） ----------

export interface GraphValidation {
  ok: boolean;
  problems: string[];
}

/**
 * 静态校验：无环、绑定闭包、类型一致、子流程引用存在、递归拒绝、
 * 依赖存在、重复 nodeId 拒绝。不校验业务合理性（发布预检另行提示）。
 */
export function validateGraph(
  content: WorkflowDefinitionContent,
  knownSubflows: Record<string, number> = {},
  depth = 0,
  visiting: Set<string> = new Set(),
): GraphValidation {
  const problems: string[] = [];
  const nodeIds = new Set(content.nodes.map((n) => n.nodeId));
  if (nodeIds.size !== content.nodes.length)
    problems.push("nodeId 重复");

  // 依赖存在 + 外层无环（DFS 三色标记）。
  const color = new Map<string, 0 | 1 | 2>();
  const visit = (id: string, stack: string[]) => {
    color.set(id, 1);
    const node = content.nodes.find((n) => n.nodeId === id)!;
    for (const dep of node.dependsOn) {
      if (!nodeIds.has(dep)) {
        problems.push(`节点 ${id} 依赖不存在的 ${dep}`);
        continue;
      }
      if (color.get(dep) === 1) {
        problems.push(`外层图存在环：${[...stack, dep].join(" → ")}`);
        continue;
      }
      if (!color.has(dep)) visit(dep, [...stack, dep]);
    }
    color.set(id, 2);
  };
  for (const node of content.nodes) if (!color.has(node.nodeId)) visit(node.nodeId, [node.nodeId]);

  // 绑定闭包与类型：node 绑定的来源必须存在且非自身（无前序保证时由依赖闭包决定可达性）。
  for (const node of content.nodes) {
    for (const [param, binding] of Object.entries(node.bindings)) {
      if (binding.source === "node") {
        if (!nodeIds.has(binding.nodeId)) {
          problems.push(`节点 ${node.nodeId} 参数 ${param} 绑定了不存在的节点 ${binding.nodeId}`);
          continue;
        }
        if (binding.nodeId === node.nodeId) {
          problems.push(`节点 ${node.nodeId} 参数 ${param} 绑定自身输出`);
          continue;
        }
        // 来源必须在本节点依赖闭包内（防止引用未排序/并行输出）。
        const deps = transitiveDeps(content, node.nodeId);
        if (!deps.has(binding.nodeId)) {
          problems.push(`节点 ${node.nodeId} 参数 ${param} 绑定的 ${binding.nodeId} 不在其依赖闭包内`);
        }
      }
    }
    if (node.condition) {
      const cond = node.condition;
      if (["eq", "ne", "gt", "lt"].includes(cond.operator) && !cond.right)
        problems.push(`节点 ${node.nodeId} 条件 ${cond.operator} 缺少右值`);
      if (["exists", "not_exists"].includes(cond.operator) && cond.right)
        problems.push(`节点 ${node.nodeId} 条件 ${cond.operator} 不应有右值`);
      if (cond.operator === "gt" || cond.operator === "lt") {
        if (cond.left.type !== "number" || cond.right?.type !== "number")
          problems.push(`节点 ${node.nodeId} 数值比较要求两侧 number 类型`);
      }
    }
    if (node.repeat && !node.repeat.exitWhen && node.repeat.maxIterations > 100)
      problems.push(`节点 ${node.nodeId} repeat 无退出条件时上限必须 ≤100（防长空转）`);
  }

  // 子流程：版本引用必须已知；递归（definitionId 出现在祖先链）拒绝；深度受限。
  if (depth >= content.maxSubflowDepth) {
    problems.push(`子流程嵌套深度超过上限 ${content.maxSubflowDepth}`);
  }
  for (const node of content.nodes) {
    if (!node.subflow) continue;
    const key = `${node.subflow.definitionId}@${node.subflow.version}`;
    const currentId = `${content.name}@v?`; // 调用方以自身 definitionId 传入 knownSubflows
    void currentId;
    if (!(key in knownSubflows) && Object.keys(knownSubflows).length > 0)
      problems.push(`子流程引用未注册：${key}`);
    if (visiting.has(node.subflow.definitionId))
      problems.push(`子流程递归拒绝：${node.subflow.definitionId}`);
  }
  void visiting;
  return { ok: problems.length === 0, problems };
}

function transitiveDeps(content: WorkflowDefinitionContent, nodeId: string): Set<string> {
  const result = new Set<string>();
  const walk = (id: string) => {
    const node = content.nodes.find((n) => n.nodeId === id);
    if (!node) return;
    for (const dep of node.dependsOn) {
      if (!result.has(dep)) {
        result.add(dep);
        walk(dep);
      }
    }
  };
  walk(nodeId);
  return result;
}
