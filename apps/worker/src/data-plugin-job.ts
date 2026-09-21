import type { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { HttpTemplateParams } from '@ai-qa/contracts';
import { checkDestination } from '@ai-qa/test-runtime';

/**
 * P0-2 数据准备与清理 worker。
 *
 * HTTP 模板插件：
 * - prepare：按模板向目标环境发请求（仅允许白名单 origin），登记资源。
 * - cleanup：对已登记资源发反向请求（DELETE 或模板定义的清理路径）。
 * - inspect：查询资源状态。
 *
 * 幂等：相同 (namespace, externalRef, action, fingerprint) 不重复创建。
 * 清理失败保留残留资源状态，不能静默 PASS。
 */

type JobRow = { id: string; projectId: string; request: unknown; startedAt: Date | null };

function fingerprint(x: unknown): string {
  return createHash('sha256').update(JSON.stringify(x)).digest('hex');
}

function externalRefFor(params: { method: string; path: string }): string {
  return `${params.method} ${params.path}`;
}

/** 仅允许白名单 origin 内的 HTTP 请求。 */
function resolveUrl(baseUrl: string, path: string): { ok: true; url: string } | { ok: false; error: string } {
  try {
    const url = new URL(path, baseUrl);
    const policy = { allowedOrigins: [baseUrl], dependencyOrigins: [] };
    if (!checkDestination(url.toString(), policy).allowed) {
      return { ok: false, error: `目标 ${url.origin} 不在环境白名单内` };
    }
    return { ok: true, url: url.toString() };
  } catch {
    return { ok: false, error: `无法解析目标 ${path}` };
  }
}

export async function runDataPrepare(
  prisma: PrismaClient,
  job: JobRow,
): Promise<void> {
  const req = job.request as {
    pluginId: string;
    namespace: string;
    params: Record<string, unknown>;
    runId?: string | null;
    attemptId?: string | null;
  };

  const plugin = await prisma.dataPlugin.findFirst({ where: { id: req.pluginId, projectId: job.projectId, enabled: true } });
  if (!plugin) throw Object.assign(new Error('插件不存在或已禁用'), { code: 'VALIDATION_ERROR' });

  const env = await prisma.environment.findFirst({ where: { projectId: job.projectId, isProduction: false } });
  if (!env) throw Object.assign(new Error('环境不存在'), { code: 'VALIDATION_ERROR' });

  if (plugin.kind !== 'http-request') {
    throw Object.assign(new Error(`暂不支持插件类型 ${plugin.kind}`), { code: 'UNSUPPORTED' });
  }

  const parsed = HttpTemplateParams.safeParse(req.params);
  if (!parsed.success) {
    throw Object.assign(new Error('参数不符合 HTTP 模板 schema'), {
      code: 'VALIDATION_ERROR',
      details: parsed.error.issues.slice(0, 3),
    });
  }
  const params = parsed.data;

  const resolved = resolveUrl(env.baseUrl, params.path);
  if (!resolved.ok) {
    throw Object.assign(new Error(resolved.error), { code: 'VALIDATION_ERROR' });
  }

  const ref = externalRefFor(params);
  const fp = fingerprint(req.params);

  // 幂等：同 namespace+ref+action+fingerprint 已成功 → 直接返回。
  const existing = await prisma.dataResource.findUnique({
    where: { namespace_externalRef_action_actionFingerprint: { namespace: req.namespace, externalRef: ref, action: 'prepare', actionFingerprint: fp } },
  });
  if (existing?.status === 'success') {
    await finishJob(prisma, job.id, 'SUCCEEDED', { resourceIds: [existing.id], alreadyDone: true });
    return;
  }

  const resource = await prisma.dataResource.upsert({
    where: { namespace_externalRef_action_actionFingerprint: { namespace: req.namespace, externalRef: ref, action: 'prepare', actionFingerprint: fp } },
    create: {
      projectId: job.projectId,
      runId: req.runId ?? null,
      attemptId: req.attemptId ?? null,
      namespace: req.namespace,
      pluginId: plugin.id,
      externalRef: ref,
      action: 'prepare',
      actionFingerprint: fp,
      status: 'pending',
    },
    update: { status: 'pending', detail: null },
  });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs);
    const response = await fetch(resolved.url, {
      method: params.method,
      headers: { 'content-type': 'application/json' },
      body: params.body ? JSON.stringify(params.body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);

    const status = response.ok ? 'success' : 'failed';
    const detail = response.ok
      ? `${params.method} ${params.path} → ${response.status}`
      : `${params.method} ${params.path} → ${response.status} ${response.statusText}`;

    await prisma.dataResource.update({
      where: { id: resource.id },
      data: { status, detail },
    });
    await finishJob(prisma, job.id, response.ok ? 'SUCCEEDED' : 'FAILED', {
      resourceIds: [resource.id],
      status,
      detail,
    });
  } catch (err) {
    await prisma.dataResource.update({
      where: { id: resource.id },
      data: { status: 'unknown', detail: String(err).slice(0, 500) },
    });
    await finishJob(prisma, job.id, 'FAILED', { resourceIds: [resource.id], status: 'unknown' });
  }
}

export async function runDataCleanup(
  prisma: PrismaClient,
  job: JobRow,
): Promise<void> {
  const req = job.request as {
    pluginId: string;
    namespace: string;
    resourceIds?: string[];
  };

  const plugin = await prisma.dataPlugin.findFirst({ where: { id: req.pluginId, projectId: job.projectId } });
  if (!plugin) throw Object.assign(new Error('插件不存在'), { code: 'VALIDATION_ERROR' });

  // 找待清理资源。
  const resources = req.resourceIds?.length
    ? await prisma.dataResource.findMany({
        where: { id: { in: req.resourceIds }, projectId: job.projectId, namespace: req.namespace },
      })
    : await prisma.dataResource.findMany({
        where: { projectId: job.projectId, namespace: req.namespace, action: 'prepare', status: 'success' },
      });

  if (resources.length === 0) {
    await finishJob(prisma, job.id, 'SUCCEEDED', { cleaned: 0, note: '没有待清理资源' });
    return;
  }

  const env = await prisma.environment.findFirst({ where: { projectId: job.projectId, isProduction: false } });
  if (!env) throw Object.assign(new Error('环境不存在'), { code: 'VALIDATION_ERROR' });

  let cleaned = 0;
  let failures = 0;

  for (const resource of resources) {
    try {
      // HTTP 模板：尝试 DELETE 同一路径。
      const [method, path] = resource.externalRef.split(' ', 2);
      const resolved = resolveUrl(env.baseUrl, path ?? '/');
      if (!resolved.ok) {
        await prisma.dataResource.update({
          where: { id: resource.id },
          data: { status: 'cleanup_failed', detail: `清理目标不在白名单：${resolved.error}` },
        });
        failures++;
        continue;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const response = await fetch(resolved.url, { method: 'DELETE', signal: controller.signal });
      clearTimeout(timer);

      // 2xx 或 404 = 已清理（404 视为"本来就不存在"）。
      if (response.ok || response.status === 404) {
        await prisma.dataResource.update({
          where: { id: resource.id },
          data: { status: 'cleaned', detail: `DELETE ${path} → ${response.status}` },
        });
        cleaned++;
      } else {
        await prisma.dataResource.update({
          where: { id: resource.id },
          data: { status: 'cleanup_failed', detail: `DELETE ${path} → ${response.status} ${response.statusText}` },
        });
        failures++;
      }
    } catch (err) {
      await prisma.dataResource.update({
        where: { id: resource.id },
        data: { status: 'cleanup_failed', detail: String(err).slice(0, 500) },
      });
      failures++;
    }
  }

  await finishJob(prisma, job.id, failures > 0 ? 'FAILED' : 'SUCCEEDED', {
    cleaned,
    failures,
    resourceIds: resources.map(r => r.id),
  });
}

async function finishJob(prisma: PrismaClient, jobId: string, status: string, result: unknown): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: { status, result: result as never, finishedAt: new Date() },
  });
}
