import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelError } from "../src/error.js";
import {
  MockTextAdapter,
  MockVisionAdapter,
  inputHash,
  registerMockResponse,
} from "../src/mock-adapter.js";
import { loadModelEnvConfig } from "../src/config.js";

const TABLE = join(dirname(fileURLToPath(import.meta.url)), "..", "mock-table", "entries.json");
const ORIGINAL = readFileSync(TABLE, "utf8");

afterEach(() => {
  // 每个测试后恢复原表，避免注册污染（确定性协议的一部分）。
  writeFileSync(TABLE, ORIGINAL);
});

describe("mock 确定性协议（查表 miss 即抛，禁止现编）", () => {
  it("已注册输入 → 稳定返回同一响应（两次调用全等）", async () => {
    const req = {
      purpose: "RULE_EXTRACTION" as const,
      system: "sys",
      user: "user",
      timeoutMs: 5_000,
    };
    registerMockResponse(inputHash(req.purpose, req.system, req.user), { ruleDrafts: [] });
    const adapter = new MockTextAdapter();
    const [a, b] = await Promise.all([adapter.completeText(req), adapter.completeText(req)]);
    expect(a).toEqual(b);
    expect(a.provider).toBe("mock");
    expect(a.model).toBe("mock");
    expect(a.requestId).toMatch(/^mock-/);
    expect(a.outcome).toBe("SUCCESS");
  });

  it("未注册输入 → MODEL_OUTPUT_INVALID（details 带 mockTable/inputHash）", async () => {
    const adapter = new MockTextAdapter();
    const err = await adapter
      .completeText({
        purpose: "CASE_GENERATION",
        system: "从未注册的系统提示",
        user: "从未注册的用户输入",
        timeoutMs: 5_000,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).code).toBe("MODEL_OUTPUT_INVALID");
    expect((err as ModelError).details).toMatchObject({
      mockTable: "mock-table/entries.json",
    });
    expect(String((err as ModelError).details?.inputHash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("注册内容不符合 outputSchema → 抛错（注册即校验）", async () => {
    const req = {
      purpose: "RULE_EXTRACTION" as const,
      system: "s",
      user: "u",
      timeoutMs: 5_000,
      outputSchema: { type: "object", properties: { mustHave: { type: "string" } }, required: ["mustHave"] },
    };
    registerMockResponse(inputHash(req.purpose, req.system, req.user), { wrong: true });
    const err = await new MockTextAdapter().completeText(req).catch((e: unknown) => e);
    expect((err as ModelError).code).toBe("MODEL_OUTPUT_INVALID");
    expect(String((err as ModelError).message)).toContain("outputSchema");
  });

  it("视觉 mock：按 hint+storageKey 查表", async () => {
    const req = {
      purpose: "VISION_DESCRIBE" as const,
      imageStorageKey: "seed-x/observation/observe-01.png",
      hint: "描述这张截图",
      timeoutMs: 5_000,
    };
    registerMockResponse(
      inputHash(req.purpose, "vision", req.hint, req.imageStorageKey),
      { text: "登录页" },
    );
    const r = await new MockVisionAdapter().describeImage(req);
    expect((r.parsedJson as { text: string }).text).toBe("登录页");
  });
});

describe("real 配置纪律（禁止降级 mock）", () => {
  it("provider=moonshot 缺 API_KEY → MODEL_NOT_CONFIGURED，missing 列出变量名", () => {
    let err: unknown = null;
    try {
      loadModelEnvConfig({
        AIQA_TEXT_PROVIDER: "moonshot",
        AIQA_TEXT_BASE_URL: "https://api.moonshot.cn/v1",
        AIQA_TEXT_MODEL: "kimi-k2.6",
        AIQA_VISION_PROVIDER: "mock",
      } as NodeJS.ProcessEnv);
    } catch (e) {
      err = e;
    }
    expect((err as ModelError).code).toBe("MODEL_NOT_CONFIGURED");
    expect((err as ModelError).details).toMatchObject({
      missing: expect.arrayContaining(["AIQA_TEXT_API_KEY"]),
    });
  });

  it("provider=mock 完整可用（无需密钥）", () => {
    const config = loadModelEnvConfig({
      AIQA_TEXT_PROVIDER: "mock",
      AIQA_VISION_PROVIDER: "mock",
    } as NodeJS.ProcessEnv);
    expect(config.text.provider).toBe("mock");
    expect(config.vision.provider).toBe("mock");
  });

  it("未设置 provider → MODEL_NOT_CONFIGURED（不是静默 mock）", () => {
    let err: unknown = null;
    try {
      loadModelEnvConfig({
        AIQA_TEXT_API_KEY: "x",
        AIQA_VISION_PROVIDER: "mock",
      } as NodeJS.ProcessEnv);
    } catch (e) {
      err = e;
    }
    expect((err as ModelError).code).toBe("MODEL_NOT_CONFIGURED");
  });
});
