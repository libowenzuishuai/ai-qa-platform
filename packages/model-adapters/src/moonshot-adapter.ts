import type {
  ModelCapabilities,
  ModelResponse,
  ModelRepairKind,
  TextModelAdapter,
  TextModelRequest,
  VisionModelAdapter,
  VisionModelRequest,
} from "@ai-qa/contracts";
import { ModelError } from "./error.js";
import { parseWithRepairs } from "./repairs.js";
import { compileOutputSchema, validateAgainstSchema } from "./schema.js";
import type { ModelChannelConfig } from "./config.js";

/**
 * Moonshot（Kimi）适配器：OpenAI 兼容 chat/completions 协议。
 * 参考对齐 2026-09-17 复核实测（moonshot / kimi-k2.6，两次调用通过）。
 *
 * - JSON 输出：Moonshot 支持 response_format=json_object；完整 JSON Schema
 *   不原生支持 → capabilities.jsonSchemaInput=false，schema 以文本随
 *   system 提示传入（契约注释允许的降级路径）。
 * - 超时：AbortSignal.timeout(req.timeoutMs)，超时抛 MODEL_TIMEOUT。
 * - 4xx（含 401/429）→ outcome PROVIDER_ERROR；5xx → DEPENDENCY_UNAVAILABLE。
 * - 有限格式修复（≤2）+ outputSchema 校验；失败抛 MODEL_OUTPUT_INVALID
 *   （details 含 repairsApplied 与 rawExcerpt，不含密钥）。
 * - 凭据只在请求头注入，不进入日志/响应/异常。
 */

/** 可注入 fetch（测试用 stub；默认全局 fetch）。 */
export type FetchLike = typeof fetch;

export interface MoonshotAdapterOptions {
  config: ModelChannelConfig;
  fetchImpl?: FetchLike;
  /** 读取图片字节（storageKey → Buffer + mime）。视觉适配器必需。 */
  readImage?: (storageKey: string) => { data: Buffer; mime: string } | null;
}

interface ChatMessage {
  role: "system" | "user";
  content: string | Array<Record<string, unknown>>;
}

interface ChatCompletionBody {
  id?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

const CAPABILITIES: ModelCapabilities = {
  vision: true,
  maxInputTokens: 128_000,
  maxOutputTokens: 8_192,
  jsonSchemaInput: false, // 仅 json_object；schema 走提示词内嵌
};

function embedSchemaInSystem(system: string, outputSchema: unknown): string {
  if (outputSchema === undefined || outputSchema === null) return system;
  return `${system}\n\n输出必须是符合以下 JSON Schema 的单个 JSON 对象，不要输出其它内容：\n${JSON.stringify(outputSchema)}`;
}

async function requestCompletion(
  options: MoonshotAdapterOptions,
  messages: ChatMessage[],
  timeoutMs: number,
  temperature?: number,
  maxOutputTokens?: number,
): Promise<{ content: string; requestId: string | null; usage: ChatCompletionBody["usage"] }> {
  const { config } = options;
  const doFetch: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  let response: Response;
  try {
    response = await doFetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // 凭据仅进入请求头；不写日志、不进异常文本。
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature,
        max_tokens: maxOutputTokens,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new ModelError("MODEL_TIMEOUT", `模型请求超过 ${timeoutMs}ms`, { timeoutMs });
    }
    throw new ModelError(
      "DEPENDENCY_UNAVAILABLE",
      `无法连接模型服务 ${config.baseUrl}（${err instanceof Error ? err.message : String(err)}）`,
    );
  }

  const requestId = response.headers.get("x-request-id");
  const bodyText = await response.text();

  if (response.status >= 500) {
    throw new ModelError("DEPENDENCY_UNAVAILABLE", `模型服务 ${response.status}`, {
      provider: "moonshot",
      status: response.status,
      excerpt: bodyText.slice(0, 200),
    });
  }
  if (!response.ok) {
    const parsed = safeJson(bodyText);
    const message =
      (parsed as ChatCompletionBody | null)?.error?.message ?? `HTTP ${response.status}`;
    throw new ModelError("MODEL_NOT_CONFIGURED", `模型服务拒绝请求：${message}`, {
      provider: "moonshot",
      status: response.status,
    });
  }

  const body = safeJson(bodyText) as ChatCompletionBody | null;
  const content = body?.choices?.[0]?.message?.content ?? "";
  const resolvedRequestId = requestId ?? body?.id ?? null;
  return { content, requestId: resolvedRequestId, usage: body?.usage };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toModelResponse(
  rawText: string,
  parsedJson: unknown,
  repairsApplied: ModelRepairKind[],
  requestId: string | null,
  usage: ChatCompletionBody["usage"],
  model: string,
  latencyMs: number,
): ModelResponse {
  return {
    parsedJson,
    rawText,
    repairsApplied,
    provider: "moonshot",
    model,
    requestId,
    usage: {
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
    },
    latencyMs,
    outcome: "SUCCESS",
  };
}

export class MoonshotTextAdapter implements TextModelAdapter {
  readonly name: string;
  private readonly options: MoonshotAdapterOptions;

  constructor(options: MoonshotAdapterOptions) {
    this.name = `moonshot-${options.config.model}`;
    this.options = options;
  }

  capabilities(): ModelCapabilities {
    return { ...CAPABILITIES, vision: false };
  }

  async completeText(req: TextModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    const system = embedSchemaInSystem(req.system, req.outputSchema);
    const { content, requestId, usage } = await requestCompletion(
      this.options,
      [
        { role: "system", content: system },
        { role: "user", content: req.user },
      ],
      req.timeoutMs,
      req.temperature,
      req.maxOutputTokens,
    );

    // 有限格式修复 + schema 校验。
    const repair = parseWithRepairs(content);
    if (!repair.ok) {
      throw new ModelError("MODEL_OUTPUT_INVALID", "模型输出经有限修复后仍不是合法 JSON", {
        repairsApplied: repair.repairsApplied,
        rawExcerpt: content.slice(0, 200),
      });
    }
    const validate = compileOutputSchema(req.outputSchema);
    const verdict = validateAgainstSchema(validate, repair.json);
    if (!verdict.ok) {
      throw new ModelError("MODEL_OUTPUT_INVALID", "模型输出不符合 outputSchema", {
        repairsApplied: repair.repairsApplied,
        rawExcerpt: content.slice(0, 200),
        schemaErrors: verdict.errors,
      });
    }
    return toModelResponse(
      content,
      repair.json,
      repair.repairsApplied,
      requestId,
      usage,
      this.options.config.model,
      Date.now() - started,
    );
  }
}

export class MoonshotVisionAdapter implements VisionModelAdapter {
  readonly name: string;
  private readonly options: MoonshotAdapterOptions;
  private readonly readImageFn: NonNullable<MoonshotAdapterOptions["readImage"]>;

  constructor(options: MoonshotAdapterOptions & { readImage: NonNullable<MoonshotAdapterOptions["readImage"]> }) {
    this.name = `moonshot-vision-${options.config.model}`;
    this.options = options;
    this.readImageFn = options.readImage;
  }

  capabilities(): ModelCapabilities {
    return CAPABILITIES;
  }

  async describeImage(req: VisionModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    const image = this.readImageFn(req.imageStorageKey);
    if (!image) {
      throw new ModelError("MODEL_NOT_CONFIGURED", `图片不存在或不可读：${req.imageStorageKey}`, {
        imageStorageKey: req.imageStorageKey,
      });
    }
    const { content, requestId, usage } = await requestCompletion(
      this.options,
      [
        {
          role: "user",
          content: [
            { type: "text", text: embedSchemaInSystem(req.hint, req.outputSchema) },
            {
              type: "image_url",
              image_url: { url: `data:${image.mime};base64,${image.data.toString("base64")}` },
            },
          ],
        },
      ],
      req.timeoutMs,
    );

    const repair = parseWithRepairs(content);
    if (!repair.ok) {
      throw new ModelError("MODEL_OUTPUT_INVALID", "视觉模型输出经有限修复后仍不是合法 JSON", {
        repairsApplied: repair.repairsApplied,
        rawExcerpt: content.slice(0, 200),
      });
    }
    const validate = compileOutputSchema(req.outputSchema);
    const verdict = validateAgainstSchema(validate, repair.json);
    if (!verdict.ok) {
      throw new ModelError("MODEL_OUTPUT_INVALID", "视觉模型输出不符合 outputSchema", {
        repairsApplied: repair.repairsApplied,
        rawExcerpt: content.slice(0, 200),
        schemaErrors: verdict.errors,
      });
    }
    return toModelResponse(
      content,
      repair.json,
      repair.repairsApplied,
      requestId,
      usage,
      this.options.config.model,
      Date.now() - started,
    );
  }
}
