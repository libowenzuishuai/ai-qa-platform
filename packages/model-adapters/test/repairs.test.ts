import { describe, expect, it } from "vitest";
import { MAX_REPAIRS, parseWithRepairs } from "../src/repairs.js";

describe("有限格式修复（契约：闭集 + ≤2 次）", () => {
  it("合法 JSON 直接解析（零修复）", () => {
    const r = parseWithRepairs('{"a":1}');
    expect(r.ok).toBe(true);
    expect((r.json as { a: number }).a).toBe(1);
    expect(r.repairsApplied).toEqual([]);
  });

  it("code-fence：```json 围栏剥离", () => {
    const r = parseWithRepairs('```json\n{"a":1}\n```');
    expect(r.ok).toBe(true);
    expect(r.repairsApplied).toEqual(["code-fence"]);
  });

  it("trailing-comma：尾逗号移除", () => {
    const r = parseWithRepairs('{"a":[1,2,],}');
    expect(r.ok).toBe(true);
    expect(r.repairsApplied).toEqual(["trailing-comma"]);
  });

  it("bom：BOM 剥离", () => {
    const r = parseWithRepairs('﻿{"a":1}');
    expect(r.ok).toBe(true);
    expect(r.repairsApplied).toEqual(["bom"]);
  });

  it("truncated-json：未闭合括号补齐", () => {
    const r = parseWithRepairs('{"list":[1,2,{"x":"val');
    expect(r.ok).toBe(true);
    expect(r.repairsApplied).toContain("truncated-json");
  });

  it("围栏 + 尾逗号：两次修复内完成", () => {
    const r = parseWithRepairs('```json\n{"a":[1,],}\n```');
    expect(r.ok).toBe(true);
    expect(r.repairsApplied.length).toBeLessThanOrEqual(MAX_REPAIRS);
  });

  it("不可修复 → ok=false（不伪造）", () => {
    const r = parseWithRepairs("这根本不是 JSON");
    expect(r.ok).toBe(false);
  });
});
