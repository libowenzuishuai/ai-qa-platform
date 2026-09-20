import { checkDestination } from '@ai-qa/test-runtime';
import { EnvironmentRuntime } from '@ai-qa/contracts';
import type { PrismaClient } from '@prisma/client';
import type { ArtifactStore } from '@ai-qa/artifact-store';

/** Target deployment exposes its immutable build identity. Check before AND after testing. */
export async function probeBuild(prisma: PrismaClient, store: ArtifactStore, runId: string, phase: 'before' | 'after') {
  const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
  const env = run.environmentSnapshot as Record<string, any>;
  const runtime = EnvironmentRuntime.parse(env.runtime ?? {});
  let observed: string | null = null, reason = '未配置部署版本查询';
  if (runtime.buildProbe && run.buildId) {
    const target = new URL(runtime.buildProbe.path, env.baseUrl).href;
    if (!checkDestination(target, { allowedOrigins: env.allowedOrigins, dependencyOrigins: [] }).allowed) throw new Error('构建查询地址越界');
    try {
      const response = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'cache-control': 'no-cache' } });
      if (!response.ok) throw new Error('版本查询失败');
      const reader = response.body!.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 16384) throw new Error('版本响应超限'); chunks.push(part.value); } } finally { await reader.cancel(); }
      let value: unknown = JSON.parse(Buffer.concat(chunks).toString());
      for (const key of runtime.buildProbe.field.split('.')) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
      if (typeof value === 'string' && value.length <= 200) observed = value;
      reason = observed === run.buildId ? '运行实例返回的版本与目标一致' : '运行版本缺失或不匹配';
    } catch { reason = '无法从运行实例核验版本'; }
  }
  const record = { phase, observed, expected: run.buildId, verified: !!observed && observed === run.buildId, reason, checkedAt: new Date().toISOString() };
  const saved = store.put({ runId, attemptId: 'build', filename: `${phase}.json`, data: Buffer.from(JSON.stringify(record)) });
  const artifact = await prisma.artifact.create({ data: { projectId: run.projectId, type: 'BUILD_IDENTITY', storageKey: saved.storageKey, checksum: saved.checksum } });
  const prior = run.buildVerification as Record<string, unknown>;
  await prisma.run.updateMany({ where: { id: runId, lifecycle: { in: ['PREPARING','RUNNING'] } }, data: { buildVerification: { ...prior, [phase]: { ...record, evidenceId: artifact.id } } as never } });
}
