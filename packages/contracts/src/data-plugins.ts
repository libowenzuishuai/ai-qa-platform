import { z } from "zod";
import { EntityId, IsoDateTime } from "./common.js";
const relative = z
  .string()
  .max(500)
  .regex(/^\/(?!\/)[^\\\x00-\x1f?#]*$/)
  .refine(
    (p) => !p.includes("..") && !p.includes("%"),
    "路径不可含父级目录或百分号编码",
  );
const resourcePath = relative.refine(
  (p) => p.includes("{resourceId}"),
  "必须指定本次资源 ID",
);
export const DataEffectType = z.enum(["READ", "WRITE", "CREATE", "DELETE"]);
export const HttpDataPluginDefinition = z
  .object({
    prepare: z
      .object({ method: z.enum(["POST", "PUT"]), path: relative })
      .strict(),
    cleanup: z
      .object({
        method: z.literal("DELETE"),
        path: resourcePath,
        allow404: z.boolean().default(false),
      })
      .strict(),
    inspect: z
      .object({ method: z.literal("GET"), path: resourcePath })
      .strict(),
    timeoutMs: z.number().int().min(100).max(30000).default(10000),
  })
  .strict();
export const DataParameterSchema = z
  .object({
    type: z.literal("object"),
    properties: z
      .record(
        z.string().regex(/^[a-zA-Z][\w-]{0,49}$/),
        z.object({ type: z.enum(["string", "number", "boolean"]) }).strict(),
      )
      .default({}),
    required: z.array(z.string()).max(50).default([]),
  })
  .strict();
export const DataParameters = z
  .record(
    z.string(),
    z.union([z.string().max(2000), z.number().finite(), z.boolean()]),
  )
  .superRefine((params, ctx) => {
    for (const [key, value] of Object.entries(params)) {
      if (
        [
          "url",
          "method",
          "path",
          "script",
          "resourceId",
          "namespace",
          "__proto__",
          "constructor",
        ].includes(key) ||
        (["scope", "target", "environment"].includes(key) &&
          ["*", "all", "全库", "全环境"].includes(String(value).toLowerCase()))
      )
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: "参数只能携带本资源数据，不能覆盖操作或扩大清理范围",
        });
    }
  });
export const PrepareRequest = z
  .object({
    idempotencyKey: z.string().min(1).max(120),
    params: DataParameters.default({}),
    runId: EntityId.optional(),
    attemptId: EntityId.optional(),
  })
  .strict();
export const CleanupRequest = z
  .object({ resourceIds: z.array(EntityId).min(1).max(100) })
  .strict();
export const HttpTemplateParams = DataParameters;
export const DataResourceStatus = z.enum([
  "pending",
  "success",
  "failed",
  "unknown",
  "cleaned",
  "cleanup_failed",
  "cleaning",
]);
export const DataResourceRecord = z.object({
  id: EntityId,
  projectId: EntityId,
  runId: z.string().nullable(),
  attemptId: z.string().nullable(),
  namespace: z.string(),
  pluginId: EntityId,
  externalRef: z.string(),
  action: z.enum(["prepare", "cleanup"]),
  actionFingerprint: z.string(),
  status: DataResourceStatus,
  evidenceId: z.string().nullable(),
  detail: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
