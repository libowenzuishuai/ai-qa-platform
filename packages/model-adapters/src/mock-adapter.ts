import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ModelCapabilities,
  ModelResponse,
  ModelUsage,
  TextModelAdapter,
  TextModelRequest,
  VisionModelAdapter,
  VisionModelRequest,
} from "@ai-qa/contracts";
import { ModelError } from "./error.js";
import { compileOutputSchema, validateAgainstSchema } from "./schema.js";

/**
 * MockAdapter 确定性协议（契约注释 + 测试锁定）：
 * - 响应按 `purpose + sha256(system + "\n" + user + "\n" + hint)` 查
 *   mock-table/entries.json 内置映射表；
 * - 查不到即抛 MODEL_OUTPUT_INVALID（details: {mockTable, inputHash}），
 *   禁止现编、禁止返回空——mock 也不许偷偷变聪明；
 * - usage 由内容长度确定性推导（可复现，不假装真实用量）。
 */

const TABLE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "mock-table",
  "entries.json",
);

export interface MockTable {
  entries: Record<string, unknown>;
}

export function inputHash(purpose: string, system: string, user: string, extra = ""): string {
  return createHash("sha256").update(`${purpose}\n${system}\n${user}\n${extra}`).digest("hex");
}

function loadTable(): MockTable {
  if (!existsSync(TABLE_PATH)) return { entries: {} };
  return JSON.parse(readFileSync(TABLE_PATH, "utf8")) as MockTable;
}

/** 注册 mock 响应（测试与 scripts/mock-register.mjs 使用）。 */
export function registerMockResponse(key: string, parsedJson: unknown): void {
  const table = loadTable();
  table.entries[key] = parsedJson;
  mkdirSync(dirname(TABLE_PATH), { recursive: true });
  writeFileSync(TABLE_PATH, JSON.stringify(table, null, 2) + "\n");
}

function deterministicUsage(payload: unknown): ModelUsage {
  const text = JSON.stringify(payload) ?? "";
  return { inputTokens: Math.ceil(text.length / 4), outputTokens: Math.ceil(text.length / 2) };
}

function buildMockResponse(req: { purpose: string; system: string; user: string }, key: string): ModelResponse {
  const table = loadTable();
  const hit = table.entries[key];
  if (hit === undefined) {
    throw new ModelError(
      "MODEL_OUTPUT_INVALID",
      "mock 查表 miss：未注册该输入的确定性响应（禁止现编）",
      { mockTable: "mock-table/entries.json", inputHash: key },
    );
  }
  return {
    parsedJson: hit,
    rawText: JSON.stringify(hit),
    repairsApplied: [],
    provider: "mock",
    model: "mock",
    requestId: `mock-${key.slice(0, 12)}`,
    usage: deterministicUsage(hit),
    latencyMs: 0,
    outcome: "SUCCESS",
  };
}

export class MockTextAdapter implements TextModelAdapter {
  readonly name = "mock";

  capabilities(): ModelCapabilities {
    return { vision: false, maxInputTokens: 1_000_000, maxOutputTokens: 65_536, jsonSchemaInput: true };
  }

  async completeText(req: TextModelRequest): Promise<ModelResponse> {
    const key = inputHash(req.purpose, req.system, req.user);
    const response = buildMockResponse(req, key);
    // mock 表内容由注册者保证；仍执行 schema 校验，防止注册即错。
    const validate = compileOutputSchema(req.outputSchema);
    const verdict = validateAgainstSchema(validate, response.parsedJson);
    if (!verdict.ok) {
      throw new ModelError("MODEL_OUTPUT_INVALID", "mock 注册内容不符合 outputSchema", {
        mockTable: "mock-table/entries.json",
        inputHash: key,
        schemaErrors: verdict.errors,
      });
    }
    return response;
  }
}

export class MockVisionAdapter implements VisionModelAdapter {
  readonly name = "mock-vision";

  async describeImage(req: VisionModelRequest): Promise<ModelResponse> {
    const key = inputHash(req.purpose, "vision", req.hint, req.imageStorageKey);
    const response = buildMockResponse(
      { purpose: req.purpose, system: "vision", user: req.hint },
      key,
    );
    const verdict = validateAgainstSchema(compileOutputSchema(req.outputSchema), response.parsedJson);
    if (!verdict.ok) {
      throw new ModelError("MODEL_OUTPUT_INVALID", "视觉 mock 注册内容不符合 outputSchema", {
        mockTable: "mock-table/entries.json", inputHash: key, schemaErrors: verdict.errors,
      });
    }
    return response;
  }
}
