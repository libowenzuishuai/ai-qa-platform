import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  OracleSpec,
  CapabilityManifest,
  AdapterInstallation,
  SessionBudget,
  ActionIntent,
  Invocation,
  ContextManifest,
  CoverageLedger,
  Finding,
  TestPatch,
  MemoryUsage,
  computeOracleHash,
  computeAstHash,
  validateGraph,
  sessionCanTransition,
  invocationCanTransition,
  type WorkflowDefinitionContent,
  type OracleSpecContent,
} from "../src/index.js";

/**
 * W01 契约测试：
 * - 共享向量（shape+semantic 两层）全部按声明接受/拒绝；
 * - 图静态校验：无环/绑定闭包/递归子流程/无界循环；
 * - 哈希确定性；状态迁移表拒绝无效迁移。
 */

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/v2-w01-vectors.json", import.meta.url)), "utf8"),
) as { cases: Array<{ name: string; schema: string; valid: boolean; value: unknown; layer: "shape" | "semantic" }> };

const schemas: Record<string, { safeParse: (v: unknown) => { success: boolean } }> = {
  V2OracleSpec: OracleSpec,
  V2CapabilityManifest: CapabilityManifest,
  V2AdapterInstallation: AdapterInstallation,
  V2SessionBudget: SessionBudget,
  V2ActionIntent: ActionIntent,
  V2Invocation: Invocation,
  V2ContextManifest: ContextManifest,
  V2CoverageLedger: CoverageLedger,
  V2Finding: Finding,
  V2TestPatch: TestPatch,
  V2MemoryUsage: MemoryUsage,
};

describe("W01 共享向量（全部层）", () => {
  for (const c of vectors.cases) {
    it(`${c.valid ? "接受" : "拒绝"} ${c.name} [${c.layer}]`, () => {
      const schema = schemas[c.schema];
      if (!schema) throw new Error(`向量引用未知 schema：${c.schema}`);
      const result = schema.safeParse(c.value);
      expect(result.success).toBe(c.valid);
    });
  }
  it("shape 层向量必须存在（防止误标全 semantic）", () => {
    expect(vectors.cases.filter((c) => c.layer === "shape").length).toBeGreaterThanOrEqual(15);
  });
});

describe("W01 图静态校验", () => {
  const node = (nodeId: string, over: Record<string, unknown> = {}) => ({
    nodeId, capabilityId: "example.http-read", capabilityVersion: "1.0.0",
    dependsOn: [], bindings: {}, onFailure: "fail", ...over,
  });
  const graph = (nodes: unknown[], over: Record<string, unknown> = {}) => ({
    name: "g", description: "", nodes: nodes as never, maxSubflowDepth: 4, ...over,
  }) as unknown as WorkflowDefinitionContent;

  it("合法线性图 + 类型化绑定通过", () => {
    const content = graph([
      node("fetch", {}),
      node("check", {
        dependsOn: ["fetch"],
        bindings: { resourcePath: { source: "node", nodeId: "fetch", path: "output.path", type: "string" } },
      }),
    ]);
    expect(validateGraph(content).ok).toBe(true);
  });

  it("外层环拒绝", () => {
    const content = graph([
      node("a", { dependsOn: ["b"] }),
      node("b", { dependsOn: ["a"] }),
    ]);
    const result = validateGraph(content);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("环"))).toBe(true);
  });

  it("绑定不存在的节点拒绝；绑定自身拒绝；依赖外节点拒绝", () => {
    const missing = validateGraph(graph([
      node("a", { bindings: { p: { source: "node", nodeId: "ghost", path: "x", type: "string" } } }),
    ]));
    expect(missing.ok).toBe(false);
    expect(missing.problems.some((p) => p.includes("不存在"))).toBe(true);

    const selfBind = validateGraph(graph([
      node("a", { bindings: { p: { source: "node", nodeId: "a", path: "x", type: "string" } } }),
    ]));
    expect(selfBind.ok).toBe(false);

    const outside = validateGraph(graph([
      node("a", {}),
      node("b", {}),
      node("c", {
        dependsOn: ["a"],
        bindings: { p: { source: "node", nodeId: "b", path: "x", type: "string" } },
      }),
    ]));
    expect(outside.ok).toBe(false);
    expect(outside.problems.some((p) => p.includes("依赖闭包"))).toBe(true);
  });

  it("数值比较条件类型错拒绝；exists 带右值拒绝", () => {
    const badType = validateGraph(graph([
      node("a", {
        condition: {
          left: { source: "constant", value: "1", type: "string" },
          operator: "gt",
          right: { source: "constant", value: 2, type: "number" },
          onUnknown: "fail",
        },
      }),
    ]));
    expect(badType.ok).toBe(false);
    const badExists = validateGraph(graph([
      node("a", {
        condition: {
          left: { source: "constant", value: 1, type: "number" },
          operator: "exists",
          right: { source: "constant", value: 1, type: "number" },
          onUnknown: "skip",
        },
      }),
    ]));
    expect(badExists.ok).toBe(false);
  });

  it("无退出条件的 repeat 上限>100 拒绝（无界循环防御）", () => {
    const result = validateGraph(graph([
      node("loop", { repeat: { maxIterations: 500 } }),
    ]));
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("空转"))).toBe(true);
    // 有界小上限允许。
    expect(validateGraph(graph([node("loop", { repeat: { maxIterations: 10 } })])).ok).toBe(true);
  });

  it("子流程递归拒绝；深度超限拒绝", () => {
    const content = graph([
      node("sub", { subflow: { definitionId: "def-self", version: 1 } }),
    ], { name: "def-self" });
    const result = validateGraph(content, {}, 0, new Set(["def-self"]));
    expect(result.problems.some((p) => p.includes("递归"))).toBe(true);
    const deep = validateGraph(
      graph([node("sub", { subflow: { definitionId: "def-other", version: 1 } })]),
      { "def-other@1": 1 },
      4,
      new Set(),
    );
    expect(deep.problems.some((p) => p.includes("深度"))).toBe(true);
  });

  it("重复 nodeId 拒绝；AST 哈希确定性", () => {
    const dup = validateGraph(graph([node("a"), node("a")]));
    expect(dup.ok).toBe(false);
    const content = graph([node("a")]);
    expect(computeAstHash(content)).toBe(computeAstHash(structuredClone(content)));
  });
});

describe("W01 状态迁移与哈希", () => {
  it("会话状态迁移表拒绝无效迁移", () => {
    expect(sessionCanTransition("RUNNING", "WAITING_HUMAN")).toBe(true);
    expect(sessionCanTransition("COMPLETED", "RUNNING")).toBe(false);
    expect(sessionCanTransition("CANCELLED", "RUNNING")).toBe(false);
    expect(sessionCanTransition("QUEUED", "COMPLETED")).toBe(false);
  });
  it("调用状态：UNKNOWN 允许受控重查；终态不可回退", () => {
    expect(invocationCanTransition("RUNNING", "UNKNOWN")).toBe(true);
    expect(invocationCanTransition("UNKNOWN", "PENDING")).toBe(true);
    expect(invocationCanTransition("SUCCEEDED", "PENDING")).toBe(false);
    expect(invocationCanTransition("FAILED", "PENDING")).toBe(true); // 显式重试=新 attempt，不擦首败
  });
  it("oracleHash 确定性与内容敏感", () => {
    const base: OracleSpecContent = {
      projectId: "proj-1",
      ruleVersionIds: ["rv-2", "rv-1"],
      assertions: [{
        id: "a-1", ruleVersionId: "rv-1", kind: "deterministic", operator: "equals",
        fact: "审批单状态文本", observationType: "ui_text", observationRef: "审批单状态元素",
        expected: "5000", precondition: null, unit: "元", tolerance: null,
        allowedRoles: [], required: true,
      }],
      semanticCandidates: [],
      coverageDeclarations: [],
    };
    expect(computeOracleHash(base)).toBe(computeOracleHash(structuredClone(base)));
    const changed = structuredClone(base);
    changed.assertions[0]!.expected = "3000";
    expect(computeOracleHash(changed)).not.toBe(computeOracleHash(base));
  });
});
