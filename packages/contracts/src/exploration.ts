import {z} from 'zod';
import {EntityId} from './common.js';
export const ExplorationRequest=z.object({
 environmentId:EntityId,idempotencyKey:z.string().min(8).max(120),
 // These exact GET entry points are approved by the user. Discovered links are suggestions only.
 paths:z.array(z.string().min(1).max(1000).refine(p=>p.startsWith('/')&&!p.startsWith('//')&&!/[\\?#\r\n]/.test(p))).min(1).max(10),
 maxDurationMs:z.number().int().min(1000).max(120000).default(60000),
}).strict();
export const ExplorationResult=z.object({artifactId:EntityId,pageCount:z.number().int().min(0).max(10),stopReason:z.enum(['COMPLETED','NO_PROGRESS','AUTH_REQUIRED','SCOPE_BLOCKED','BUDGET_EXCEEDED'])});
