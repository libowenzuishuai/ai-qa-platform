import { z } from 'zod';
import { ObservedLocator } from './test-plan.js';
import { EntityId } from './common.js';

/**
 * P0-1 账号与准备中心契约。
 *
 * - LoginPreparationConfig：角色登录配置（凭据引用 + fill/click 步骤 + 成功标识）
 * - LoginCheckJobRequest：检查登录（可取消、有界异步作业）
 * - LoginCheckResult：检查结果（明确状态，不猜测）
 * - PreparationSummary：准备页四项分列
 */

/** 登录步骤：受限 fill/click，复用 ObservedLocator，不允许任意脚本。 */
export const LoginStep = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('fill'),
    locator: ObservedLocator,
    /** 只允许凭据引用（secretRef.role.username / role.password）。 */
    value: z.object({ source: z.literal('credential'), ref: z.string().regex(/^[a-zA-Z][\w-]*\.(username|password)$/) }).strict(),
  }).strict(),
  z.object({ type: z.literal('click'), locator: ObservedLocator }).strict(),
]);

/** 登录成功标识：页面上的稳定元素/文本。 */
export const SuccessIndicator = z.object({
  locator: ObservedLocator,
  expectedText: z.string().max(500).optional(),
  expectedUrl: z.string().regex(/^\/(?!\/)[^\\\x00-\x1f]*$/).optional(),
});

export const LoginPreparationConfig = z.object({
  environmentId: EntityId,
  loginPath: z.string().regex(/^\/(?!\/)[^\\\x00-\x1f]*$/).default('/'),
  timeoutMs: z.number().int().min(1000).max(60000).default(30000),
  role: z.string().min(1).max(50),
  credentialRef: z.string().regex(/^[a-zA-Z][\w-]*$/),
  steps: z.array(LoginStep).min(1).max(20),
  successIndicator: SuccessIndicator,
  invalidIndicator: ObservedLocator.optional(),
  interactiveIndicator: ObservedLocator.optional(),
  /** 检查有效期（小时）。 */
  validityHours: z.number().int().min(1).max(168).default(24),
}).strict();

export const LoginCheckStatus = z.enum([
  'PASS',
  'FAIL_INVALID_CREDENTIALS',
  'FAIL_MISSING_ENV',
  'FAIL_LOCATOR_NOT_FOUND',
  'FAIL_SITE_UNREACHABLE',
  'FAIL_TIMEOUT',
  'FAIL_INTERACTIVE_AUTH_REQUIRED',
  'CANCELLED',
  'ERROR',
]);

export const LoginCheckResult = z.object({
  status: LoginCheckStatus,
  detail: z.string().max(1000),
  checkedAt: z.string().datetime(),
  environmentRevision: z.number().int(),
  configHash: z.string(),
  /** 检查通过时的过期时间。 */
  expiresAt: z.string().datetime().nullable(),
  evidenceArtifactId: z.string().nullable(),
});
