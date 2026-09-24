import type { JsonSchemaSubset } from "@ai-qa/contracts";

/**
 * W01 冻结的 JSON Schema 子集校验器（TS 权威实现之一；无第三方依赖）。
 * 支持：type/properties/required/additionalProperties/items/min/maxLength/
 * minimum/maximum/enum/pattern/nullable。不支持的一律显式失败，不静默通过。
 */

export interface SchemaValidation {
  ok: boolean;
  problems: string[];
}

export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchemaSubset,
  path = "$",
): SchemaValidation {
  const problems: string[] = [];
  check(value, schema, path, problems);
  return { ok: problems.length === 0, problems };
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function check(value: unknown, schema: JsonSchemaSubset, path: string, problems: string[]): void {
  if (value === null) {
    if (!schema.nullable) problems.push(`${path}: null 不被允许（schema 未声明 nullable）`);
    return;
  }
  const actual = typeOf(value);
  const expected = schema.type;
  const typeOk =
    expected === actual ||
    (expected === "number" && actual === "integer") || // integer 是 number 的子集
    (expected === "object" && actual === "object");
  if (!typeOk) {
    problems.push(`${path}: 类型 ${actual} 不符合 ${expected}`);
    return;
  }
  if (expected === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    for (const required of schema.required ?? []) {
      if (!(required in record)) problems.push(`${path}: 缺少必需字段 ${required}`);
    }
    const props = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of keys) {
        if (!(key in props)) problems.push(`${path}: 未知字段 ${key}（additionalProperties=false）`);
      }
    }
    for (const [key, child] of Object.entries(props)) {
      if (key in record) check(record[key], child, `${path}.${key}`, problems);
    }
    return;
  }
  if (expected === "array") {
    const items = schema.items;
    if (!items) {
      problems.push(`${path}: array schema 必须声明 items（防无约束数组）`);
      return;
    }
    const arrayValue = value as unknown[];
    for (let i = 0; i < arrayValue.length; i += 1) {
      check(arrayValue[i], items, `${path}[${i}]`, problems);
    }
    return;
  }
  if (expected === "string") {
    const text = value as string;
    if (schema.minLength !== undefined && text.length < schema.minLength)
      problems.push(`${path}: 长度 ${text.length} < minLength ${schema.minLength}`);
    if (schema.maxLength !== undefined && text.length > schema.maxLength)
      problems.push(`${path}: 长度 ${text.length} > maxLength ${schema.maxLength}`);
    if (schema.pattern !== undefined) {
      // R0.7：pattern 本身非法时受控报错，不让异常穿透使作业悬挂
      //（安装自检已拦截；这里是运行时兜底）。
      try {
        if (!new RegExp(schema.pattern).test(text))
          problems.push(`${path}: 不匹配模式 ${schema.pattern}`);
      } catch {
        problems.push(`${path}: 模式自身不合法（运行时兜底拦截）：${schema.pattern}`);
      }
    }
  }
  if (expected === "number" || expected === "integer") {
    const num = value as number;
    if (schema.minimum !== undefined && num < schema.minimum)
      problems.push(`${path}: ${num} < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && num > schema.maximum)
      problems.push(`${path}: ${num} > maximum ${schema.maximum}`);
  }
  if (schema.enum !== undefined && !schema.enum.some((candidate) => candidate === value)) {
    problems.push(`${path}: ${JSON.stringify(value)} 不在枚举内`);
  }
}
