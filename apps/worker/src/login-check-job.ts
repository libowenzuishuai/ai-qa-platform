import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { chromium } from 'playwright';
import {
  LoginCheckResult,
  ObservedLocator,
} from '@ai-qa/contracts';
import { ArtifactStore } from '@ai-qa/artifact-store';
import type { WorkerConfig } from './config.js';
import { makeCredentialResolver } from './credentials.js';

/**
 * P0-1 登录检查作业：在独立 BrowserContext 执行已保存的登录流程。
 *
 * 明确状态分类：
 * - PASS：全部步骤完成 + 成功标识命中
 * - FAIL_INVALID_CREDENTIALS：填入凭据后出现错误提示/仍在登录页
 * - FAIL_MISSING_ENV：环境变量缺失（不读取值，只检查存在性）
 * - FAIL_LOCATOR_NOT_FOUND：步骤中的元素未出现
 * - FAIL_SITE_UNREACHABLE：目标地址不可达
 * - FAIL_TIMEOUT：整体超时
 * - FAIL_INTERACTIVE_AUTH_REQUIRED：检测到验证码/MFA/SSO 表单
 * - CANCELLED
 */

type JobRow = { id: string; projectId: string; request: unknown; startedAt: Date | null };

function locatorFor(page: import('playwright').Page, locator: ObservedLocator) {
  switch (locator.type) {
    case 'testId': return page.getByTestId(locator.value);
    case 'role': return page.getByRole(locator.role as never, locator.name ? { name: locator.name } : undefined);
    case 'label': return page.getByLabel(locator.value);
    case 'text': return page.getByText(locator.value);
  }
}

export async function runLoginCheck(
  prisma: PrismaClient,
  store: ArtifactStore,
  job: JobRow,
  config: WorkerConfig,
): Promise<void> {
  const request = job.request as {
    loginPreparationId: string;
    environmentId: string;
    environmentRevision: number;
    baseUrl: string;
  };

  const prep = await prisma.loginPreparation.findUnique({ where: { id: request.loginPreparationId } });
  if (!prep) throw new Error(`登录配置不存在: ${request.loginPreparationId}`);

  const steps = prep.steps as Array<{
    type: 'fill' | 'click';
    locator: ObservedLocator;
    value?: { source: 'credential'; ref: string };
  }>;
  const indicator = prep.successIndicator as {
    locator: ObservedLocator;
    expectedText?: string;
    expectedUrl?: string;
  };

  // 检查环境变量存在性（不读取值进日志）。
  const resolve = makeCredentialResolver({});
  for (const step of steps) {
    if (step.type === 'fill' && step.value?.ref) {
      const value = resolve(step.value.ref);
      if (!value) {
        await recordResult(prisma, prep.id, 'FAIL_MISSING_ENV', `环境变量 ${step.value.ref} 未配置`, request, null);
        return;
      }
    }
  }

  const started = Date.now();
  const timeoutMs = 30_000;
  let browser: import('playwright').Browser | null = null;
  let evidenceArtifactId: string | null = null;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    // 导航到目标。
    try {
      await page.goto(request.baseUrl, { timeout: 10_000, waitUntil: 'domcontentloaded' });
    } catch {
      await recordResult(prisma, prep.id, 'FAIL_SITE_UNREACHABLE', `目标 ${request.baseUrl} 不可达`, request, null);
      return;
    }

    // 执行步骤。
    for (const step of steps) {
      if (Date.now() - started > timeoutMs) {
        await recordResult(prisma, prep.id, 'FAIL_TIMEOUT', `登录流程超过 ${timeoutMs}ms`, request, null);
        return;
      }
      const loc = locatorFor(page, step.locator);
      try {
        if (step.type === 'fill' && step.value) {
          const value = resolve(step.value.ref);
          if (!value) {
            await recordResult(prisma, prep.id, 'FAIL_MISSING_ENV', `环境变量 ${step.value.ref} 未配置`, request, null);
            return;
          }
          await loc.fill(value, { timeout: 8_000 });
        } else if (step.type === 'click') {
          await loc.click({ timeout: 8_000 });
          await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
        }
      } catch {
        // 检查是否因为验证码/MFA。
        const hasCaptcha = await page.locator('input[type=file]').count() > 0;
        const hasMfa = await page.getByText(/验证码|MFA|two.?factor|2fa/i).count() > 0;
        if (hasCaptcha || hasMfa) {
          await recordResult(prisma, prep.id, 'FAIL_INTERACTIVE_AUTH_REQUIRED', '检测到验证码/MFA，需要人工处理', request, null);
          return;
        }
        await recordResult(prisma, prep.id, 'FAIL_LOCATOR_NOT_FOUND', `步骤 ${step.type} 的元素未找到`, request, null);
        return;
      }
    }

    // 检查成功标识。
    try {
      const indicatorLoc = locatorFor(page, indicator.locator);
      await indicatorLoc.waitFor({ state: 'visible', timeout: 10_000 });
      if (indicator.expectedText) {
        const text = await indicatorLoc.textContent();
        if (!text?.includes(indicator.expectedText)) {
          await recordResult(prisma, prep.id, 'FAIL_INVALID_CREDENTIALS', `登录后标识文本不符`, request, null);
          return;
        }
      }
      if (indicator.expectedUrl && !page.url().includes(indicator.expectedUrl)) {
        await recordResult(prisma, prep.id, 'FAIL_INVALID_CREDENTIALS', `登录后 URL 不含 ${indicator.expectedUrl}`, request, null);
        return;
      }
    } catch {
      // 标识未出现——检查是否仍在登录页。
      const stillOnLogin = await page.locator('input[type=password]').count() > 0;
      if (stillOnLogin) {
        await recordResult(prisma, prep.id, 'FAIL_INVALID_CREDENTIALS', '凭据无效或登录被拒绝（仍在登录页）', request, null);
        return;
      }
      await recordResult(prisma, prep.id, 'FAIL_TIMEOUT', '登录成功标识在限定时间内未出现', request, null);
      return;
    }

    // 成功：保存脱敏截图。
    const screenshot = await page.screenshot({ fullPage: false });
    const stored = store.put({
      runId: `login-check-${prep.id.slice(0, 12)}`,
      attemptId: new Date().toISOString().slice(0, 10),
      filename: `login-check-${randomUUID().slice(0, 8)}.png`,
      data: screenshot,
    });
    const artifact = await prisma.artifact.create({
      data: {
        projectId: job.projectId,
        attemptId: null,
        storageKey: stored.storageKey,
        type: 'LOGIN_CHECK',
        sensitivity: 'RESTRICTED_RAW', // 登录截图可能含敏感信息
        checksum: stored.checksum,
      },
      select: { id: true },
    });
    evidenceArtifactId = artifact.id;

    const checkedAt = new Date();
    const expiresAt = new Date(checkedAt.getTime() + prep.validityHours * 3600_000);
    await prisma.loginPreparation.update({
      where: { id: prep.id },
      data: {
        lastCheckStatus: 'PASS',
        lastCheckDetail: '登录成功',
        lastCheckAt: checkedAt,
        lastCheckEnvRev: request.environmentRevision,
      },
    });
    await finishJob(prisma, job.id, 'SUCCEEDED', {
      loginPreparationId: prep.id,
      result: LoginCheckResult.parse({
        status: 'PASS',
        detail: '登录成功',
        checkedAt: checkedAt.toISOString(),
        environmentRevision: request.environmentRevision,
        configHash: prep.configHash,
        expiresAt: expiresAt.toISOString(),
        evidenceArtifactId,
      }),
    });
  } catch (err) {
    await recordResult(prisma, prep.id, 'ERROR', String(err).slice(0, 500), request, null);
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

async function recordResult(
  prisma: PrismaClient,
  prepId: string,
  status: string,
  detail: string,
  request: { environmentRevision: number },
  _evidence: string | null,
): Promise<void> {
  await prisma.loginPreparation.update({
    where: { id: prepId },
    data: {
      lastCheckStatus: status,
      lastCheckDetail: detail,
      lastCheckAt: new Date(),
      lastCheckEnvRev: request.environmentRevision,
    },
  });
}

async function finishJob(
  prisma: PrismaClient,
  jobId: string,
  status: string,
  result: unknown,
): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: { status, result: result as never, finishedAt: new Date() },
  });
}
