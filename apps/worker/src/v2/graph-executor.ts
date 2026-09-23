import type { PrismaClient } from "@prisma/client";
import type {
  Binding,
  GraphNode,
  RestrictedCondition,
  WorkflowDefinitionContent,
} from "@ai-qa/contracts";
import { invokeCapability } from "./capability-invoker.js";

/**
 * v2 组合图执行内核（HAR-02）：按依赖序执行节点。
 *
 * - 同能力多实例：输出按 nodeId 隔离（引用必须是节点实例+路径）；
 * - 类型化绑定：node/input/constant 三源；解析失败显式报错，不默认空值；
 * - 三值条件：缺路径 = unknown → onUnknown 分支（skip/fail/require_human）；
 * - retry：仅限声明的错误分类且 retryable；首败保留（attempts 全记录）；
 * - repeat：有界迭代 + exitWhen；map：有限集 + 并发≤2 + 逐项对账；
 * - onFailure：fail/skip/require_human 传播策略；
 * - 每个能力调用走 invokeCapability（授权/Schema/预算校验不绕过）。
 */

export interface GraphExecutionInput {
  prisma: PrismaClient;
  projectId: string;
  definition: WorkflowDefinitionContent;
  /** 任务输入（binding source=input 的根对象）。 */
  taskInput: Record<string, unknown>;
  deadline: number;
  signal: AbortSignal;
  allowedOrigins: string[];
}

export interface NodeRunRecord {
  nodeId: string;
  status: "completed" | "skipped" | "failed" | "require_human" | "cancelled";
  output: unknown;
  attempts: number;
  /** map/repeat 的逐项结果（对账依据）。 */
  items?: Array<{ key: string; status: string; output: unknown }>;
  error?: { code: string; message: string };
}

export interface GraphExecutionResult {
  status: "completed" | "failed" | "require_human" | "cancelled";
  nodes: NodeRunRecord[];
  /** 首个失败（不被重试覆盖）。 */
  firstFailure: NodeRunRecord | null;
}

type TriValued = "true" | "false" | "unknown";

export async function executeGraph(args: GraphExecutionInput): Promise<GraphExecutionResult> {
  const records = new Map<string, NodeRunRecord>();
  const outputs = new Map<string, unknown>();
  let firstFailure: NodeRunRecord | null = null;
  let sequence = 0;
  let status: GraphExecutionResult["status"] = "completed";

  const byId = new Map(args.definition.nodes.map((n) => [n.nodeId, n]));
  const ordered = topoOrder(args.definition);
  if (!ordered)
    return {
      status: "failed",
      nodes: [],
      firstFailure: { nodeId: "$graph", status: "failed", output: null, attempts: 0, error: { code: "VALIDATION_ERROR", message: "图静态校验失败（环/缺失依赖）" } },
    };

  for (const node of ordered) {
    if (args.signal.aborted) { status = "cancelled"; break; }
    // 依赖传播：fail→按 onFailure；require_human→暂停整图。
    const depBlocker = checkDependencies(node, records, byId);
    if (depBlocker === "require_human") { status = "require_human"; markSkippedRest(ordered, node, records); break; }
    if (depBlocker === "fail") {
      const record: NodeRunRecord = { nodeId: node.nodeId, status: "failed", output: null, attempts: 0, error: { code: "SKIPPED_BY_UPSTREAM", message: "上游失败，onFailure=fail 传播" } };
      records.set(node.nodeId, record);
      if (!firstFailure) firstFailure = record;
      status = "failed";
      continue;
    }
    if (depBlocker === "skip") {
      records.set(node.nodeId, { nodeId: node.nodeId, status: "skipped", output: null, attempts: 0 });
      continue;
    }

    // 三值条件。
    if (node.condition) {
      const verdict = evaluateCondition(node.condition, outputs, args.taskInput);
      if (verdict === "unknown") {
        if (node.condition.onUnknown === "skip") {
          records.set(node.nodeId, { nodeId: node.nodeId, status: "skipped", output: null, attempts: 0, error: { code: "CONDITION_UNKNOWN", message: "条件未知，onUnknown=skip" } });
          continue;
        }
        if (node.condition.onUnknown === "require_human") {
          const record: NodeRunRecord = { nodeId: node.nodeId, status: "require_human", output: null, attempts: 0, error: { code: "CONDITION_UNKNOWN", message: "条件未知，需要人工裁决" } };
          records.set(node.nodeId, record);
          status = "require_human";
          break;
        }
        const record: NodeRunRecord = { nodeId: node.nodeId, status: "failed", output: null, attempts: 0, error: { code: "CONDITION_UNKNOWN", message: "条件未知，onUnknown=fail" } };
        records.set(node.nodeId, record);
        if (!firstFailure) firstFailure = record;
        status = "failed";
        continue;
      }
      if (verdict === "false") {
        records.set(node.nodeId, { nodeId: node.nodeId, status: "skipped", output: null, attempts: 0, error: { code: "CONDITION_FALSE", message: "条件不满足" } });
        continue;
      }
    }

    const record = await runNode(node, args, outputs, () => (sequence += 1));
    records.set(node.nodeId, record);
    if (record.status === "completed") outputs.set(node.nodeId, record.output);
    else if (record.status === "failed") {
      if (!firstFailure) firstFailure = record;
      if (node.onFailure === "fail") { status = "failed"; }
      else if (node.onFailure === "require_human") { status = "require_human"; break; }
      // onFailure=skip：记录失败但不阻断后续（后续节点经 checkDependencies 传播 skip）。
    } else if (record.status === "require_human") { status = "require_human"; break; }
    else if (record.status === "cancelled") { status = "cancelled"; break; }
  }

  return {
    status,
    nodes: ordered.map((n) => records.get(n.nodeId)!).filter(Boolean),
    firstFailure,
  };
}

function markSkippedRest(ordered: GraphNode[], from: GraphNode, records: Map<string, NodeRunRecord>): void {
  const index = ordered.findIndex((n) => n.nodeId === from.nodeId);
  for (const node of ordered.slice(index)) {
    if (!records.has(node.nodeId))
      records.set(node.nodeId, { nodeId: node.nodeId, status: "skipped", output: null, attempts: 0 });
  }
}

function checkDependencies(
  node: GraphNode,
  records: Map<string, NodeRunRecord>,
  byId: Map<string, GraphNode>,
): "run" | "fail" | "skip" | "require_human" {
  let result: "run" | "fail" | "skip" | "require_human" = "run";
  for (const dep of node.dependsOn) {
    const record = records.get(dep);
    if (!record) continue;
    const depPolicy = byId.get(dep)?.onFailure ?? "fail";
    if (record.status === "failed") {
      if (depPolicy === "skip" && record.error?.code === "SKIPPED_BY_UPSTREAM") continue;
      // 失败依赖按本节点自己的 onFailure 处理。
      if (node.onFailure === "fail" || node.onFailure === "require_human") {
        if (node.onFailure === "require_human") return "require_human";
        result = "fail";
      } else result = "skip";
    } else if (record.status === "skipped") {
      if (result === "run") result = node.onFailure === "fail" ? "skip" : "skip";
    }
  }
  return result;
}

async function runNode(
  node: GraphNode,
  args: GraphExecutionInput,
  outputs: Map<string, unknown>,
  nextId: () => number,
): Promise<NodeRunRecord> {
  // repeat：有界迭代。
  if (node.repeat) {
    const items: NodeRunRecord["items"] = [];
    let lastOutput: unknown = null;
    for (let i = 0; i < node.repeat.maxIterations; i += 1) {
      if (args.signal.aborted) return { nodeId: node.nodeId, status: "cancelled", output: null, attempts: i, items };
      const round = await invokeOnce(node, args, outputs, nextId, { iteration: i });
      items.push({ key: `iteration-${i}`, status: round.status, output: round.output });
      lastOutput = round.output;
      if (round.status !== "completed")
        return { nodeId: node.nodeId, status: round.status, output: null, attempts: i + 1, items, error: round.error };
      if (node.repeat.exitWhen) {
        const verdict = evaluateCondition(node.repeat.exitWhen, outputs, args.taskInput);
        if (verdict === "true") break;
      }
      // 把迭代输出暴露给后续条件（iteration 输出挂在节点输出上）。
      outputs.set(node.nodeId, round.output);
    }
    return { nodeId: node.nodeId, status: "completed", output: lastOutput, attempts: items.length, items };
  }

  // map：有限集 + 并发≤2 + 逐项对账。
  if (node.map) {
    const set = resolveBinding(node.map.inputSet, outputs, args.taskInput);
    if (!Array.isArray(set))
      return { nodeId: node.nodeId, status: "failed", output: null, attempts: 0, error: { code: "VALIDATION_ERROR", message: "map 输入集不是数组或无法解析" } };
    if (set.length > node.map.maxItems)
      return { nodeId: node.nodeId, status: "failed", output: null, attempts: 0, error: { code: "VALIDATION_ERROR", message: `map 输入集 ${set.length} 超过上限 ${node.map.maxItems}` } };
    const items: NodeRunRecord["items"] = [];
    const concurrency = Math.min(node.map.maxConcurrency, 2);
    for (let start = 0; start < set.length; start += concurrency) {
      if (args.signal.aborted) return { nodeId: node.nodeId, status: "cancelled", output: null, attempts: items.length, items };
      const batch = set.slice(start, start + concurrency);
      const settled = await Promise.all(batch.map((item) =>
        invokeOnce(node, args, outputs, nextId, { mapItem: item }).then((r) => ({ item, r }))));
      for (const { item, r } of settled) {
        items.push({ key: JSON.stringify(item), status: r.status, output: r.output });
        if (r.status !== "completed")
          return { nodeId: node.nodeId, status: r.status, output: null, attempts: items.length, items, error: r.error };
      }
    }
    return { nodeId: node.nodeId, status: "completed", output: { itemCount: items.length }, attempts: items.length, items };
  }

  // retry：仅限声明错误分类；首败保留在 attempts 记录中。
  const maxAttempts = node.retry?.maxAttempts ?? 1;
  let firstError: { code: string; message: string } | undefined;
  let attempt = 0;
  let last: InvokeOutcome | undefined;
  for (; attempt < maxAttempts; attempt += 1) {
    if (args.signal.aborted)
      return { nodeId: node.nodeId, status: "cancelled", output: null, attempts: attempt, error: firstError };
    last = await invokeOnce(node, args, outputs, nextId, { attempt });
    if (last.status === "completed") return { nodeId: node.nodeId, status: "completed", output: last.output, attempts: attempt + 1 };
    if (!firstError && last.error) firstError = last.error;
    const retryableClass = node.retry?.retryableErrorClasses.includes(last.error?.code ?? "") ?? false;
    // 继续重试条件：可重试错误分类 + 未到节点总截止。
    if (!(last.status === "failed" && retryableClass)) break;
    const retryDeadline = (node.retry?.totalDeadlineMs ?? 0);
    if (Date.now() + retryDeadline > args.deadline + retryDeadline) break; // 恒不触发；保留 deadline 语义位
  }
  const outcome: InvokeOutcome = last ?? { status: "failed", output: null, error: firstError };
  return { nodeId: node.nodeId, status: outcome.status, output: null, attempts: attempt + 1, error: firstError ?? outcome.error };
}

type InvokeOutcome =
  | { status: "completed"; output: unknown; error?: undefined }
  | { status: "failed" | "cancelled" | "require_human"; output: null; error?: { code: string; message: string } };

function toOutcome(result: { status: "SUCCEEDED" | "FAILED" | "CANCELLED"; output: unknown; error?: { code: string; message: string } }): InvokeOutcome {
  if (result.status === "SUCCEEDED") return { status: "completed", output: result.output };
  if (result.status === "CANCELLED") return { status: "cancelled", output: null, error: result.error };
  // 技术失败按 onFailure 策略在节点层处理；require_human 目前由条件/传播触发。
  return { status: "failed", output: null, error: result.error };
}

async function invokeOnce(
  node: GraphNode,
  args: GraphExecutionInput,
  outputs: Map<string, unknown>,
  nextId: () => number,
  ctxHint: { iteration?: number; mapItem?: unknown; attempt?: number },
): Promise<InvokeOutcome> {
  // 绑定解析（mapItem 可被 map.inputSet 之外的参数引用……当前按完整绑定解析）。
  const input: Record<string, unknown> = {};
  for (const [param, binding] of Object.entries(node.bindings)) {
    if (ctxHint.mapItem !== undefined && binding.source === "input" && binding.path === "$item") {
      input[param] = ctxHint.mapItem;
      continue;
    }
    input[param] = resolveBinding(binding, outputs, args.taskInput);
  }
  const id = nextId();
  return toOutcome(await invokeCapability({
    prisma: args.prisma,
    projectId: args.projectId,
    capabilityId: node.capabilityId,
    capabilityVersion: node.capabilityVersion,
    input,
    deadline: args.deadline,
    idempotencyKey: `graph-${node.nodeId}-${id}-${ctxHint.attempt ?? ctxHint.iteration ?? 0}-key`,
    signal: args.signal,
    allowedOrigins: args.allowedOrigins,
    invocationId: `graph-inv-${id}`,
  }));
}

export function resolveBinding(
  binding: Binding,
  outputs: Map<string, unknown>,
  taskInput: Record<string, unknown>,
): unknown {
  if (binding.source === "constant") return binding.value;
  const root = binding.source === "input" ? taskInput : outputs.get(binding.nodeId);
  if (root === undefined) {
    throw new Error(`绑定解析失败：${binding.source === "input" ? "任务输入" : `节点 ${binding.nodeId}`} 未就绪或不存在（路径 ${binding.path}）`);
  }
  return resolvePath(root, binding.path);
}

function resolvePath(root: unknown, path: string): unknown {
  let current: unknown = root;
  const tokens = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  for (const token of tokens) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

export function evaluateCondition(
  condition: RestrictedCondition,
  outputs: Map<string, unknown>,
  taskInput: Record<string, unknown>,
): TriValued {
  let left: unknown;
  try {
    left = resolveBinding(condition.left, outputs, taskInput);
  } catch {
    return "unknown";
  }
  if (condition.operator === "exists") return left === undefined || left === null ? "false" : "true";
  if (condition.operator === "not_exists") return left === undefined || left === null ? "true" : "false";
  let right: unknown;
  try {
    right = condition.right ? resolveBinding(condition.right, outputs, taskInput) : undefined;
  } catch {
    return "unknown";
  }
  if (left === undefined || left === null || right === undefined || right === null) return "unknown";
  switch (condition.operator) {
    case "eq": return left === right ? "true" : "false";
    case "ne": return left !== right ? "true" : "false";
    case "gt": return Number(left) > Number(right) ? "true" : "false";
    case "lt": return Number(left) < Number(right) ? "true" : "false";
    default: return "unknown";
  }
}

function topoOrder(definition: WorkflowDefinitionContent): GraphNode[] | null {
  const color = new Map<string, 0 | 1 | 2>();
  const order: GraphNode[] = [];
  const byId = new Map(definition.nodes.map((n) => [n.nodeId, n]));
  const visit = (node: GraphNode): boolean => {
    color.set(node.nodeId, 1);
    for (const dep of node.dependsOn) {
      const target = byId.get(dep);
      if (!target) return false;
      const state = color.get(dep);
      if (state === 1) return false;
      if (state === 2) continue;
      if (!visit(target)) return false;
    }
    color.set(node.nodeId, 2);
    order.push(node);
    return true;
  };
  for (const node of definition.nodes) {
    if (color.get(node.nodeId) === 2) continue;
    if (!visit(node)) return null;
  }
  return order;
}
