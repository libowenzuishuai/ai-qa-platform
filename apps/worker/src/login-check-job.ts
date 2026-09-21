import type { PrismaClient, Prisma } from "@prisma/client";
import { chromium, type Page, type Locator } from "playwright";
import {
  EnvironmentRuntime,
  LoginPreparationConfig,
  LoginCheckResult,
  type ObservedLocator,
} from "@ai-qa/contracts";
import { startPolicyProxy, checkDestination } from "@ai-qa/test-runtime";
import type { ArtifactStore } from "@ai-qa/artifact-store";
import { makeCredentialResolver } from "./credentials.js";
import {
  validateLoginConfiguration,
  configHash,
} from "../../api/src/preparation-service.js";
export type PreparationJob = {
  id: string;
  projectId: string;
  request: unknown;
  startedAt: Date | null;
};
export type JobCommit = (
  db: PrismaClient,
  job: PreparationJob,
  persist: (tx: Prisma.TransactionClient) => Promise<void>,
) => Promise<void>;
export function loginLocator(page: Page, locator: ObservedLocator): Locator {
  if (locator.type === "testId") return page.getByTestId(locator.value);
  if (locator.type === "label")
    return page.getByLabel(locator.value, { exact: true });
  if (locator.type === "text")
    return page.getByText(locator.value, { exact: true });
  return page.getByRole(locator.role as never, {
    name: locator.name,
    exact: true,
  });
}
export async function runLoginCheck(
  prisma: PrismaClient,
  store: ArtifactStore,
  job: PreparationJob,
  commit: JobCommit,
  signal: AbortSignal,
) {
  const request = job.request as {
    loginPreparationId: string;
    configuration: unknown;
    configHash: string;
    environmentId: string;
    environmentRevision: number;
  };
  const config = LoginPreparationConfig.parse(request.configuration);
  const env = await prisma.environment.findFirstOrThrow({
    where: {
      id: request.environmentId,
      projectId: job.projectId,
      isProduction: false,
    },
  });
  if (
    env.revision !== request.environmentRevision ||
    configHash(config) !== request.configHash
  )
    throw new Error("登录配置或环境版本已改变");
  validateLoginConfiguration(config, env.runtime);
  const runtime = EnvironmentRuntime.parse(env.runtime),
    resolve = makeCredentialResolver(runtime.secretRefs);
  const policy = {
    allowedOrigins: env.allowedOrigins,
    dependencyOrigins: env.dependencyOrigins,
  };
  let status: typeof LoginCheckResult._type.status = "ERROR",
    detail = "登录检查未完成";
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let proxy: Awaited<ReturnType<typeof startPolicyProxy>> | undefined;
  const deadline = Date.now() + config.timeoutMs;
  const timeout = () => Math.max(1, Math.min(8000, deadline - Date.now()));
  let expired = false;
  const close = () => {
    void browser?.close().catch(() => undefined);
  };
  const timer = setTimeout(() => {
    expired = true;
    close();
  }, config.timeoutMs);
  signal.addEventListener("abort", close);
  try {
    const missing = config.steps.some(
      (s) => s.type === "fill" && !resolve(s.value.ref),
    );
    if (missing) {
      status = "FAIL_MISSING_ENV";
      detail = "已登记账号的环境变量未提供";
    } else {
      proxy = await startPolicyProxy(policy);
      if (signal.aborted || expired) throw new Error("stopped");
      browser = await chromium.launch({
        headless: true,
        proxy: { server: "per-context" },
      });
      if (signal.aborted || expired) throw new Error("stopped");
      const context = await browser.newContext({
        proxy: { server: proxy.url },
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      page.setDefaultTimeout(timeout());
      const url = new URL(config.loginPath, env.baseUrl).href;
      if (!checkDestination(url, policy).allowed)
        throw new Error("登录路径越界");
      status = "FAIL_SITE_UNREACHABLE";
      detail = "登录页面不可达";
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: timeout(),
      });
      const interactive = async () =>
        !!config.interactiveIndicator &&
        (await loginLocator(page, config.interactiveIndicator).isVisible());
      const invalid = async () =>
        !!config.invalidIndicator &&
        (await loginLocator(page, config.invalidIndicator).isVisible());
      for (const step of config.steps) {
        if (signal.aborted || expired) throw new Error("stopped");
        if (await interactive()) {
          status = "FAIL_INTERACTIVE_AUTH_REQUIRED";
          detail = "需要交互认证";
          break;
        }
        status = "FAIL_LOCATOR_NOT_FOUND";
        detail = "登录步骤目标未出现或不唯一";
        const target = loginLocator(page, step.locator);
        await target.waitFor({
          state: "visible",
          timeout: Math.max(1, Math.floor(timeout() / 2)),
        });
        if ((await target.count()) !== 1) throw new Error("目标不唯一");
        status = "FAIL_TIMEOUT";
        detail = "登录动作或页面跳转超时";
        if (step.type === "fill")
          await target.fill(resolve(step.value.ref)!, { timeout: timeout() });
        else await target.click({ timeout: timeout() });
      }
      while (!signal.aborted && !expired && Date.now() < deadline) {
        if (await interactive()) {
          status = "FAIL_INTERACTIVE_AUTH_REQUIRED";
          detail = "需要交互认证";
          break;
        }
        if (await invalid()) {
          status = "FAIL_INVALID_CREDENTIALS";
          detail = "页面明确拒绝账号认证";
          break;
        }
        status = "FAIL_TIMEOUT";
        detail = "未在预算内观察到登录成功标识";
        const indicator = loginLocator(page, config.successIndicator.locator);
        if ((await indicator.count()) === 1 && (await indicator.isVisible())) {
          const textMatches =
            config.successIndicator.expectedText === undefined ||
            (await indicator.innerText()) ===
              config.successIndicator.expectedText;
          const urlMatches =
            !config.successIndicator.expectedUrl ||
            page.url() ===
              new URL(config.successIndicator.expectedUrl, env.baseUrl).href;
          if (
            textMatches &&
            urlMatches &&
            checkDestination(page.url(), policy).allowed
          ) {
            status = "PASS";
            detail = "成功标识已验证；正式运行仍会验证身份";
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  } catch {
    /* Never persist browser errors: they may contain entered secrets or page text. */
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", close);
    await browser?.close().catch(() => undefined);
    await proxy?.close();
  }
  if (signal.aborted) {
    status = "CANCELLED";
    detail = "检查被取消或租约失效";
  } else if (expired) {
    status = "FAIL_TIMEOUT";
    detail = "登录检查时间预算耗尽";
  }
  const checkedAt = new Date();
  // Deliberately record metadata only. Raw login screenshots and traces can contain echoed credentials.
  const result = LoginCheckResult.parse({
    status,
    detail,
    checkedAt: checkedAt.toISOString(),
    environmentRevision: env.revision,
    configHash: request.configHash,
    expiresAt:
      status === "PASS"
        ? new Date(
            checkedAt.getTime() + config.validityHours * 3600000,
          ).toISOString()
        : null,
    evidenceArtifactId: null,
  });
  await commit(prisma, job, async (tx) => {
    const current = await tx.environment.findUniqueOrThrow({
      where: { id: env.id },
    });
    if (current.revision !== env.revision) throw new Error("环境版本已失效");
    await tx.loginPreparation.updateMany({
      where: {
        id: request.loginPreparationId,
        projectId: job.projectId,
        configHash: request.configHash,
        lastCheckJobId: job.id,
      },
      data: {
        lastCheckStatus: status,
        lastCheckDetail: detail,
        lastCheckAt: checkedAt,
        lastCheckEnvRev: env.revision,
      },
    });
    const stored = store.put({
      runId: "login-check",
      attemptId: job.id,
      filename: "result.json",
      data: Buffer.from(JSON.stringify(result)),
    });
    const artifact = await tx.artifact.create({
      data: {
        projectId: job.projectId,
        type: "LOGIN_CHECK",
        sensitivity: "NORMAL",
        storageKey: stored.storageKey,
        checksum: stored.checksum,
      },
    });
    await tx.job.update({
      where: { id: job.id },
      data: {
        status: "SUCCEEDED",
        finishedAt: new Date(),
        result: {
          loginPreparationId: request.loginPreparationId,
          result: { ...result, evidenceArtifactId: artifact.id },
        },
      },
    });
  });
}
