import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { EnvironmentRuntime } from '@ai-qa/contracts';
import { ApiError } from './errors.js';
/** The project namespace prevents one project admin from selecting another project's secrets. */
export function projectSecretPrefix(projectId: string) {
  return `AIQA_TARGET_${createHash('sha256').update(projectId).digest('hex').slice(0,16).toUpperCase()}_`;
}
export function validateSecretNamespace(projectId: string, runtime: z.infer<typeof EnvironmentRuntime>) {
  const prefix=projectSecretPrefix(projectId);
  for(const refs of Object.values(runtime.secretRefs)) for(const name of Object.values(refs)) {
    if(name&&!name.startsWith(prefix)) throw new ApiError('VALIDATION_ERROR',`凭据引用必须属于当前项目：${prefix}`);
  }
}
