import {z} from 'zod';
import {CodeCheckRequest} from './product.js';
export const GitHubConnectRequest=z.object({repository:z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)}).strict();
export const GitHubCiConfig=z.object({enabled:z.boolean(),branch:z.string().min(1).max(200).refine(s=>!s.startsWith('/')&&!s.includes('..')&&!/[\s~^:?*\[\\]/.test(s)),templateId:z.string().min(1),kind:CodeCheckRequest.shape.kind.refine(k=>k!=='NODE_HTTP','部署模板需独立确认配置，不能作为默认 CI 检查'),subdirectory:CodeCheckRequest.shape.subdirectory,timeoutSeconds:CodeCheckRequest.shape.timeoutSeconds,installDependencies:CodeCheckRequest.shape.installDependencies}).strict();
export const GitHubIntegrationStatus=z.enum(['ACTIVE','REVOKED']);
export const GitHubDeliveryStatus=z.enum(['QUEUED','RUNNING','WAITING','COMPLETED','IGNORED','FAILED','WRITE_UNCERTAIN']);
