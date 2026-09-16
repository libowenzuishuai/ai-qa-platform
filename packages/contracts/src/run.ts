import { z } from "zod";
import { Budget, EntityId, IsoDateTime } from "./common.js";
import { RunLifecycle, RunMode } from "./enums.js";

/**
 * Run（PRD §6）。
 * 生命周期与业务判定分开存储：lifecycle 正常结束不代表测试通过。
 * 幂等键项目内唯一；重复 webhook eventId 不创建第二个 run。
 */
export const Run = z.object({
  id: EntityId,
  projectId: EntityId,
  baselineId: EntityId,
  environmentId: EntityId,
  /** 缺构建标识可调试运行，但报告标记“版本未验证”。 */
  buildId: z.string().nullable().default(null),
  mode: RunMode,
  lifecycle: RunLifecycle.default("QUEUED"),
  selectedCaseVersionIds: z.array(EntityId).min(1),
  budget: Budget,
  idempotencyKey: z.string().min(8).max(128),
  /** 严格验收状态（FR-10），由聚合器在 FINALIZING 后写入。 */
  acceptanceStatus: z
    .enum(["PASS", "FAIL", "INCOMPLETE", "PENDING"])
    .default("PENDING"),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Run = z.infer<typeof Run>;

/** 环境接入（PRD FR-01）。 */
export const Environment = z.object({
  id: EntityId,
  projectId: EntityId,
  name: z.string().min(1),
  baseUrl: z.string().url(),
  allowedOrigins: z.array(z.string().url()).min(1),
  dependencyOrigins: z.array(z.string().url()).default([]),
  isProduction: z.boolean().default(false),
  /** 凭据只保存 secretRef，不保存明文。 */
  secretRefs: z.record(z.string(), z.string()).default({}),
  buildMetadata: z.record(z.string(), z.string()).default({}),
  revision: z.number().int().min(1).default(1),
  createdAt: IsoDateTime,
});
export type Environment = z.infer<typeof Environment>;
