import { z } from 'zod';
import { EntityId, IsoDateTime } from './common.js';

/**
 * P0-2 数据准备与清理插件契约。
 */

/** 插件效果类型。 */
export const DataEffectType = z.enum(['READ', 'WRITE', 'CREATE', 'DELETE']);

/** HTTP 请求模板插件参数（首版唯一实现）。 */
export const HttpTemplateParams = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  /** 相对环境 baseUrl 的路径。 */
  path: z.string().regex(/^\/(?!\/)[^\\\x00-\x1f]*$/),
  /** 仅数据参数，禁止脚本。 */
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  body: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  /** 环境登记的模板凭据引用（可选）。 */
  credentialRef: z.string().optional(),
  timeoutMs: z.number().int().min(100).max(30_000).default(10_000),
});

/** 资源台账记录。 */
export const DataResourceStatus = z.enum([
  'pending',
  'success',
  'failed',
  'unknown',
  'cleaned',
  'cleanup_failed',
]);

export const DataResourceRecord = z.object({
  id: EntityId,
  projectId: EntityId,
  runId: z.string().nullable(),
  attemptId: z.string().nullable(),
  namespace: z.string().min(1),
  pluginId: EntityId,
  externalRef: z.string().min(1).max(2000),
  action: z.enum(['prepare', 'cleanup']),
  actionFingerprint: z.string(),
  status: DataResourceStatus,
  evidenceId: z.string().nullable(),
  detail: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

/** 清理请求幂等。 */
export const CleanupRequest = z.object({
  namespace: z.string().min(1).max(200),
  /** 指定资源 ID 列表；空 = 该命名空间下全部。 */
  resourceIds: z.array(EntityId).default([]),
}).strict();

/** 准备请求。 */
export const PrepareRequest = z.object({
  pluginId: EntityId,
  namespace: z.string().min(1).max(200),
  params: z.record(z.string(), z.unknown()),
  runId: z.string().optional(),
  attemptId: z.string().optional(),
}).strict();
