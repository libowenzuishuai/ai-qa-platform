import {startPolicyProxy, type PolicyProxy} from "@ai-qa/test-runtime";
import { randomUUID, createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CapabilityManifest } from "@ai-qa/contracts";
import {
  type CapabilityAdapter,
  type CapabilityContext,
  type CapabilityResult,
} from "../index.js";

/**
 * W05（EXE-01）平台 Web 观察能力（platform.web-observe，local-ts + Playwright）：
 * DOM（data-testid 优先）+ 当前截图联合观察。只读；截图写入调用方给的
 * artifactsDir 并返回 sha256（证据落盘，不在输出内联大对象）。
 */

export const WebObserveManifest: CapabilityManifest = {
  id: "platform.web-observe",
  version: "1.0.1",
  protocolVersion: "aiqa.capability/2",
  protocol: "local-ts",
  entrypointRef: "@ai-qa/adapter-sdk/samples/web-observe",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["baseUrl", "path"],
    properties: {
      baseUrl: { type: "string", minLength: 8, maxLength: 500 },
      path: { type: "string", minLength: 1, maxLength: 2000 },
      /** 观察的 testid（缺省 draft-title）。 */
      testId: { type: "string", maxLength: 200 },
      /** 观察标识（截图文件名组成部分）。 */
      observationRef: { type: "string", maxLength: 200 },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["status", "title", "text"],
    properties: {
      status: { type: "integer", minimum: 100, maximum: 599 },
      title: { type: "string", nullable: true },
      text: { type: "string", nullable: true },
      screenshotSha256: { type: "string", nullable: true },
      screenshotPath: { type: "string", nullable: true },
    },
  },
  effectClass: "READ",
  permissions: { network: "environment-allowlist", declaredOrigins: [], secrets: "none", secretRefs: [] },
  idempotency: "read_only",
  recovery: "read_only",
  cancel: "cooperative",
  timeoutMsMax: 30_000,
  humanName: "Web 观察能力（DOM+截图）",
  description: "加载页面读取 data-testid 元素文本并截图存证；只读。",
};

export class WebObserveAdapter implements CapabilityAdapter {
  readonly manifest = WebObserveManifest;

  async execute(input: unknown, ctx: CapabilityContext): Promise<CapabilityResult> {
    const { baseUrl, path, testId } = input as {
      baseUrl: string; path: string; testId?: string;
    };
    const artifactsDir=ctx.artifactDir;
    if(!artifactsDir) return failed("CONFIG_MISSING","宿主未提供受控证据目录");
    if(ctx.signal.aborted) return cancelled();
    if(ctx.deadline<=Date.now()) return failed("BUDGET_EXCEEDED","调用期限已到");
    const target = new URL(path, baseUrl);
    if (!ctx.allowedOrigins.includes(target.origin))
      return failed("FORBIDDEN", `目标 origin 不在白名单：${target.origin}`);
    let chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      return failed("DEPENDENCY_UNAVAILABLE", "playwright 不可用");
    }
    const timeout = Math.max(1, Math.min(ctx.deadline - Date.now(), this.manifest.timeoutMsMax));
    let browser: import("playwright").Browser | undefined;
    let proxy: PolicyProxy | undefined;
    const stop=()=>{void browser?.close().catch(()=>undefined);};
    ctx.signal.addEventListener("abort",stop,{once:true});
    let timedOut=false;
    const deadlineTimer=setTimeout(()=>{timedOut=true;stop();},timeout);
    try {
      proxy=await startPolicyProxy({allowedOrigins:ctx.allowedOrigins,dependencyOrigins:[]});
      browser = await chromium.launch({proxy:{server:"per-context"},timeout});
      if(ctx.signal.aborted) return cancelled();
      if(timedOut) return failed("MODEL_TIMEOUT","观察超时");
      const context=await browser.newContext({proxy:{server:proxy.url},serviceWorkers:"block"});
      const page = await context.newPage();
      page.setDefaultTimeout(timeout);
      // Observation grants no form submission, fetch mutation, or WebSocket write permission.
      let blockedMutation=false;
      await context.route("**/*",async route=>{
        if(!["GET","HEAD","OPTIONS"].includes(route.request().method())){blockedMutation=true;return route.abort("blockedbyclient");}
        return route.continue();
      });
      await context.routeWebSocket("**/*",socket=>socket.close());
      const response = await page.goto(target.toString(), {
        waitUntil: "domcontentloaded",
        timeout,
      });
      if (ctx.signal.aborted) return cancelled();
      if(!response || response.status()>=400 || Object.keys(proxy.stats().blocked).length) return failed("FORBIDDEN","页面不可访问或触发越界网络请求");
      const locator = page.getByTestId(testId ?? "draft-title");
      const count = await locator.count().catch(() => 0);
      // 歧义防御（EXE-01）：多个匹配不任取第一个。
      if (count > 1) return failed("AMBIGUOUS_MATCH", `testId ${testId ?? "draft-title"} 匹配 ${count} 个元素，拒绝任取`);
      const text = count === 1 ? (await locator.textContent()) ?? null : null;
      const title = await page.title();
      let screenshotSha256: string | null = null;
      let screenshotPath: string | null = null;
      if (artifactsDir) {
        const shot = await page.screenshot();
        screenshotSha256 = createHash("sha256").update(shot).digest("hex");
        mkdirSync(artifactsDir, { recursive: true });
        screenshotPath = join(artifactsDir, `observe-${randomUUID()}.png`);
        writeFileSync(screenshotPath, shot);
      }
      if(blockedMutation || Object.keys(proxy.stats().blocked).length) return failed("FORBIDDEN","观察期间触发写请求或越界子资源，已拦截");
      await browser.close();
      browser = undefined;
      return {
        status: "SUCCEEDED",
        output: { status: response?.status() ?? 0, title, text, screenshotSha256, screenshotPath },
        resourceKeys: [],
        retryable: false,
      };
    } catch (error) {
      if (ctx.signal.aborted) return cancelled();
      const name = error instanceof Error ? error.name : String(error);
      return failed(timedOut || name === "TimeoutError" ? "MODEL_TIMEOUT" : "DEPENDENCY_UNAVAILABLE", `观察失败：${name}`);
    } finally {
      clearTimeout(deadlineTimer);ctx.signal.removeEventListener("abort",stop);
      await browser?.close().catch(() => undefined);
      await proxy?.close();
    }
  }
}

function failed(code: string, message: string): CapabilityResult {
  return { status: "FAILED", output: null, resourceKeys: [], retryable: false, error: { code, message } };
}
function cancelled(): CapabilityResult {
  return { status: "CANCELLED", output: null, resourceKeys: [], retryable: false, error: { code: "CANCELLED", message: "调用已取消" } };
}
