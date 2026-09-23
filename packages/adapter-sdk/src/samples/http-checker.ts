import { createHash } from "node:crypto";
import type { CapabilityManifest } from "@ai-qa/contracts";
import {
  type CapabilityAdapter,
  type CapabilityContext,
  type CapabilityResult,
} from "../index.js";

/**
 * W02 独立样例 1：TS 本地只读 HTTP 检查器（example.http-read）。
 *
 * 只读（READ）：GET 指定资源路径，返回状态码与响应体 sha256。
 * 安全边界：目标 origin 必须在上下文白名单内（连接层策略之外的第二道防线）；
 * 不跟随重定向到白名单外；超时受 deadline 约束。
 */

export const HttpReadManifest: CapabilityManifest = {
  id: "example.http-read",
  version: "1.0.0",
  protocolVersion: "aiqa.capability/2",
  protocol: "local-ts",
  entrypointRef: "@ai-qa/adapter-sdk/samples/http-checker",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["baseUrl", "resourcePath"],
    properties: {
      baseUrl: { type: "string", minLength: 8, maxLength: 500 },
      resourcePath: { type: "string", minLength: 1, maxLength: 2000 },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["status", "bodySha256"],
    properties: {
      status: { type: "integer", minimum: 100, maximum: 599 },
      bodySha256: { type: "string", minLength: 64, maxLength: 64 },
    },
  },
  effectClass: "READ",
  permissions: { network: "environment-allowlist", declaredOrigins: [], secrets: "none", secretRefs: [] },
  idempotency: "read_only",
  recovery: "read_only",
  cancel: "cooperative",
  timeoutMsMax: 30_000,
  humanName: "HTTP 只读检查器（SDK 样例）",
  description: "GET 资源并返回状态码与响应体哈希；仅限白名单 origin。",
};

export class HttpReadAdapter implements CapabilityAdapter {
  readonly manifest = HttpReadManifest;

  async execute(input: unknown, ctx: CapabilityContext): Promise<CapabilityResult> {
    const { baseUrl, resourcePath } = input as { baseUrl: string; resourcePath: string };
    let target: URL;
    try {
      target = new URL(resourcePath, baseUrl);
    } catch {
      return failed("VALIDATION_ERROR", `不合法的 URL：${baseUrl}${resourcePath}`);
    }
    if (target.protocol !== "http:" && target.protocol !== "https:")
      return failed("VALIDATION_ERROR", `只允许 http/https：${target.protocol}`);
    if (!ctx.allowedOrigins.includes(target.origin))
      return failed("FORBIDDEN", `目标 origin 不在白名单：${target.origin}`);

    const timeoutMs = Math.max(1, Math.min(ctx.deadline - Date.now(), this.manifest.timeoutMsMax));
    try {
      const response = await fetch(target, {
        method: "GET",
        redirect: "error", // 跨 origin 重定向交由连接层策略；这里显式不跟随
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ctx.signal]),
      });
      if (ctx.signal.aborted) return cancelled();
      const body = await response.arrayBuffer();
      if (ctx.signal.aborted) return cancelled();
      const bodySha256 = createHash("sha256").update(new Uint8Array(body)).digest("hex");
      return {
        status: "SUCCEEDED",
        output: { status: response.status, bodySha256 },
        resourceKeys: [],
        retryable: false,
      };
    } catch (error) {
      if (ctx.signal.aborted) return cancelled();
      const name = error instanceof Error ? error.name : String(error);
      if (name === "TimeoutError" || name === "AbortError")
        return { status: "FAILED", output: null, resourceKeys: [], retryable: false, error: { code: "MODEL_TIMEOUT", message: "请求超时" } };
      return failed("DEPENDENCY_UNAVAILABLE", `请求失败：${name}`);
    }
  }
}

function failed(code: string, message: string): CapabilityResult {
  return { status: "FAILED", output: null, resourceKeys: [], retryable: false, error: { code, message } };
}
function cancelled(): CapabilityResult {
  return { status: "CANCELLED", output: null, resourceKeys: [], retryable: false, error: { code: "CANCELLED", message: "调用已取消" } };
}
