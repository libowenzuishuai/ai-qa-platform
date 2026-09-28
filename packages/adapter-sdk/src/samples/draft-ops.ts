import type { CapabilityManifest } from "@ai-qa/contracts";
import {
  type CapabilityAdapter,
  type CapabilityContext,
  type CapabilityResult,
} from "../index.js";

/**
 * W04 合成草稿系统能力（synthetic，显式标记）：
 * CREATE/WRITE 效果；服务端按 Idempotency-Key 幂等；写后可用 GET 对账（reconcilable）。
 * 只允许指向白名单 origin（合成系统由测试拉起）。
 */

export const DraftOpsManifest: CapabilityManifest = {
  id: "synthetic.draft-ops",
  version: "1.0.0",
  protocolVersion: "aiqa.capability/2",
  protocol: "local-ts",
  entrypointRef: "@ai-qa/adapter-sdk/samples/draft-ops",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["baseUrl", "op"],
    properties: {
      baseUrl: { type: "string", minLength: 8, maxLength: 500 },
      op: { type: "string", enum: ["meta", "create", "rename", "get"] },
      draftId: { type: "string", maxLength: 200 },
      title: { type: "string", maxLength: 500 },
      renamePath: { type: "string", maxLength: 300 },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["status", "kind"],
    properties: {
      status: { type: "integer", minimum: 100, maximum: 599 },
      kind: { type: "string", enum: ["meta", "created", "reused", "renamed", "draft", "error"] },
      draft: { type: "object", nullable: true },
      meta: { type: "object", nullable: true },
    },
  },
  effectClass: "CREATE",
  permissions: { network: "environment-allowlist", declaredOrigins: [], secrets: "none", secretRefs: [] },
  idempotency: "idempotent",
  recovery: "reconcilable",
  cancel: "cooperative",
  timeoutMsMax: 15_000,
  humanName: "合成草稿系统操作（W04 synthetic）",
  description: "meta/create/rename/get；服务端 Idempotency-Key 幂等；写效果可对账。",
};

export class DraftOpsAdapter implements CapabilityAdapter {
  readonly manifest = DraftOpsManifest;

  async execute(input: unknown, ctx: CapabilityContext): Promise<CapabilityResult> {
    const { baseUrl, op, draftId, title, renamePath } = input as {
      baseUrl: string; op: string; draftId?: string; title?: string; renamePath?: string;
    };
    if (!ctx.allowedOrigins.includes(new URL(baseUrl).origin))
      return failed("FORBIDDEN", `目标 origin 不在白名单：${baseUrl}`);
    if (ctx.signal.aborted) return cancelled();
    if (ctx.deadline <= Date.now()) return failed("BUDGET_EXCEEDED", "调用期限已到");
    const safeUrl = (path: string) => {
      const url = new URL(path, baseUrl);
      if (url.origin !== new URL(baseUrl).origin || !ctx.allowedOrigins.includes(url.origin) || url.username || url.password)
        throw new Error("目标越过授权 origin");
      return url;
    };
    const timeout = Math.max(1, Math.min(ctx.deadline - Date.now(), this.manifest.timeoutMsMax));
    const signal = AbortSignal.any([AbortSignal.timeout(timeout), ctx.signal]);
    try {
      if (op === "meta") {
        const r = await fetch(safeUrl("/api/_meta"), { signal, redirect: "error" });
        if (ctx.signal.aborted) return cancelled();
        if (!r.ok) return failed("TARGET_HTTP_ERROR", `目标返回 HTTP ${r.status}`);
        const meta = (await r.json()) as Record<string, unknown>;
        return ok({ status: r.status, kind: "meta", draft: null, meta });
      }
      if (op === "create") {
        const r = await fetch(safeUrl("/api/drafts"), {
          method: "POST", redirect: "error", signal,
          headers: { "content-type": "application/json", "idempotency-key": ctx.idempotencyKey },
          body: JSON.stringify({ title: title ?? "未命名草稿" }),
        });
        if (ctx.signal.aborted) return cancelled();
        if (!r.ok) return failed("TARGET_HTTP_ERROR", `目标返回 HTTP ${r.status}`);
        const body = (await r.json()) as { reused?: boolean; draft?: unknown };
        return ok({ status: r.status, kind: body.reused ? "reused" : "created", draft: body.draft ?? null, meta: null });
      }
      if (op === "rename") {
        if (!draftId || !renamePath || title === undefined)
          return failed("VALIDATION_ERROR", "rename 需要 draftId/renamePath/title");
        const r = await fetch(safeUrl(renamePath.replace(":id", encodeURIComponent(draftId))), {
          method: "PATCH", redirect: "error", signal,
          headers: { "content-type": "application/json", "idempotency-key": ctx.idempotencyKey },
          body: JSON.stringify({ title }),
        });
        if (ctx.signal.aborted) return cancelled();
        const body = (await r.json().catch(() => ({}))) as { draft?: unknown };
        if (r.status === 404)
          return failed("ROUTE_MOVED", `改名入口 ${renamePath} 返回 404（定位可能已变化，需重新观察）`);
        if (!r.ok) return failed("TARGET_HTTP_ERROR", `目标返回 HTTP ${r.status}`);
        return ok({ status: r.status, kind: "renamed", draft: body.draft ?? null, meta: null });
      }
      if (op === "get") {
        if (!draftId) return failed("VALIDATION_ERROR", "get 需要 draftId");
        const r = await fetch(safeUrl(`/api/drafts/${encodeURIComponent(draftId)}`), { signal, redirect: "error" });
        if (ctx.signal.aborted) return cancelled();
        const body = (await r.json().catch(() => ({}))) as { draft?: unknown };
        if (!r.ok) return failed("TARGET_HTTP_ERROR", `目标返回 HTTP ${r.status}`);
        return ok({ status: r.status, kind: r.status === 200 ? "draft" : "error", draft: body.draft ?? null, meta: null });
      }
      return failed("VALIDATION_ERROR", `未知 op：${op}`);
    } catch (error) {
      if (ctx.signal.aborted) return cancelled();
      const name = error instanceof Error ? error.name : String(error);
      // 写效果超时/断连：副作用不明（服务端可能已创建）——UNKNOWN 等待对账。
      if ((op === "create" || op === "rename") && !(error instanceof Error && error.message.includes("授权 origin")))
        return { status: "UNKNOWN", output: null, resourceKeys: [], retryable: false, error: { code: "MODEL_TIMEOUT", message: "写效果超时（副作用未知，先对账）" } };
      return failed("DEPENDENCY_UNAVAILABLE", `请求失败：${name}`);
    }
  }
}

function ok(output: unknown): CapabilityResult {
  return { status: "SUCCEEDED", output, resourceKeys: [], retryable: false };
}
function failed(code: string, message: string): CapabilityResult {
  return { status: "FAILED", output: null, resourceKeys: [], retryable: false, error: { code, message } };
}
function cancelled(): CapabilityResult {
  return { status: "CANCELLED", output: null, resourceKeys: [], retryable: false, error: { code: "CANCELLED", message: "调用已取消" } };
}
