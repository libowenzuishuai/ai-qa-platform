/// <reference lib="dom" />
import { chromium, type Page, type Locator } from 'playwright';
import { randomUUID, createHash } from 'node:crypto';
import { ObservationRequest, ObservationBundle, EnvironmentRuntime, type ObservedLocator, type PlanValue } from '@ai-qa/contracts';
import { startPolicyProxy, checkDestination } from '@ai-qa/test-runtime';
import { makeCredentialResolver } from './credentials.js';
import type { PrismaClient } from '@prisma/client';
import type { ArtifactStore } from '@ai-qa/artifact-store';

function locate(page: Page, locator: ObservedLocator): Locator {
  if (locator.type === 'testId') return page.getByTestId(locator.value);
  if (locator.type === 'label') return page.getByLabel(locator.value, { exact: true });
  if (locator.type === 'text') return page.getByText(locator.value, { exact: true });
  return page.getByRole(locator.role as never, { name: locator.name, exact: true });
}
export async function observeProject(prisma: PrismaClient, store: ArtifactStore, projectId: string, raw: unknown) {
  const input = ObservationRequest.parse(raw);
  const env = await prisma.environment.findFirstOrThrow({ where: { id: input.environmentId, projectId, isProduction: false } });
  const runtime = EnvironmentRuntime.parse(env.runtime);
  const credential = makeCredentialResolver(runtime.secretRefs);
  const policy = { allowedOrigins: env.allowedOrigins, dependencyOrigins: env.dependencyOrigins };
  const proxy = await startPolicyProxy(policy);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const observationId = randomUUID();
  const bindings: typeof ObservationBundle._type.bindings = [];
  const pages: typeof ObservationBundle._type.pages = [];
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; void browser?.close(); }, 120000);
  try {
    browser = await chromium.launch({ headless: true, proxy: { server: 'per-context' } });
    const contexts = new Map<string, Awaited<ReturnType<typeof browser.newContext>>>();
    for (const target of input.pages) {
      if (timedOut) throw new Error('观察超时');
      const url = new URL(target.path, env.baseUrl).href;
      if (!checkDestination(url, policy).allowed) throw new Error('观察目标不在白名单');
      let context = contexts.get(target.role);
      if (!context) { context = await browser.newContext({ proxy: { server: proxy.url }, serviceWorkers: 'block' }); contexts.set(target.role, context); }
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      for (const action of target.setup) {
        const locator = locate(page, action.locator);
        if (await locator.count() !== 1) throw new Error('准备动作定位不唯一');
        if (action.type === 'click') { await locator.click(); await page.waitForLoadState('domcontentloaded'); }
        else {
          const value: PlanValue = action.value;
          const actual = value.source === 'literal' ? value.value : value.source === 'credential' ? credential(value.ref) : value.source === 'dataRef' ? runtime.dataRefs[value.ref] : undefined;
          if (actual === undefined) throw new Error('准备动作缺少凭据或数据；不支持捕获变量');
          await locator.fill(actual);
        }
      }
      const candidates = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid],button,a,input,select,textarea,[role],label,h1,h2,h3,p,output')).slice(0,500).flatMap<{ type: string; value: string }>(el => {
        if (!(el instanceof HTMLElement) || !el.getClientRects().length) return [];
        const tid = el.getAttribute('data-testid');
        if (tid) return [{ type: 'testId', value: tid }];
        const label = el.getAttribute('aria-label') || ('labels' in el ? (el as HTMLInputElement).labels?.[0]?.textContent?.trim() : '');
        if (label) return [{ type: 'label', value: label }];
        const text = el.innerText?.trim();
        return text && text.length < 200 ? [{ type: 'text', value: text }] : [];
      })) as ObservedLocator[];
      const screenshot = store.put({ runId: `observe-${observationId}`, attemptId: 'role-'+createHash('sha256').update(target.role).digest('hex').slice(0,16), filename: `${pages.length}.png`, data: await page.screenshot({ fullPage: false }) });
      const artifact = await prisma.artifact.create({ data: { projectId, type: 'OBSERVATION', sensitivity: 'NORMAL', storageKey: screenshot.storageKey, checksum: screenshot.checksum } });
      const observedAt = new Date().toISOString();
      const seen = new Set<string>();
      for (const locator of candidates) {
        const key = JSON.stringify(locator);
        if (seen.has(key) || await locate(page, locator).count() !== 1) continue;
        seen.add(key);
        const targetRef = 'el-' + createHash('sha256').update(target.role + page.url() + key).digest('hex').slice(0,16);
        if (!bindings.some(b => b.targetRef === targetRef)) bindings.push({ targetRef, locator, observedUrl: page.url(), observedAt, evidenceId: artifact.id, note: `role=${target.role}` });
        if (bindings.length >= 1000) throw new Error('观察元素超过预算，请缩小页面范围');
      }
      pages.push({ role: target.role, url: page.url(), title: await page.title(), text: (await page.locator('body').innerText()).slice(0,20000) });
      await page.close();
    }
    const bundle = ObservationBundle.parse({ environmentId: env.id, environmentRevision: env.revision, bindings, pages });
    const saved = store.put({ runId: `observe-${observationId}`, attemptId: 'bundle', filename: 'observation.json', data: Buffer.from(JSON.stringify(bundle)) });
    const artifact = await prisma.artifact.create({ data: { projectId, type: 'OBSERVATION_BUNDLE', sensitivity: 'NORMAL', storageKey: saved.storageKey, checksum: saved.checksum } });
    return { artifactId: artifact.id, bindingCount: bindings.length };
  } finally { clearTimeout(deadline); await browser?.close(); await proxy.close(); }
}
