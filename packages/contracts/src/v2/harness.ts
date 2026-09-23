import { z } from "zod";
import { EntityId, IsoDateTime } from "../common.js";
import { canonicalStringify } from "../acceptance-hash.js";
import { createHash } from "node:crypto";

/**
 * v2 Harness 契约（HAR-01～07）：注册式能力、安装、Profile 版本。
 *
 * CapabilityManifest：能力的自描述（协议、Schema、效果、权限、幂等/恢复）。
 * 安装（AdapterInstallation）与授权分离：注册不等于允许调用。
 * HarnessProfileVersion：工具/模型/策略/判定/记忆引用的版本化组装，发布即冻结。
 */

// ---------- CapabilityManifest ----------

export const EffectClass = z.enum(["READ", "WRITE", "CREATE", "DELETE"]);

export const CapabilityRecoveryMode = z.enum([
  "read_only",          // 只读，可安全重试
  "idempotent",         // 业务幂等键保证
  "reconcilable",       // 写后可核对（先查再决定）
  "unsafe_retry",       // 写入结果不明且无核对方法 → UNKNOWN 后人工
]);

export const CapabilityPermissions = z.object({
  /** 网络范围：环境白名单 / 声明的额外 origin（须经管理员批准）。 */
  network: z.enum(["environment-allowlist", "declared-origins-only"]),
  declaredOrigins: z.array(z.string().url()).max(20).default([]),
  /** 凭据只允许引用（secretRef），明文不出现在 Manifest/日志/模型输入。 */
  secrets: z.enum(["none", "declared-refs-only"]),
  secretRefs: z.array(z.string().min(1).max(128)).max(20).default([]),
}).strict();

export const CapabilityProtocol = z.enum([
  "local-ts",       // 运行器内加载的 TS 适配器（SDK）
  "remote-http",    // Python/HTTP 远程适配器（SDK）
]);

/** JSON Schema 子集：封闭字段、明确类型、有限深度（W01 冻结；双端同向量）。 */
export interface JsonSchemaSubsetShape {
  type: "object" | "string" | "number" | "integer" | "boolean" | "array";
  properties?: Record<string, JsonSchemaSubsetShape>;
  required?: string[];
  additionalProperties?: false;
  items?: JsonSchemaSubsetShape;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  enum?: Array<string | number | boolean>;
  pattern?: string;
  nullable?: boolean;
}

const JsonSchemaSubsetInner: z.ZodType<JsonSchemaSubsetShape> = z.object({
  type: z.enum(["object", "string", "number", "integer", "boolean", "array"]),
  properties: z.record(z.string(), z.lazy(() => JsonSchemaSubsetInner)).optional(),
  required: z.array(z.string().min(1)).max(100).optional(),
  additionalProperties: z.literal(false).optional(),
  items: z.lazy(() => JsonSchemaSubsetInner).optional(),
  minLength: z.number().int().min(0).max(1_000_000).optional(),
  maxLength: z.number().int().min(1).max(10_000_000).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  enum: z.array(z.union([z.string(), z.number(), z.boolean()])).max(1000).optional(),
  pattern: z.string().max(500).optional(),
  nullable: z.boolean().optional(),
}).strict();
export const JsonSchemaSubset = JsonSchemaSubsetInner;
export type JsonSchemaSubset = JsonSchemaSubsetShape;

export const CapabilityManifest = z.object({
  /** 能力 ID：命名空间.名称（kebab/snake），全局唯一。 */
  id: z.string().regex(/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/, "能力 ID 形如 example.http-read"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "语义化版本"),
  protocolVersion: z.literal("aiqa.capability/2"),
  protocol: CapabilityProtocol,
  /** 运行入口：local-ts 为适配器模块名；remote-http 为安装记录的 endpoint 引用。 */
  entrypointRef: z.string().min(1).max(500),
  inputSchema: JsonSchemaSubset,
  outputSchema: JsonSchemaSubset,
  effectClass: EffectClass,
  permissions: CapabilityPermissions,
  idempotency: CapabilityRecoveryMode,
  recovery: CapabilityRecoveryMode,
  cancel: z.enum(["cooperative", "best_effort", "unknown"]),
  /** 声明超时上限（毫秒）；调用方 deadline 不得超过。 */
  timeoutMsMax: z.number().int().min(1000).max(600_000),
  humanName: z.string().min(1).max(200),
  description: z.string().max(2000).default(""),
}).strict();
export type CapabilityManifest = z.infer<typeof CapabilityManifest>;

/** Manifest 内容哈希：同 id+version 内容不可变（安装校验依据）。 */
export function computeManifestHash(manifest: Omit<CapabilityManifest, never>): string {
  return createHash("sha256").update(canonicalStringify(manifest)).digest("hex");
}

// ---------- AdapterInstallation ----------

export const AdapterInstallationStatus = z.enum([
  "PENDING_CHECK",   // 已提交待校验
  "VALIDATED",       // Schema/入口校验通过（未授权）
  "AUTHORIZED",      // 管理员授权（可被调用）
  "REVOKED",         // 撤权（历史运行可查，新调用拒绝）
  "DISABLED",        // 禁用（不影响历史，阻止新调用）
]);

export const AdapterInstallation = z.object({
  id: EntityId,
  projectId: EntityId,
  /** 指向 CapabilityManifest 的 id+version（不内联副本，防漂移）。 */
  capabilityId: z.string(),
  capabilityVersion: z.string(),
  /** 安装来源摘要与内容哈希（复现依据）。 */
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  installedBy: z.string(),
  installedAt: IsoDateTime,
  status: AdapterInstallationStatus,
  /** remote-http 的 endpoint（URL 规范化；local-ts 为空）。 */
  endpoint: z.string().url().nullable().default(null),
  /** 授权记录：谁批了什么范围（REVOKED 后保留审计）。 */
  authorization: z.object({
    grantedBy: z.string(),
    grantedAt: IsoDateTime,
    scope: z.array(z.string().min(1).max(200)).max(50),
    revokedBy: z.string().nullable().default(null),
    revokedAt: IsoDateTime.nullable().default(null),
  }).nullable().default(null),
}).strict().superRefine((install, ctx) => {
  if (install.status === "AUTHORIZED" && !install.authorization)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["authorization"], message: "AUTHORIZED 必须携带授权记录（安装≠授权）" });
  if (install.authorization?.revokedAt && install.status !== "REVOKED")
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "有撤销记录时状态必须是 REVOKED" });
});
export type AdapterInstallation = z.infer<typeof AdapterInstallation>;

// ---------- HarnessProfileVersion ----------

export const HarnessProfileStatus = z.enum(["DRAFT", "VALIDATED", "PUBLISHED", "DEPRECATED", "DISABLED"]);

export const HarnessProfileContent = z.object({
  /** 精确版本引用（禁止 latest）；发布时冻结为哈希。 */
  capabilities: z.array(z.object({
    capabilityId: z.string(),
    version: z.string(),
    installationId: EntityId.nullable().default(null),
  }).strict()).min(1).max(200),
  /** 模型路由（INT-05）：角色→提供商/模型/版本。 */
  modelRoutes: z.object({
    generator: z.string().min(1).max(200),
    vision: z.string().min(1).max(200),
    decision: z.string().min(1).max(200),
  }).strict(),
  /** 判定与记忆策略引用（策略本身版本化）。 */
  verifierPolicy: z.string().min(1).max(200),
  memoryPolicy: z.string().min(1).max(200),
}).strict();
export type HarnessProfileContent = z.infer<typeof HarnessProfileContent>;

export const HarnessProfileVersion = HarnessProfileContent.extend({
  id: EntityId,
  projectId: EntityId,
  key: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: z.number().int().min(1),
  status: HarnessProfileStatus.default("DRAFT"),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdBy: z.string(),
  createdAt: IsoDateTime,
  publishedAt: IsoDateTime.nullable().default(null),
}).strict().superRefine((profile, ctx) => {
  if (profile.status === "PUBLISHED" && !profile.publishedAt)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["publishedAt"], message: "PUBLISHED 必须记录发布时间" });
  const seen = new Set<string>();
  for (const cap of profile.capabilities) {
    const k = `${cap.capabilityId}@${cap.version}`;
    if (seen.has(k))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["capabilities"], message: `能力引用重复：${k}` });
    seen.add(k);
  }
});
export type HarnessProfileVersion = z.infer<typeof HarnessProfileVersion>;

export function computeProfileHash(content: HarnessProfileContent): string {
  return createHash("sha256").update(canonicalStringify(content)).digest("hex");
}
