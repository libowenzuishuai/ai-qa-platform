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
  /** 执行命名空间（session/execution id）：幂等键与调用身份据此隔离（R0.4）。 */
  executionKey: string;
}

export interface NodeRunRecord {
  nodeId: string;
  status: "completed" | "skipped" | "failed" | "require_human" | "cancelled" | "unknown_write";
  output: unknown;
  attempts: number;
  /** 首败错误（重试成功也保留；R0.3）。 */
  firstError?: { code: string; message: string };
  /** 首败发生的 attempt 序号（1 起）。 */
  firstFailureAttempt?: number;
  /** 节点实际截止时间戳（任务/节点/能力最早者）。 */
  nodeDeadline?: number;
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

  // 未实现模式显式拒绝（R0.4）：subflow 尚未实现，不能静默按普通节点执行。
  const unsupported = args.definition.nodes.find((n) => n.subflow);
  if (unsupported)
    return {
      status: "failed",
      nodes: [],
      firstFailure: { nodeId: unsupported.nodeId, status: "failed", output: null, attempts: 0, error: { code: "UNSUPPORTED", message: `节点 ${unsupported.nodeId} 使用未实现的 subflow 模式` } },
    };

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
    if (record.status === "completed") {
      outputs.set(node.nodeId, record.output);
      // R0.3：重试成功也保留首败（图级可见，供报告"首次结果/最终结果"分列）。
      if (record.firstError && !firstFailure) {
        firstFailure = { ...record, status: "failed" };
      }
    }
    else if (record.status === "failed") {
      if (!firstFailure) firstFailure = record; // 首个失败（含 firstError 首败证据）
      if (node.onFailure === "fail") { status = "failed"; }
      else if (node.onFailure === "require_human") { status = "require_human"; break; }
      // onFailure=skip：记录失败但不阻断后续（后续节点经 checkDependencies 传播 skip）。
    } else if (record.status === "require_human" || record.status === "unknown_write") { status = "require_human"; break; }
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
  // 节点开始时间与节点截止：实际截止取任务/节点/能力最早者（R0.3）。
  const nodeStartedAt = Date.now();
  const nodeDeadline = node.retry
    ? Math.min(args.deadline, nodeStartedAt + node.retry.totalDeadlineMs)
    : args.deadline;

  // repeat：有界迭代——本轮输出先入账，再用当前轮结果判断退出（R0.4）。
  if (node.repeat) {
    const items: NodeRunRecord["items"] = [];
    let lastOutput: unknown = null;
    for (let i = 0; i < node.repeat.maxIterations; i += 1) {
      if (args.signal.aborted || Date.now() >= nodeDeadline)
        return { nodeId: node.nodeId, status: args.signal.aborted ? "cancelled" : "failed", output: null, attempts: i, items, error: args.signal.aborted ? undefined : { code: "BUDGET_EXCEEDED", message: "repeat 到达节点截止" } };
      const round = await invokeOnce(node, args, outputs, nextId, { iteration: i, nodeDeadline });
      items.push({ key: `iteration-${i}`, status: round.status, output: round.output });
      if (round.status !== "completed")
        return { nodeId: node.nodeId, status: round.status, output: null, attempts: i + 1, items, error: round.error };
      lastOutput = round.output;
      outputs.set(node.nodeId, round.output); // 先让本轮输出可见
      if (node.repeat.exitWhen) {
        const verdict = evaluateCondition(node.repeat.exitWhen, outputs, args.taskInput);
        if (verdict === "true") break;
        // UNKNOWN 按策略处理：fail → 失败；skip→继续迭代；require_human → 暂停。
        if (verdict === "unknown" && node.repeat.exitWhen.onUnknown === "fail")
          return { nodeId: node.nodeId, status: "failed", output: null, attempts: i + 1, items, error: { code: "CONDITION_UNKNOWN", message: "repeat 退出条件未知，onUnknown=fail" } };
        if (verdict === "unknown" && node.repeat.exitWhen.onUnknown === "require_human")
          return { nodeId: node.nodeId, status: "require_human", output: null, attempts: i + 1, items, error: { code: "CONDITION_UNKNOWN", message: "repeat 退出条件未知，需人工" } };
      }
    }
    // 达到上限但目标未满足 ≠ 业务通过：输出不含 goalMet 标记（由 verifier 独立判定）。
    return { nodeId: node.nodeId, status: "completed", output: lastOutput, attempts: items.length, items, nodeDeadline };
  }

  // map：同批全部记账后再决定是否继续（R0.4）。
  if (node.map) {
    const set = resolveBinding(node.map.inputSet, outputs, args.taskInput);
    if (!Array.isArray(set))
      return { nodeId: node.nodeId, status: "failed", output: null, attempts: 0, error: { code: "VALIDATION_ERROR", message: "map 输入集不是数组或无法解析" } };
    if (set.length > node.map.maxItems)
      return { nodeId: node.nodeId, status: "failed", output: null, attempts: 0, error: { code: "VALIDATION_ERROR", message: `map 输入集 ${set.length} 超过上限 ${node.map.maxItems}` } };
    const items: NodeRunRecord["items"] = [];
    const concurrency = Math.min(node.map.maxConcurrency, 2);
    let firstError: { code: string; message: string } | undefined;
    let stopped: "failed" | "cancelled" | "require_human" | null = null;
    for (let start = 0; start < set.length && !stopped; start += concurrency) {
      if (args.signal.aborted) { stopped = "cancelled"; break; }
      if (Date.now() >= nodeDeadline) { stopped = "failed"; firstError ??= { code: "BUDGET_EXCEEDED", message: "map 到达节点截止" }; break; }
      const batch = set.slice(start, start + concurrency);
      // 同批并发发出；全部落定并逐项记账后才决定下一批（已发生副作用不漏账）。
      const settled = await Promise.allSettled(batch.map((item, indexInBatch) =>
        invokeOnce(node, args, outputs, nextId, { mapItem: item, mapIndex: start + indexInBatch, nodeDeadline })
          .then((r) => ({ item, index: start + indexInBatch, r }))));
      for (const entry of settled) {
        if (entry.status === "rejected") {
          // 适配器自身抛出异常（不应发生，但按受控失败记账）。
          items.push({ key: `item-${(entry as PromiseRejectedResult).reason?.index ?? items.length}`, status: "failed", output: null });
          firstError ??= { code: "INTERNAL", message: String((entry as PromiseRejectedResult).reason).slice(0, 200) };
          stopped = "failed";
          continue;
        }
        const { item, index, r } = entry.value;
        // 用稳定实例 ID（索引）区分重复值。
        items.push({ key: `item-${index}`, status: r.status, output: r.output });
        if (r.status !== "completed") {
          firstError ??= r.error ?? { code: "MAP_ITEM_FAILED", message: `map 第 ${index} 项失败` };
          if (r.status === "cancelled") stopped = "cancelled";
          else if (r.status === "require_human") stopped = "require_human";
          else stopped = "failed";
        }
      }
    }
    // 空 map：completed 但 itemCount=0（覆盖缺口由 verifier/report 层呈现）。
    if (stopped)
      return { nodeId: node.nodeId, status: stopped, output: null, attempts: items.length, items, error: firstError, nodeDeadline };
    return { nodeId: node.nodeId, status: "completed", output: { itemCount: items.length }, attempts: items.length, items, nodeDeadline };
  }

  // retry：错误分类∩retryable∩效果类型；首败保留（成功不擦除）；截止零派发（R0.3）。
  const maxAttempts = node.retry?.maxAttempts ?? 1;
  let firstError: { code: string; message: string } | undefined;
  let firstFailureAttempt = 0;
  let attempt = 0;
  let last: InvokeOutcome | undefined;
  for (; attempt < maxAttempts; attempt += 1) {
    if (args.signal.aborted)
      return { nodeId: node.nodeId, status: "cancelled", output: null, attempts: attempt, firstError, error: firstError };
    if (Date.now() >= nodeDeadline)
      return { nodeId: node.nodeId, status: "failed", output: null, attempts: attempt, firstError, error: firstError ?? { code: "BUDGET_EXCEEDED", message: "节点截止前停止派发" } };
    last = await invokeOnce(node, args, outputs, nextId, { attempt, nodeDeadline });
    if (last.status === "completed") {
      // 重试成功也保留首败证据（R0.3）。
      return { nodeId: node.nodeId, status: "completed", output: last.output, attempts: attempt + 1, firstError, nodeDeadline };
    }
    if (!firstError && last.error) { firstError = last.error; firstFailureAttempt = attempt + 1; }
    const errorClassAllowed = node.retry?.retryableErrorClasses.includes(last.error?.code ?? "") ?? false;
    // R0.3：适配器 retryable ∩ 允许错误分类 共同决定（缺一不可）。
    const adapterRetryable = last.retryable !== false;
    if (last.status !== "failed" || !errorClassAllowed || !adapterRetryable) break;
    // 写效果的 FAILED 不可盲目重试：调用器已把写超时归入 UNKNOWN 语义（R0.3），
    // 到达这里的 failed 均为声明可重试类；节点截止在循环顶检查。
  }
  const outcome: InvokeOutcome = last ?? { status: "failed", output: null, error: firstError };
  return { nodeId: node.nodeId, status: outcome.status, output: null, attempts: attempt + 1, firstError, firstFailureAttempt, error: firstError ?? outcome.error, nodeDeadline };
}

type InvokeOutcome =
  | { status: "completed"; output: unknown; retryable?: false; error?: undefined }
  | { status: "failed" | "cancelled" | "require_human" | "unknown_write"; output: null; retryable?: boolean; error?: { code: string; message: string } };

function toOutcome(result: { status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "UNKNOWN"; output: unknown; retryable?: boolean; error?: { code: string; message: string } }): InvokeOutcome {
  if (result.status === "SUCCEEDED") return { status: "completed", output: result.output };
  if (result.status === "CANCELLED") return { status: "cancelled", output: null, error: result.error };
  // R0.3：UNKNOWN（写入效果不明）暂停等待对账/人工，不进普通 failed 重试路径。
  if (result.status === "UNKNOWN") return { status: "unknown_write", output: null, retryable: result.retryable, error: result.error };
  return { status: "failed", output: null, retryable: result.retryable, error: result.error };
}

async function invokeOnce(
  node: GraphNode,
  args: GraphExecutionInput,
  outputs: Map<string, unknown>,
  nextId: () => number,
  ctxHint: { iteration?: number; mapItem?: unknown; mapIndex?: number; attempt?: number; nodeDeadline?: number },
): Promise<InvokeOutcome> {
  // 调用前截止：过期零派发（R0.3）。
  const effectiveDeadline = Math.min(ctxHint.nodeDeadline ?? Number.MAX_SAFE_INTEGER, args.deadline);
  if (Date.now() >= effectiveDeadline)
    return { status: "failed", output: null, error: { code: "BUDGET_EXCEEDED", message: "调用前已达截止，零派发" } };
  const input: Record<string, unknown> = {};
  for (const [param, binding] of Object.entries(node.bindings)) {
    if (ctxHint.mapItem !== undefined && binding.source === "input" && binding.path === "$item") {
      input[param] = ctxHint.mapItem;
      continue;
    }
    input[param] = resolveBinding(binding, outputs, args.taskInput);
  }
  const id = nextId();
  // 业务幂等键与调用身份分离（R0.4）：幂等键=执行命名空间+节点+逻辑项（不含 attempt，
  // 重试复用同一键协作目标端去重）；invocationId=每次物理调用唯一。
  const logicalKey = ctxHint.mapIndex !== undefined
    ? `${args.executionKey}:${node.nodeId}:map-${ctxHint.mapIndex}`
    : ctxHint.iteration !== undefined
      ? `${args.executionKey}:${node.nodeId}:iter-${ctxHint.iteration}`
      : `${args.executionKey}:${node.nodeId}`;
  return toOutcome(await invokeCapability({
    prisma: args.prisma,
    projectId: args.projectId,
    capabilityId: node.capabilityId,
    capabilityVersion: node.capabilityVersion,
    input,
    deadline: effectiveDeadline,
    idempotencyKey: logicalKey,
    signal: args.signal,
    allowedOrigins: args.allowedOrigins,
    invocationId: `${args.executionKey}-inv-${id}`,
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
