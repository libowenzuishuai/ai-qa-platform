import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { HttpTemplateParams } from '@ai-qa/contracts';
import { requireAuth, requireProjectAccess } from './auth.js';
import { ApiError } from './errors.js';

/**
 * P0-2 数据准备与清理插件 API。
 *
 * - POST /api/projects/:id/data-plugins（管理员注册）
 * - GET  /api/projects/:id/data-plugins
 * - POST /api/projects/:id/data-plugins/:pluginId/prepare（LEAD 触发准备作业）
 * - POST /api/projects/:id/data-plugins/:pluginId/cleanup（LEAD 触发清理作业）
 * - GET  /api/projects/:id/data-resources?namespace=...
 * - POST /api/data-resources/:id/retry-cleanup（管理员复核后重新清理）
 */

export function registerDataPluginRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  jobs: Pick<Queue, 'add'>,
) {
  const param = (req: FastifyRequest, key: string) =>
    z.record(z.string()).parse(req.params)[key]!;
  const json = (x: unknown) => x as never;

  async function findProject(req: FastifyRequest, projectId: string, minRole: 'LEAD' | 'ADMIN' = 'LEAD') {
    await requireProjectAccess(prisma, req, projectId, minRole);
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new ApiError('NOT_FOUND', '项目不存在');
    return project;
  }

  async function enqueue(projectId: string, kind: string, request: Record<string, unknown>) {
    const job = await prisma.job.create({
      data: { projectId, kind, request: json(request), fingerprint: randomUUID() },
    });
    try {
      await jobs.add('run', { jobId: job.id }, { jobId: `job-${job.id}`, removeOnComplete: true });
    } catch { /* durable job reconciliation retries */ }
    return { jobId: job.id };
  }

  // ---------- 插件注册（管理员） ----------

  app.post('/api/projects/:id/data-plugins', async req => {
    const projectId = param(req, 'id');
    await findProject(req, projectId, 'ADMIN');
    const body = z.object({
      kind: z.literal('http-request'),
      name: z.string().min(1).max(200),
      environmentId: z.string().min(1),
      paramSchema: z.object({
        type: z.literal('object'),
        properties: z.record(z.string(), z.unknown()),
        required: z.array(z.string()).default([]),
      }),
      effectTypes: z.array(z.enum(['READ', 'WRITE', 'CREATE', 'DELETE'])).min(1),
    }).strict().parse(req.body);

    const env = await prisma.environment.findFirst({ where: { id: body.environmentId, projectId, isProduction: false } });
    if (!env) throw new ApiError('VALIDATION_ERROR', '环境不存在或不属于该项目');

    const prior = await prisma.dataPlugin.findFirst({
      where: { projectId, kind: body.kind },
      orderBy: { version: 'desc' },
    });
    const plugin = await prisma.dataPlugin.create({
      data: {
        projectId,
        kind: body.kind,
        version: (prior?.version ?? 0) + 1,
        paramSchema: json(body.paramSchema),
        effectTypes: body.effectTypes,
        name: body.name,
        createdBy: requireAuth(req).userId,
      },
    });
    return plugin;
  });

  app.get('/api/projects/:id/data-plugins', async req => {
    const projectId = param(req, 'id');
    await findProject(req, projectId);
    return {
      plugins: await prisma.dataPlugin.findMany({
        where: { projectId, enabled: true },
        orderBy: [{ kind: 'asc' }, { version: 'desc' }],
      }),
    };
  });

  // ---------- 准备（异步作业） ----------

  app.post('/api/projects/:id/data-plugins/:pluginId/prepare', async (req, reply) => {
    const projectId = param(req, 'id');
    const pluginId = param(req, 'pluginId');
    await findProject(req, projectId, 'LEAD');

    const plugin = await prisma.dataPlugin.findFirst({ where: { id: pluginId, projectId, enabled: true } });
    if (!plugin) throw new ApiError('NOT_FOUND', '插件不存在或已禁用');

    const body = z.object({
      namespace: z.string().min(1).max(200),
      params: z.record(z.string(), z.unknown()),
      runId: z.string().optional(),
      attemptId: z.string().optional(),
    }).strict().parse(req.body);

    // HTTP 模板插件：参数需通过 HttpTemplateParams 校验（禁止脚本/任意 URL）。
    if (plugin.kind === 'http-request') {
      const check = HttpTemplateParams.safeParse(body.params);
      if (!check.success) throw new ApiError('VALIDATION_ERROR', '参数不符合 HTTP 模板插件 schema', check.error.issues.slice(0, 3));
    }

    const result = await enqueue(projectId, 'DATA_PREPARE', {
      pluginId,
      namespace: body.namespace,
      params: body.params,
      runId: body.runId ?? null,
      attemptId: body.attemptId ?? null,
    });
    reply.code(202);
    return result;
  });

  // ---------- 清理（异步作业） ----------

  app.post('/api/projects/:id/data-plugins/:pluginId/cleanup', async (req, reply) => {
    const projectId = param(req, 'id');
    const pluginId = param(req, 'pluginId');
    await findProject(req, projectId, 'LEAD');

    const plugin = await prisma.dataPlugin.findFirst({ where: { id: pluginId, projectId } });
    if (!plugin) throw new ApiError('NOT_FOUND', '插件不存在');

    const body = z.object({
      namespace: z.string().min(1).max(200),
      /** 空 = 该命名空间下全部资源；非空 = 指定资源。不接受全库/全环境参数。 */
      resourceIds: z.array(z.string().min(1)).max(500).default([]),
    }).strict().parse(req.body);

    // 拒绝"全库清理"参数。
    if (body.namespace === '*' || body.namespace === 'all') {
      throw new ApiError('VALIDATION_ERROR', '不接受全库清理参数；必须指定具体命名空间');
    }

    const result = await enqueue(projectId, 'DATA_CLEANUP', {
      pluginId,
      namespace: body.namespace,
      resourceIds: body.resourceIds,
    });
    reply.code(202);
    return result;
  });

  // ---------- 资源台账查询 ----------

  app.get('/api/projects/:id/data-resources', async req => {
    const projectId = param(req, 'id');
    await findProject(req, projectId);
    const query = z.object({
      namespace: z.string().optional(),
      runId: z.string().optional(),
      status: z.string().optional(),
    }).parse(req.query);

    const where: Record<string, unknown> = { projectId };
    if (query.namespace) where.namespace = query.namespace;
    if (query.runId) where.runId = query.runId;
    if (query.status) where.status = query.status;

    return {
      resources: await prisma.dataResource.findMany({ where, orderBy: { createdAt: 'desc' }, take: 500 }),
    };
  });

  // ---------- 管理员复核后重新清理 ----------

  app.post('/api/data-resources/:id/retry-cleanup', async (req, reply) => {
    const id = param(req, 'id');
    const resource = await prisma.dataResource.findUnique({ where: { id } });
    if (!resource) throw new ApiError('NOT_FOUND', '资源不存在');
    await findProject(req, resource.projectId, 'ADMIN');

    if (!['cleanup_failed', 'unknown', 'success'].includes(resource.status)) {
      throw new ApiError('CONFLICT', `资源状态为 ${resource.status}，仅在 cleanup_failed/unknown/success 状态可重新清理`);
    }

    const result = await enqueue(resource.projectId, 'DATA_CLEANUP', {
      pluginId: resource.pluginId,
      namespace: resource.namespace,
      resourceIds: [resource.id],
    });
    reply.code(202);
    return result;
  });
}
