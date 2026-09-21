import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import {
  LoginPreparationConfig,
  LoginCheckStatus,
} from '@ai-qa/contracts';
import { requireAuth, requireProjectAccess } from './auth.js';
import { ApiError } from './errors.js';

/**
 * P0-1 账号与准备中心 API。
 *
 * - GET/PUT /api/projects/:id/environments/:envId/login-preparations
 * - GET /api/projects/:id/environments/:envId/login-preparations/:role
 * - POST /api/projects/:id/environments/:envId/login-preparations/:role/check
 * - GET /api/projects/:id/preparation-summary
 */

export function registerPreparationRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  jobs: Pick<Queue, 'add'>,
) {
  const param = (req: FastifyRequest, key: string) =>
    z.record(z.string()).parse(req.params)[key]!;

  function computeConfigHash(config: {
    role: string;
    credentialRef: string;
    steps: unknown;
    successIndicator: unknown;
  }): string {
    return createHash('sha256')
      .update(JSON.stringify({
        role: config.role,
        credentialRef: config.credentialRef,
        steps: config.steps,
        successIndicator: config.successIndicator,
      }))
      .digest('hex');
  }

  async function findEnv(req: FastifyRequest, projectId: string, environmentId: string) {
    const env = await prisma.environment.findFirst({
      where: { id: environmentId, projectId, isProduction: false },
    });
    if (!env) throw new ApiError('NOT_FOUND', '环境不存在或不属于该项目');
    await requireProjectAccess(prisma, req, projectId, 'LEAD');
    return env;
  }

  // ---------- CRUD ----------

  app.get('/api/projects/:id/environments/:envId/login-preparations', async req => {
    const projectId = param(req, 'id');
    const environmentId = param(req, 'envId');
    await findEnv(req, projectId, environmentId);
    const rows = await prisma.loginPreparation.findMany({
      where: { projectId, environmentId },
      orderBy: { role: 'asc' },
    });
    return {
      preparations: rows.map(row => ({
        ...row,
        expired: Boolean(
          row.lastCheckStatus === 'PASS' && row.lastCheckAt &&
          row.lastCheckAt.getTime() + row.validityHours * 3600_000 < Date.now(),
        ),
      })),
    };
  });

  app.put('/api/projects/:id/environments/:envId/login-preparations/:role', async req => {
    const projectId = param(req, 'id');
    const environmentId = param(req, 'envId');
    const role = param(req, 'role');
    const env = await findEnv(req, projectId, environmentId);

    // 解析并校验配置（LoginPreparationConfig 会拒绝任意脚本）。
    const raw = { ...z.object({ environmentId: z.string() }).parse(req.body), role } as Record<string, unknown>;
    const config = LoginPreparationConfig.parse(raw);
    const configHash = computeConfigHash(config);

    // 检查 credentialRef 在 EnvironmentRuntime.secretRefs 中已登记。
    const runtime = env.secretRefs as Record<string, unknown> | null;
    if (!runtime || !(config.credentialRef in runtime)) {
      throw new ApiError('VALIDATION_ERROR', `凭据引用 "${config.credentialRef}" 未在环境 secretRefs 中登记`, {
        field: 'credentialRef',
        hint: '请先由管理员在环境运行时配置中登记该角色的环境变量引用',
      });
    }

    const saved = await prisma.loginPreparation.upsert({
      where: { projectId_environmentId_role: { projectId, environmentId, role } },
      create: {
        projectId, environmentId, role,
        credentialRef: config.credentialRef,
        steps: config.steps as never,
        successIndicator: config.successIndicator as never,
        configHash,
        validityHours: config.validityHours,
        lastCheckStatus: 'NEVER_CHECKED',
      },
      update: {
        credentialRef: config.credentialRef,
        steps: config.steps as never,
        successIndicator: config.successIndicator as never,
        configHash,
        validityHours: config.validityHours,
        // 配置变更后上次检查失效。
        lastCheckStatus: 'NEVER_CHECKED',
        lastCheckDetail: null,
        lastCheckAt: null,
        lastCheckEnvRev: null,
      },
    });
    await prisma.auditEvent.create({
      data: {
        actorId: requireAuth(req).userId,
        action: 'loginPreparation.upsert',
        entityType: 'LoginPreparation',
        entityId: saved.id,
      },
    });
    return saved;
  });

  app.delete('/api/projects/:id/environments/:envId/login-preparations/:role', async req => {
    const projectId = param(req, 'id');
    const environmentId = param(req, 'envId');
    const role = param(req, 'role');
    await findEnv(req, projectId, environmentId);
    const deleted = await prisma.loginPreparation.deleteMany({
      where: { projectId, environmentId, role },
    });
    if (!deleted.count) throw new ApiError('NOT_FOUND', '登录配置不存在');
    return { ok: true };
  });

  // ---------- 登录检查（异步作业） ----------

  app.post('/api/projects/:id/environments/:envId/login-preparations/:role/check', async (req, reply) => {
    const projectId = param(req, 'id');
    const environmentId = param(req, 'envId');
    const role = param(req, 'role');
    await findEnv(req, projectId, environmentId);

    const prep = await prisma.loginPreparation.findUnique({
      where: { projectId_environmentId_role: { projectId, environmentId, role } },
    });
    if (!prep) throw new ApiError('NOT_FOUND', `角色 "${role}" 未配置登录流程`);

    const env = await prisma.environment.findUniqueOrThrow({ where: { id: environmentId } });
    const job = await prisma.job.create({
      data: {
        projectId,
        kind: 'LOGIN_CHECK',
        fingerprint: randomUUID(),
        request: {
          loginPreparationId: prep.id,
          environmentId,
          environmentRevision: env.revision,
          baseUrl: env.baseUrl,
        } as never,
      },
    });
    try {
      await jobs.add('run', { jobId: job.id }, { jobId: `job-${job.id}`, removeOnComplete: true });
    } catch {
      // 作业已落库，对账会补投。
    }
    reply.code(202);
    return { jobId: job.id };
  });

  // ---------- 准备总览 ----------

  app.get('/api/projects/:id/preparation-summary', async req => {
    const projectId = param(req, 'id');
    await requireProjectAccess(prisma, req, projectId, 'VIEWER');

    const environments = await prisma.environment.findMany({
      where: { projectId, isProduction: false },
    });
    const preps = await prisma.loginPreparation.findMany({ where: { projectId } });

    const now = Date.now();
    const rolesByEnv = new Map<string, Array<{
      role: string;
      configured: boolean;
      checked: boolean;
      expired: boolean;
      status: string;
      lastCheckAt: Date | null;
    }>>();

    // 从环境运行时配置中找到已声明的角色集合。
    for (const env of environments) {
      const secretRefs = (env.secretRefs ?? {}) as Record<string, unknown>;
      const declaredRoles = new Set(Object.keys(secretRefs));
      const envPreps = preps.filter(p => p.environmentId === env.id);
      const list: Array<{ role: string; configured: boolean; checked: boolean; expired: boolean; status: string; lastCheckAt: Date | null }> = [];

      for (const role of new Set([...declaredRoles, ...envPreps.map(p => p.role)])) {
        const prep = envPreps.find(p => p.role === role);
        const isPass = prep?.lastCheckStatus === 'PASS';
        const isExpired = Boolean(
          isPass && prep?.lastCheckAt && prep.lastCheckAt.getTime() + (prep.validityHours || 24) * 3600_000 < now,
        );
        list.push({
          role,
          configured: Boolean(prep),
          checked: Boolean(prep?.lastCheckAt),
          expired: isExpired,
          status: prep?.lastCheckStatus ?? 'NEVER_CHECKED',
          lastCheckAt: prep?.lastCheckAt ?? null,
        });
      }
      rolesByEnv.set(env.id, list);
    }

    return {
      environments: environments.map(env => ({
        id: env.id,
        name: env.name,
        baseUrl: env.baseUrl,
        revision: env.revision,
        roles: rolesByEnv.get(env.id) ?? [],
      })),
    };
  });
}
