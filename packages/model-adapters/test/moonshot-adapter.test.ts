import { describe, expect, it } from "vitest";
import { ModelError } from "../src/error.js";
import {
  MoonshotTextAdapter,
  MoonshotVisionAdapter,
} from "../src/moonshot-adapter.js";
import type { ModelChannelConfig } from "../src/config.js";

/**
 * moonshot 适配器测试：fetch 注入 stub，零网络、零真实密钥。
 * 只验证协议往返、错误映射、usage/requestId 提取与修复链。
 */

const CONFIG: ModelChannelConfig = {
  provider: "moonshot",
  baseUrl: "https://mock.invalid/v1",
  model: "kimi-test",
  apiKey: "test-key-never-real",
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function lastRequestBody(captured: Array<unknown>): Record<string, unknown> {
  return captured[captured.length - 1] as Record<string, unknown>;
}

describe("MoonshotTextAdapter（fetch stub）", () => {
  const baseReq = {
    purpose: "RULE_EXTRACTION" as const,
    system: "你是测试分析员",
    user: "输入内容",
    timeoutMs: 5_000,
  };

  it("成功往返：JSON 内容解析、usage/requestId 映射、schema 校验通过", async () => {
    const captured: Array<unknown> = [];
    const adapter = new MoonshotTextAdapter({
      config: CONFIG,
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        captured.push(JSON.parse(String(init?.body)));
        return jsonResponse(
          200,
          {
            id: "chatcmpl-test-1",
            choices: [{ message: { content: '{"ruleDrafts":[]}' } }],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          },
          { "x-request-id": "req-abc" },
        ) as Response;
      }) as typeof fetch,
    });
    const r = await adapter.completeText({
      ...baseReq,
      maxOutputTokens: 7,
      outputSchema: { type: "object", properties: { ruleDrafts: { type: "array" } }, required: ["ruleDrafts"] },
    });
    expect(r.parsedJson).toEqual({ ruleDrafts: [] });
    expect(r.provider).toBe("moonshot");
    expect(r.model).toBe("kimi-test");
    expect(r.requestId).toBe("req-abc"); // 头优先
    expect(r.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(r.outcome).toBe("SUCCESS");
    // 请求侧：schema 内嵌 system + response_format json_object。
    const body = lastRequestBody(captured);
    expect(body.max_tokens).toBe(7);
    expect(body.response_format).toEqual({ type: "json_object" });
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain("JSON Schema");
    // 密钥只在请求头，绝不出现在响应/结果中。
    expect(JSON.stringify(r)).not.toContain("test-key-never-real");
  });

  it("code-fence 输出被修复且 repairsApplied 记录", async () => {
    const adapter = new MoonshotTextAdapter({
      config: CONFIG,
      fetchImpl: (async () =>
        jsonResponse(200, {
          choices: [{ message: { content: '```json\n{"ok":true}\n```' } }],
          usage: {},
        })) as typeof fetch,
    });
    const r = await adapter.completeText(baseReq);
    expect(r.parsedJson).toEqual({ ok: true });
    expect(r.repairsApplied).toEqual(["code-fence"]);
  });

  it("输出不符合 outputSchema → MODEL_OUTPUT_INVALID（带 rawExcerpt/schemaErrors）", async () => {
    const adapter = new MoonshotTextAdapter({
      config: CONFIG,
      fetchImpl: (async () =>
        jsonResponse(200, {
          choices: [{ message: { content: '{"wrong": 1}' } }],
          usage: {},
        })) as typeof fetch,
    });
    const err = await adapter
      .completeText({
        ...baseReq,
        outputSchema: { type: "object", required: ["mustHave"] },
      })
      .catch((e: unknown) => e);
    expect((err as ModelError).code).toBe("MODEL_OUTPUT_INVALID");
    expect((err as ModelError).details).toMatchObject({
      repairsApplied: [],
      rawExcerpt: '{"wrong": 1}',
    });
  });

  it("完全非 JSON 输出 → MODEL_OUTPUT_INVALID", async () => {
    const adapter = new MoonshotTextAdapter({
      config: CONFIG,
      fetchImpl: (async () =>
        jsonResponse(200, {
          choices: [{ message: { content: "抱歉我不明白" } }],
          usage: {},
        })) as typeof fetch,
    });
    const err = await adapter.completeText(baseReq).catch((e: unknown) => e);
    expect((err as ModelError).code).toBe("MODEL_OUTPUT_INVALID");
  });

  it("401 → MODEL_NOT_CONFIGURED 语义（服务拒绝）", async () => {
    const adapter = new MoonshotTextAdapter({
      config: CONFIG,
      fetchImpl: (async () =>
        jsonResponse(401, { error: { message: "invalid api key" } })) as typeof fetch,
    });
    const err = await adapter.completeText(baseReq).catch((e: unknown) => e);
    expect((err as ModelError).code).toBe("MODEL_NOT_CONFIGURED");
    expect((err as ModelError).message).toContain("invalid api key");
  });

  it("5xx → DEPENDENCY_UNAVAILABLE", async () => {
    const adapter = new MoonshotTextAdapter({
      config: CONFIG,
      fetchImpl: (async () => jsonResponse(503, { error: {} })) as typeof fetch,
    });
    const err = await adapter.completeText(baseReq).catch((e: unknown) => e);
    expect((err as ModelError).code).toBe("DEPENDENCY_UNAVAILABLE");
    expect((err as ModelError).details).toMatchObject({ status: 503 });
  });

  it("超时 → MODEL_TIMEOUT（AbortSignal）", async () => {
    const adapter = new MoonshotTextAdapter({
      config: CONFIG,
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "TimeoutError";
            reject(e);
          });
        });
      }) as unknown as typeof fetch,
    });
    const err = await adapter
      .completeText({ ...baseReq, timeoutMs: 1_000 })
      .catch((e: unknown) => e);
    expect((err as ModelError).code).toBe("MODEL_TIMEOUT");
    expect((err as ModelError).details).toMatchObject({ timeoutMs: 1_000 });
  });
});

describe("MoonshotVisionAdapter（fetch stub）", () => {
  it("图片以 base64 data URL 进入消息内容；文本命中 hint", async () => {
    const captured: Array<unknown> = [];
    const adapter = new MoonshotVisionAdapter({
      config: CONFIG,
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        captured.push(JSON.parse(String(init?.body)));
        return jsonResponse(200, {
          id: "chatcmpl-vision-1",
          choices: [{ message: { content: '{"text":"登录页"}' } }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        });
      }) as typeof fetch,
      readImage: () => ({ data: Buffer.from("fake-png-bytes"), mime: "image/png" }),
    });
    const r = await adapter.describeImage({
      purpose: "VISION_DESCRIBE",
      imageStorageKey: "obs/01.png",
      hint: "描述页面",
      timeoutMs: 5_000,
    });
    expect((r.parsedJson as { text: string }).text).toBe("登录页");
    expect(r.requestId).toBe("chatcmpl-vision-1"); // 无头时回退 body.id
    const body = lastRequestBody(captured) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    const parts = body.messages[0]!.content;
    expect(parts[0]).toMatchObject({ type: "text", text: expect.stringContaining("描述页面") });
    expect(String((parts[1] as { image_url: { url: string } }).image_url.url)).toMatch(
      /^data:image\/png;base64,/,
    );
  });

  it("图片不可读 → MODEL_NOT_CONFIGURED（凭据/资源缺失类）", async () => {
    const adapter = new MoonshotVisionAdapter({
      config: CONFIG,
      fetchImpl: (async () => jsonResponse(200, {})) as typeof fetch,
      readImage: () => null,
    });
    const err = await adapter
      .describeImage({
        purpose: "VISION_DESCRIBE",
        imageStorageKey: "missing.png",
        hint: "h",
        timeoutMs: 5_000,
      })
      .catch((e: unknown) => e);
    expect((err as ModelError).code).toBe("MODEL_NOT_CONFIGURED");
  });
});
