import type { PrismaClient } from "@prisma/client";
import {
  CapabilityManifest,
  RemoteCapabilityResult,
  CapabilityRpcEnvelope,
} from "@ai-qa/contracts";
import {
  validateCapabilityInput,
  validateCapabilityOutput,
  type CapabilityContext,
  type CapabilityResult,
} from "@ai-qa/adapter-sdk";
import { resolveLocal } from "./capability-registry.js";
import type { SecretRefs } from "../credentials.js";

/**
 * v2 能力调用器（HAR-01/04 调用链）：
 * 授权检查（REVOKED/DISABLED 阻止新调用）→ 输入 Schema 校验 → 执行
 * （本地 SDK 适配器或 remote-http）→ 输出 Schema 校验 → 结果返回。
 * 远端返回一律再校验（不可信）；取消按 AbortSignal 协作传播。
 */

export interface InvokeInput {
  prisma: PrismaClient;
  projectId: string;
  capabilityId: string;
  capabilityVersion: string;
  input: unknown;
  /** 调用上下文约束。 */
  deadline: number;
  idempotencyKey: string;
  signal: AbortSignal;
  allowedOrigins: string[];
  installationId?: string;
  invocationId: string;
}

export async function invokeCapability(args: InvokeInput): Promise<CapabilityResult> {
  const fail = (code: string, message: string): CapabilityResult => ({
    status: "FAILED", output: null, resourceKeys: [], retryable: false,
    error: { code, message },
  });

  // 安装与授权：同项目、精确版本、AUTHORIZED（REVOKED/DISABLED 阻止新调用）。
  const installation = args.installationId
    ? await args.prisma.v2AdapterInstallation.findFirst({
        where: {
          id: args.installationId,
          projectId: args.projectId,
          capabilityId: args.capabilityId,
          capabilityVersion: args.capabilityVersion,
        },
      })
    : await args.prisma.v2AdapterInstallation.findFirst({
        where: {
          projectId: args.projectId,
          capabilityId: args.capabilityId,
          capabilityVersion: args.capabilityVersion,
          status: "AUTHORIZED",
        },
        orderBy: { installedAt: "desc" },
      });
  if (!installation) return fail("NOT_FOUND", "能力未安装或不属于本项目");
  if (installation.status === "REVOKED") return fail("FORBIDDEN", "能力授权已撤销，拒绝新调用");
  if (installation.status === "DISABLED") return fail("FORBIDDEN", "能力已禁用，拒绝新调用");
  if (installation.status !== "AUTHORIZED") return fail("FORBIDDEN", `能力状态为 ${installation.status}（未授权）`);

  // Manifest 固定版本（安装哈希与注册表一致才可执行）。
  const manifestRow = await args.prisma.v2CapabilityManifest.findUnique({
    where: { capabilityId_version: { capabilityId: args.capabilityId, version: args.capabilityVersion } },
  });
  if (!manifestRow || manifestRow.manifestHash !== installation.manifestHash)
    return fail("CONFLICT", "安装记录与能力清单版本/哈希不一致");
  const manifest = CapabilityManifest.parse(manifestRow.manifest);

  // 输入 Schema 校验（执行前拦截）。
  const inputCheck = validateCapabilityInput(manifest, args.input);
  if (!inputCheck.ok)
    return fail("VALIDATION_ERROR", `输入不符合能力 Schema：${inputCheck.problems.slice(0, 3).join("；")}`);

  if (args.signal.aborted) return { status: "CANCELLED", output: null, resourceKeys: [], retryable: false, error: { code: "CANCELLED", message: "调用前已取消" } };

  const timeoutMs = Math.max(1, Math.min(args.deadline - Date.now(), manifest.timeoutMsMax));
  const ctx: CapabilityContext = {
    signal: args.signal,
    deadline: Date.now() + timeoutMs,
    resolveSecret: async (ref) => {
      // 凭据引用解析：环境 secretRefs + makeCredentialResolver（明文只给适配器）。
      const { makeCredentialResolver } = await import("../credentials.js");
      const environment = await args.prisma.environment.findFirst({
        where: { projectId: args.projectId },
        orderBy: { revision: "desc" },
        select: { secretRefs: true },
      });
      const resolver = makeCredentialResolver((environment?.secretRefs ?? {}) as SecretRefs);
      const value = resolver(ref);
      if (value === undefined) throw new Error(`凭据引用未配置：${ref}`);
      return value;
    },
    allowedOrigins: args.allowedOrigins,
    idempotencyKey: args.idempotencyKey,
  };

  let result: CapabilityResult;
  const local = resolveLocal(args.capabilityId, args.capabilityVersion);
  if (local) {
    result = await local.adapter.execute(args.input, ctx);
  } else if (manifest.protocol === "remote-http") {
    if (!installation.endpoint) return fail("CONFIG_MISSING", "远程能力缺少 endpoint");
    result = await invokeRemote(installation.endpoint, args, manifest, timeoutMs);
  } else {
    return fail("DEPENDENCY_UNAVAILABLE", `本地适配器未注册且协议为 ${manifest.protocol}`);
  }

  // 输出 Schema 校验：SUCCEEDED 必须输出合规（远端不可信；本地适配器同样不豁免）。
  if (result.status === "SUCCEEDED") {
    const outputCheck = validateCapabilityOutput(manifest, result.output);
    if (!outputCheck.ok) {
      return {
        status: "FAILED", output: null, resourceKeys: result.resourceKeys, retryable: false,
        error: { code: "MODEL_OUTPUT_INVALID", message: `能力输出不符合 Schema：${outputCheck.problems.slice(0, 3).join("；")}` },
      };
    }
  }
  return result;
}

async function invokeRemote(
  endpoint: string,
  args: InvokeInput,
  manifest: CapabilityManifest,
  timeoutMs: number,
): Promise<CapabilityResult> {
  const base = new URL(endpoint);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password)
    return { status: "FAILED", output: null, resourceKeys: [], retryable: false, error: { code: "VALIDATION_ERROR", message: "endpoint 不合法" } };
  const envelope = CapabilityRpcEnvelope.parse({
    protocolVersion: "aiqa.capability-rpc/2",
    invocationId: args.invocationId,
    deadline: new Date(Date.now() + timeoutMs).toISOString(),
    idempotencyKey: args.idempotencyKey,
  });
  try {
    // R0.2（V2-R02）：控制面服务地址固定为安装 endpoint；默认拒绝重定向
    // （302/307/308 一律断连，不做逐跳跟随——控制面不允许被引到未登记地址）。
    const response = await fetch(new URL("/capability/execute", base), {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envelope, input: args.input }),
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), args.signal]),
    });
    if (!response.ok)
      return { status: "FAILED", output: null, resourceKeys: [], retryable: false, error: { code: "DEPENDENCY_UNAVAILABLE", message: `远程适配器返回 ${response.status}` } };
    // 响应大小上限：32 MiB（防异常适配器倾倒导致 worker 挂起）。
    const MAX_REMOTE_BODY = 32 * 1024 * 1024;
    const lengthHeader = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(lengthHeader) && lengthHeader > MAX_REMOTE_BODY)
      return { status: "FAILED", output: null, resourceKeys: [], retryable: false, error: { code: "MODEL_OUTPUT_INVALID", message: "远程适配器响应超过大小上限" } };
    const text = await response.text();
    if (text.length > MAX_REMOTE_BODY)
      return { status: "FAILED", output: null, resourceKeys: [], retryable: false, error: { code: "MODEL_OUTPUT_INVALID", message: "远程适配器响应超过大小上限" } };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { status: "FAILED", output: null, resourceKeys: [], retryable: false, error: { code: "MODEL_OUTPUT_INVALID", message: "远程适配器响应不是合法 JSON" } };
    }
    const parsed = RemoteCapabilityResult.safeParse(json);
    if (!parsed.success)
      return { status: "FAILED", output: null, resourceKeys: [], retryable: false, error: { code: "MODEL_OUTPUT_INVALID", message: "远程适配器结果不符合协议" } };
    return {
      status: parsed.data.status,
      output: parsed.data.output,
      resourceKeys: parsed.data.resourceKeys,
      retryable: parsed.data.retryable,
      error: parsed.data.error ?? undefined,
    };
  } catch (error) {
    if (args.signal.aborted) {
      // 尽力通知远端取消（失败不掩盖取消事实）。
      void fetch(new URL("/capability/cancel", base), {
        method: "POST", redirect: "error", headers: { "content-type": "application/json" },
        body: JSON.stringify({ invocationId: args.invocationId }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => undefined);
      return { status: "CANCELLED", output: null, resourceKeys: [], retryable: false, error: { code: "CANCELLED", message: "调用已取消" } };
    }
    const name = error instanceof Error ? error.name : String(error);
    if (name === "TimeoutError" || name === "AbortError")
      // R0.3（V2-R03）：远程超时副作用未知——写效果归 UNKNOWN（先对账再决定），
      // 只读效果由 recovery=read_only 声明可安全重试。
      return manifest.effectClass === "READ" && manifest.recovery === "read_only"
        ? { status: "FAILED", output: null, resourceKeys: [], retryable: true, error: { code: "MODEL_TIMEOUT", message: "远程适配器超时（只读，可重试）" } }
        : { status: "UNKNOWN", output: null, resourceKeys: [], retryable: false, error: { code: "MODEL_TIMEOUT", message: "远程适配器超时（写入效果未知，先对账）" } };
    return { status: "FAILED", output: null, resourceKeys: [], retryable: false, error: { code: "DEPENDENCY_UNAVAILABLE", message: `远程适配器不可达：${name}` } };
  }
}
