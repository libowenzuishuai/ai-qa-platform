import { describe, expect, it } from "vitest";
import { mergeChunkExtractions, chunkCoverage } from "../src/chunk-merge.js";
import type { RuleExtractionOutput } from "@ai-qa/contracts";

/**
 * R03 分层有界合并单元测试：
 * - 完全一致签名去重（来源并集，原始 span ID 不变）；
 * - statement 相同但条件不同 → 不合并 + conflictsWith 双向引用；
 * - 重编号确定性（同一输入同一输出）；
 * - clarifications 去重、unparsedRanges 拼接；
 * - 覆盖对账：缺失/失败/在途/取消都阻断 complete。
 */

function draft(over: Record<string, unknown>) {
  return {
    key: "rule-draft-01",
    statement: "金额超过 50 万元必须审批",
    classification: "EXPLICIT",
    action: "提交审批",
    expectation: "生成审批单",
    forbiddenBehaviors: [],
    priority: "P1",
    businessFields: [],
    sources: [{ documentVersionId: "dv-1", sourceSpanIds: ["s-1"] }],
    conflictsWith: [],
    ...over,
  };
}

function output(ruleDrafts: unknown[]): RuleExtractionOutput {
  return {
    ruleDrafts: ruleDrafts as RuleExtractionOutput["ruleDrafts"],
    clarifications: [],
    unparsedRanges: [],
  };
}

describe("mergeChunkExtractions", () => {
  it("完全一致签名去重并合并来源（并集保序）", () => {
    const merged = mergeChunkExtractions([
      { chunkId: "c-a", seq: 0, output: output([draft({ sources: [{ documentVersionId: "dv-1", sourceSpanIds: ["s-1"] }] })]) },
      { chunkId: "c-b", seq: 1, output: output([draft({ key: "rule-draft-01", sources: [{ documentVersionId: "dv-1", sourceSpanIds: ["s-5"] }] })]) },
    ]);
    expect(merged.ruleDrafts).toHaveLength(1);
    expect(merged.ruleDrafts[0]!.sources[0]!.sourceSpanIds).toEqual(["s-1", "s-5"]);
    expect(merged.ruleDrafts[0]!.key).toBe("rule-draft-01");
  });

  it("statement 相同但条件不同：不合并且 conflictsWith 双向引用", () => {
    const merged = mergeChunkExtractions([
      { chunkId: "c-a", seq: 0, output: output([draft({ condition: "境内交易" })]) },
      { chunkId: "c-b", seq: 1, output: output([draft({ key: "rule-draft-02", condition: "跨境交易", sources: [{ documentVersionId: "dv-1", sourceSpanIds: ["s-9"] }] })]) },
    ]);
    expect(merged.ruleDrafts).toHaveLength(2);
    expect(merged.ruleDrafts[0]!.conflictsWith).toEqual(["rule-draft-02"]);
    expect(merged.ruleDrafts[1]!.conflictsWith).toEqual(["rule-draft-01"]);
    // 两条来源各自保留（不吞并条件不同的规则）。
    expect(merged.ruleDrafts[0]!.sources[0]!.sourceSpanIds).toEqual(["s-1"]);
    expect(merged.ruleDrafts[1]!.sources[0]!.sourceSpanIds).toEqual(["s-9"]);
  });

  it("重编号确定性：同一输入两次合并结果一致", () => {
    const results = [
      { chunkId: "c-a", seq: 0, output: output([draft({}), draft({ key: "rule-draft-02", statement: "第二条规则" })]) },
      { chunkId: "c-b", seq: 1, output: output([draft({ key: "rule-draft-01", statement: "第三条规则" })]) },
    ];
    expect(mergeChunkExtractions(results)).toEqual(mergeChunkExtractions(results));
    const keys = mergeChunkExtractions(results).ruleDrafts.map((d) => d.key);
    expect(keys).toEqual(["rule-draft-01", "rule-draft-02", "rule-draft-03"]);
  });

  it("clarifications 去重、unparsedRanges 按块拼接", () => {
    const clarification = {
      ruleDraftKeys: ["rule-draft-01"],
      kind: "MISSING_INFO" as const,
      question: "审批时效未说明",
      options: ["按工作日", "按自然日"],
    };
    const range = { spanId: "s-1", startLine: 3, endLine: 3, reason: "TABLE_DEGRADED" as const };
    const merged = mergeChunkExtractions([
      { chunkId: "c-a", seq: 0, output: { ruleDrafts: [], clarifications: [clarification], unparsedRanges: [range] } },
      { chunkId: "c-b", seq: 1, output: { ruleDrafts: [], clarifications: [{ ...clarification }], unparsedRanges: [{ ...range, spanId: "s-7" }] } },
    ]);
    expect(merged.clarifications).toHaveLength(1);
    expect(merged.unparsedRanges).toHaveLength(2);
  });

  it("空输入返回空输出", () => {
    expect(mergeChunkExtractions([])).toEqual({ ruleDrafts: [], clarifications: [], unparsedRanges: [] });
  });
});

describe("chunkCoverage", () => {
  const manifest = [
    { chunkId: "c-0", seq: 0 },
    { chunkId: "c-1", seq: 1 },
    { chunkId: "c-2", seq: 2 },
  ];
  it("全部 completed 才 complete", () => {
    expect(chunkCoverage(manifest, manifest.map((c) => ({ chunkId: c.chunkId, status: "completed" }))).complete).toBe(true);
  });
  it("缺失/失败/在途/待处理都阻断", () => {
    expect(chunkCoverage(manifest, []).complete).toBe(false);
    expect(chunkCoverage(manifest, [
      { chunkId: "c-0", status: "completed" },
      { chunkId: "c-1", status: "failed" },
      { chunkId: "c-2", status: "completed" },
    ]).complete).toBe(false);
    expect(chunkCoverage(manifest, [
      { chunkId: "c-0", status: "completed" },
      { chunkId: "c-1", status: "in_progress" },
      { chunkId: "c-2", status: "completed" },
    ]).complete).toBe(false);
    expect(chunkCoverage(manifest, [
      { chunkId: "c-0", status: "pending" },
      { chunkId: "c-1", status: "completed" },
      { chunkId: "c-2", status: "completed" },
    ]).complete).toBe(false);
  });
  it("取消的块计入 cancelled 并阻断", () => {
    const state = chunkCoverage(manifest, [
      { chunkId: "c-0", status: "completed" },
      { chunkId: "c-1", status: "cancelled" },
      { chunkId: "c-2", status: "completed" },
    ]);
    expect(state.complete).toBe(false);
    expect(state.cancelled).toEqual(["c-1"]);
  });
});
