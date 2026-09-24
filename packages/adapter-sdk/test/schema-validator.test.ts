import { describe, expect, it } from "vitest";
import { selfCheckSchema, validateAgainstSchema } from "../src/index.js";

/**
 * R0.7（V2-R07）反例回归：
 * - 非法 pattern 在自检受控拒绝（原：ok:true + 运行时 SyntaxError）；
 * - 运行时遇到非法 pattern 不抛异常；
 * - 普通绑定路径 `items` / `response.status` / 数组下标在 Schema 值中合法；
 * - 深层递归受限；required 闭包；区间矛盾。
 */

describe("R0.7 Schema 自检", () => {
  it("非法 pattern 自检拒绝（评审复现项）", () => {
    const result = selfCheckSchema({ type: "string", pattern: "[" });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("pattern 不合法");
  });

  it("运行时非法 pattern 受控（不抛异常）", () => {
    const result = validateAgainstSchema("x", { type: "string", pattern: "[" });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("模式自身不合法");
  });

  it("required 未在 properties 声明被拒", () => {
    const result = selfCheckSchema({
      type: "object",
      required: ["missing"],
      properties: { a: { type: "string" } },
    });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("闭包");
  });

  it("minimum > maximum 区间矛盾被拒", () => {
    expect(selfCheckSchema({ type: "integer", minimum: 10, maximum: 5 }).ok).toBe(false);
  });

  it("minLength > maxLength 被拒", () => {
    expect(selfCheckSchema({ type: "string", minLength: 10, maxLength: 5 }).ok).toBe(false);
  });

  it("深层递归超过 16 层被拒", () => {
    let schema: any = { type: "string" };
    for (let i = 0; i < 20; i += 1) schema = { type: "object", properties: { a: schema } };
    expect(selfCheckSchema(schema).ok).toBe(false);
  });

  it("array 无 items 被拒；有 items 通过", () => {
    expect(selfCheckSchema({ type: "array" } as never).ok).toBe(false);
    expect(selfCheckSchema({ type: "array", items: { type: "string" } }).ok).toBe(true);
  });
});

describe("R0.7 值路径与普通字段名", () => {
  const schema: import("@ai-qa/contracts").JsonSchemaSubset = {
    type: "object",
    additionalProperties: false,
    required: ["items", "response"],
    properties: {
      items: { type: "array", items: { type: "string" } },
      response: {
        type: "object",
        required: ["status"],
        properties: { status: { type: "integer", minimum: 100, maximum: 599 } },
      },
    },
  };
  it("普通字段名 items / response.status 校验通过", () => {
    const ok = validateAgainstSchema({ items: ["a"], response: { status: 200 } }, schema);
    expect(ok.ok).toBe(true);
  });
  it("未知字段拒绝；类型错拒绝", () => {
    expect(validateAgainstSchema({ items: ["a"], response: { status: 200 }, extra: 1 }, schema).ok).toBe(false);
    expect(validateAgainstSchema({ items: [1], response: { status: 200 } }, schema).ok).toBe(false);
    expect(validateAgainstSchema({ items: ["a"], response: { status: 99 } }, schema).ok).toBe(false);
  });
});
