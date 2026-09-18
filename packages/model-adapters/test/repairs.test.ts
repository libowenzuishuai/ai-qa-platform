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
    const r = parseWithRepairs('{"list":[1,2,{"x":"val"');
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

 it("修复尾逗号时保留正文、转义引号与反斜杠", () => {
   for (const rule of ["显示 ,} 原文", "金额 ,] 不得修改", '转义引号 \" ,} 正文', "路径 \\ ,] 保留"]) {
     const raw = JSON.stringify({ rule, list: ["x"] }).replace(/}$/, ",}");
     expect(parseWithRepairs(raw).json).toEqual({ rule, list: ["x"] });
   }
 });
 it("不接受字符串被截断的业务内容", () => {
   expect(parseWithRepairs('{"rule":"金额不得超').ok).toBe(false);
 });
