import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import type { ObservedLocator, PlanValue, TestPlanV1 } from "@ai-qa/contracts";
import { checkDestination, resolveTargetUrl, type NavigationPolicy } from "./navigation-policy.js";
import { compareAssertion, type AssertionValue } from "./assertions.js";

/**
 * 受限 TestPlan 执行器（阶段 1：七种动作）。
 *
 * 安全与语义约束：
 * - 不执行模型提供的 JavaScript/eval/shell/SQL；未支持动作在执行前拒绝。
 * - 每角色独立 BrowserContext；每 attempt 独立 namespace Cookie（数据隔离）。
 * - 导航/子资源/重定向/弹窗目的地在发出前拦截（navigation-policy）。
 * - 凭据只在执行时注入，不进入日志/事件/证据。
 * - WRITE 之后等待页面稳定；无法确认结果 → UNCERTAIN_SIDE_EFFECT，不重试。
 * - 程序化断言决定 PASS/FAIL；金额数值用明确单位比较。
 */

export type StepStatus =
  | "PENDING"
  | "RUNNING"
  | "PASSED"
  | "FAILED"
  | "SKIPPED"
  | "BLOCKED"
  | "CANCELLED";

export interface StepProgress {
  stepId: string;
  type: string;
  effect: "READ" | "WRITE";
  status: StepStatus;
  actual?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  evidenceIds: string[];
}

export interface AssertionProgress {
  assertionId: string;
  required: boolean;
  expected?: AssertionValue;
  actual?: AssertionValue;
  unit?: string;
  result: "PASS" | "FAIL" | "REVIEW" | "NOT_EVALUATED";
  evidenceIds: string[];
  note?: string;
}

export interface EvidenceSink {
  save(
    kind: string,
    filename: string,
    data: Buffer,
    opts: { sensitivity: "NORMAL" | "RESTRICTED_RAW" },
  ): Promise<{ artifactId: string }>;
}

export interface ExecutorEvents {
  onStep?(step: StepProgress): Promise<void> | void;
  onAssertion?(a: AssertionProgress): Promise<void> | void;
  onViolation?(v: { kind: string; url: string; detail: string }): Promise<void> | void;
  onWriteIntent?(stepId: string, detail: string): Promise<void> | void;
}

export interface ExecuteOptions {
  plan: TestPlanV1;
  baseUrl: string;
  policy: NavigationPolicy;
  namespace: string;
  resolveCredential: (ref: string) => string | undefined;
  dataRefs?: Record<string, string>;
  sink: EvidenceSink;
  budget: { maxActions: number; wallClockMs: number; perActionTimeoutMs: number };
  shouldContinue: () => Promise<boolean>;
  events?: ExecutorEvents;
}

export interface ExecuteResult {
  steps: StepProgress[];
  assertions: AssertionProgress[];
  vars: Record<string, string>;
  blocked?: { reasonCode: string; detail: string };
  cancelled: boolean;
  browserCrashed: boolean;
}

const SUPPORTED_ACTIONS = new Set([
  "goto",
  "fill",
  "click",
  "select",
  "switchRole",
  "captureValue",
  "waitFor",
  "assert",
]);

function locatorFor(page: Page, locator: ObservedLocator): Locator {
  switch (locator.type) {
    case "testId":
      return page.getByTestId(locator.value);
    case "role":
      return page.getByRole(locator.role as never, locator.name ? { name: locator.name } : undefined);
    case "label":
      return page.getByLabel(locator.value);
    case "text":
      return page.getByText(locator.value);
  }
}

async function readActual(page: Page, locator: Locator, kind: string): Promise<AssertionValue> {
  if (kind === "ui.element") {
    const count = await locator.count();
    return count > 0 ? "1" : "0";
  }
  // ui.text / ui.state / data.value：优先读取输入框值，其次文本内容。
  const tag = await locator.evaluate((el) => el.tagName).catch(() => null);
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return await locator.inputValue();
  }
  return (await locator.innerText()).trim();
}

export async function executePlan(options: ExecuteOptions): Promise<ExecuteResult> {
  const { plan, sink, events } = options;
  const startedAtMs = Date.now();
  const steps: StepProgress[] = [];
  const assertions: AssertionProgress[] = [];
  const vars: Record<string, string> = { ...(options.dataRefs ?? {}) };
  let blocked: ExecuteResult["blocked"];
  let cancelled = false;
  let browserCrashed = false;
  let actionsExecuted = 0;

  const bindingByRef = new Map(plan.bindings.map((b) => [b.targetRef, b]));
  const assertionById = new Map(plan.assertions.map((a) => [a.id, a]));

  // 执行前能力校验：未支持的动作明确拒绝，不静默跳过。
  for (const action of plan.actions) {
    if (!SUPPORTED_ACTIONS.has(action.type)) {
      throw new Error(`执行器不支持动作类型 ${action.type}（应在计划入库前拒绝）`);
    }
  }

  let browser: Browser | null = null;
  const roleContexts = new Map<string, BrowserContext>();
  let currentRole: string | null = null;
  const pendingTraces: Array<{ context: BrowserContext; role: string }> = [];
  /** 执行器自己创建的主页面；不在集合内的 page 事件视为弹窗并关闭。 */
  const ourPages = new WeakSet<object>();
  /** newPage() 调用期间同步触发 page 事件，用标志避免误判为弹窗。 */
  let creatingOwnPage = false;

  async function getContext(role: string): Promise<BrowserContext> {
    const existing = roleContexts.get(role);
    if (existing) return existing;
    if (!browser) throw new Error("browser not launched");
    const context = await browser.newContext();
    // 发出前拦截：主框架/子资源/重定向目的地策略；弹窗直接关闭并记录。
    await context.route("**/*", (route) => {
      const url = route.request().url();
      const decision = checkDestination(url, options.policy);
      if (decision.allowed) return route.continue();
      void events?.onViolation?.({
        kind: "destination_blocked",
        url,
        detail: `目标 ${decision.origin ?? url} 不在白名单内，请求已中止`,
      });
      return route.abort("blockedbyclient");
    });
    context.on("page", (page) => {
      if (creatingOwnPage || ourPages.has(page)) return;
      void events?.onViolation?.({
        kind: "popup_blocked",
        url: page.url(),
        detail: "弹窗被策略关闭",
      });
      void page.close();
    });
    // namespace Cookie：测试数据隔离标记（非凭据）。
    const base = new URL(options.baseUrl);
    await context.addCookies([
      {
        name: "demo_ns",
        value: options.namespace,
        url: options.baseUrl,
        sameSite: "Lax",
      },
    ]);
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    pendingTraces.push({ context, role });
    roleContexts.set(role, context);
    return context;
  }

  async function currentPage(): Promise<Page> {
    if (!currentRole) throw new Error("未先执行 switchRole");
    const context = await getContext(currentRole);
    const pages = context.pages().filter((p) => ourPages.has(p));
    const existing = pages[pages.length - 1];
    if (existing) return existing;
    creatingOwnPage = true;
    try {
      const created = await context.newPage();
      ourPages.add(created);
      return created;
    } finally {
      creatingOwnPage = false;
    }
  }

  async function stopAndStoreTraces(): Promise<void> {
    for (const { context, role } of pendingTraces.splice(0)) {
      try {
        const path = `${process.env.TMPDIR ?? "/tmp"}/trace-${options.namespace}-${role}.zip`;
        await context.tracing.stop({ path });
        const { readFileSync, unlinkSync } = await import("node:fs");
        const data = readFileSync(path);
        unlinkSync(path);
        await sink.save("TRACE", `trace-${role}.zip`, data, { sensitivity: "RESTRICTED_RAW" });
      } catch {
        /* trace 失败不掩盖业务结果 */
      }
      await context.close().catch(() => undefined);
    }
  }

  async function saveScreenshot(kind: string): Promise<string | null> {
    try {
      const page = await currentPage();
      const buffer = await page.screenshot({ fullPage: false });
      const seq = String(steps.length + 1).padStart(3, "0");
      const saved = await sink.save(kind, `${seq}-${kind}.png`, buffer, { sensitivity: "NORMAL" });
      return saved.artifactId;
    } catch {
      return null;
    }
  }

  function resolveValue(value: PlanValue): { ok: true; value: string } | { ok: false; reason: string } {
    switch (value.source) {
      case "literal":
        return { ok: true, value: value.value };
      case "dataRef":
        const data = vars[value.ref];
        if (data === undefined) return { ok: false, reason: `命名空间数据 ${value.ref} 不存在` };
        return { ok: true, value: data };
      case "credential":
        const secret = options.resolveCredential(value.ref);
        if (secret === undefined)
          return { ok: false, reason: `凭据引用 ${value.ref} 无法解析（AUTH）` };
        return { ok: true, value: secret };
      case "captured":
        const captured = vars[value.varName];
        if (captured === undefined) return { ok: false, reason: `捕获变量 ${value.varName} 未定义` };
        return { ok: true, value: captured };
    }
  }

  async function looksLikeLoginPage(page: Page): Promise<boolean> {
    try {
      return (await page.locator('input[type="password"]').count()) > 0;
    } catch {
      return false;
    }
  }

  function isTimeoutError(err: unknown): boolean {
    return err instanceof Error && /Timeout.*exceeded|timed out/i.test(err.message);
  }

  try {
    browser = await chromium.launch({ headless: true });

    actionLoop: for (const action of plan.actions) {
      const now = new Date().toISOString();
      const step: StepProgress = {
        stepId: action.id,
        type: action.type,
        effect: action.effect,
        status: "RUNNING",
        startedAt: now,
        evidenceIds: [],
      };
      steps.push(step);
      await events?.onStep?.({ ...step });

      const finishStep = async (patch: Partial<StepProgress>) => {
        Object.assign(step, patch, { finishedAt: new Date().toISOString() });
        await events?.onStep?.({ ...step });
      };

      // —— 取消 ——
      if (!(await options.shouldContinue())) {
        cancelled = true;
        await finishStep({ status: "CANCELLED", error: "收到取消请求" });
        break;
      }
      // —— 预算 ——
      const elapsed = Date.now() - startedAtMs;
      if (actionsExecuted >= options.budget.maxActions || elapsed > options.budget.wallClockMs) {
        blocked = {
          reasonCode: "TIME_BUDGET",
          detail: `预算耗尽（动作 ${actionsExecuted}/${options.budget.maxActions}，耗时 ${elapsed}ms/${options.budget.wallClockMs}ms）`,
        };
        await finishStep({ status: "BLOCKED", error: blocked.detail });
        break;
      }

      // —— 显式顺序分支 ——
      if (action.onlyIf) {
        const v = vars[action.onlyIf.varName];
        const left = Number(v);
        const right =
          typeof action.onlyIf.value === "number" ? action.onlyIf.value : Number(action.onlyIf.value);
        const comparable = Number.isFinite(left) && Number.isFinite(right);
        let condition = false;
        switch (action.onlyIf.operator) {
          case "eq":
            condition = comparable ? left === right : v === String(action.onlyIf.value);
            break;
          case "neq":
            condition = comparable ? left !== right : v !== String(action.onlyIf.value);
            break;
          case "gt":
            condition = comparable && left > right;
            break;
          case "gte":
            condition = comparable && left >= right;
            break;
          case "lt":
            condition = comparable && left < right;
            break;
          case "lte":
            condition = comparable && left <= right;
            break;
        }
        if (!condition) {
          await finishStep({ status: "SKIPPED", actual: `onlyIf 不满足（${action.onlyIf.varName}=${v ?? "未定义"}）` });
          continue;
        }
      }

      actionsExecuted += 1;
      const timeout = options.budget.perActionTimeoutMs;

      try {
        switch (action.type) {
          case "switchRole": {
            currentRole = action.role;
            await getContext(action.role);
            await finishStep({ status: "PASSED", actual: `角色 ${action.role} 上下文就绪` });
            break;
          }
          case "goto": {
            const page = await currentPage();
            const rawPath = action.path ?? action.pathTemplate ?? "";
            const resolved = resolveTargetUrl(rawPath, options.baseUrl, vars);
            if (!resolved.ok) {
              blocked = { reasonCode: "ENVIRONMENT", detail: `导航被拒绝：${resolved.error}` };
              await finishStep({ status: "BLOCKED", error: resolved.error });
              break actionLoop;
            }
            const decision = checkDestination(resolved.url, options.policy);
            if (!decision.allowed) {
              blocked = {
                reasonCode: "ENVIRONMENT",
                detail: `导航目标 ${resolved.url} 不在允许范围内`,
              };
              await events?.onViolation?.({
                kind: "navigation_blocked",
                url: resolved.url,
                detail: "导航前被策略拒绝",
              });
              await finishStep({ status: "BLOCKED", error: blocked.detail });
              break actionLoop;
            }
            const response = await page.goto(resolved.url, { timeout, waitUntil: "load" });
            const finalDecision = checkDestination(page.url(), options.policy);
            if (!finalDecision.allowed) {
              blocked = {
                reasonCode: "ENVIRONMENT",
                detail: `导航/重定向后离开白名单：${page.url()}`,
              };
              await finishStep({ status: "BLOCKED", error: blocked.detail });
              break actionLoop;
            }
            await finishStep({ status: "PASSED", actual: `${response?.status() ?? "?"} ${page.url()}` });
            break;
          }
          case "fill":
          case "select": {
            const page = await currentPage();
            const binding = bindingByRef.get(action.targetRef);
            if (!binding) throw new Error(`targetRef ${action.targetRef} 无绑定`);
            const value = resolveValue(action.value);
            if (!value.ok) {
              const isAuth = /凭据引用/.test(value.reason);
              blocked = { reasonCode: isAuth ? "AUTH" : "TEST_DATA", detail: value.reason };
              await finishStep({ status: "BLOCKED", error: value.reason });
              break actionLoop;
            }
            const locator = locatorFor(page, binding.locator);
            await locator.waitFor({ state: "visible", timeout });
            if (action.type === "fill") await locator.fill(value.value, { timeout });
            else await locator.selectOption(value.value, { timeout });
            await finishStep({ status: "PASSED", actual: `已${action.type === "fill" ? "填写" : "选择"}（值不记录）` });
            break;
          }
          case "click": {
            const page = await currentPage();
            const binding = bindingByRef.get(action.targetRef);
            if (!binding) throw new Error(`targetRef ${action.targetRef} 无绑定`);
            if (action.effect === "WRITE") {
              await events?.onWriteIntent?.(action.id, `WRITE 点击 ${action.targetRef}`);
            }
            const locator = locatorFor(page, binding.locator);
            await locator.waitFor({ state: "visible", timeout });
            try {
              await locator.click({ timeout });
            } catch (err) {
              if (action.effect === "WRITE" && isTimeoutError(err)) {
                // 前置可见性检查已通过；点击超时大概率是提交后导航/响应挂起，
                // 无法确认业务结果 → 副作用不确定，禁止重试（PRD FR-08）。
                blocked = {
                  reasonCode: "UNCERTAIN_SIDE_EFFECT",
                  detail: `写操作 ${action.id} 点击后未在限时内稳定（提交结果未知）；不重试`,
                };
                const evidenceId = await saveScreenshot("write-uncertain");
                if (evidenceId) step.evidenceIds.push(evidenceId);
                await finishStep({ status: "BLOCKED", error: blocked.detail });
                break actionLoop;
              }
              throw err;
            }
            if (action.effect === "WRITE") {
              // 写操作后等待页面稳定；无法确认结果 → 副作用不确定，禁止重试。
              try {
                await page.waitForLoadState("load", { timeout: Math.min(timeout, 15_000) });
              } catch (err) {
                if (isTimeoutError(err)) {
                  blocked = {
                    reasonCode: "UNCERTAIN_SIDE_EFFECT",
                    detail: `写操作 ${action.id} 已提交但响应未在限时内完成，无法确认业务结果；不重试`,
                  };
                  const evidenceId = await saveScreenshot("write-uncertain");
                  if (evidenceId) step.evidenceIds.push(evidenceId);
                  await finishStep({ status: "BLOCKED", error: blocked.detail });
                  break actionLoop;
                }
                throw err;
              }
            }
            await finishStep({ status: "PASSED" });
            break;
          }
          case "captureValue": {
            const page = await currentPage();
            const binding = bindingByRef.get(action.targetRef);
            if (!binding) throw new Error(`targetRef ${action.targetRef} 无绑定`);
            const locator = locatorFor(page, binding.locator);
            await locator.waitFor({ state: "visible", timeout });
            const tag = await locator.evaluate((el) => el.tagName).catch(() => null);
            const value =
              tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
                ? await locator.inputValue()
                : (await locator.innerText()).trim();
            vars[action.saveAs] = value;
            await finishStep({ status: "PASSED", actual: `已捕获 ${action.saveAs}` });
            break;
          }
          case "waitFor": {
            const page = await currentPage();
            const binding = action.targetRef ? bindingByRef.get(action.targetRef) : undefined;
            if (action.targetRef && !binding) throw new Error(`targetRef ${action.targetRef} 无绑定`);
            const deadline = Date.now() + action.timeoutMs;
            let attempt = 0;
            let satisfied = false;
            let lastObservation = "";
            while (attempt < action.maxAttempts && Date.now() < deadline) {
              attempt += 1;
              if (!(await options.shouldContinue())) {
                cancelled = true;
                break;
              }
              try {
                if (action.condition.kind === "urlContains") {
                  satisfied = page.url().includes(action.condition.value);
                  lastObservation = page.url();
                } else if (binding) {
                  const locator = locatorFor(page, binding.locator);
                  const count = await locator.count();
                  if (action.condition.kind === "visible") satisfied = count > 0;
                  else if (action.condition.kind === "hidden") satisfied = count === 0;
                  else if (action.condition.kind === "text") {
                    satisfied = count > 0 && (await locator.innerText()).includes(action.condition.value);
                    lastObservation = count > 0 ? await locator.innerText().catch(() => "") : "";
                  } else if (action.condition.kind === "value") {
                    satisfied =
                      count > 0 && (await locator.inputValue().catch(() => "")) === action.condition.value;
                  }
                }
                if (satisfied) break;
              } catch (err) {
                lastObservation = err instanceof Error ? err.message : String(err);
              }
              await page.waitForTimeout(action.pollMs);
            }
            if (cancelled) {
              await finishStep({ status: "CANCELLED", error: "等待中收到取消请求" });
              break;
            }
            if (!satisfied) {
              blocked = {
                reasonCode: "TIME_BUDGET",
                detail: `waitFor 未满足（条件 ${action.condition.kind}${
                  "value" in action.condition ? `:${action.condition.value}` : ""
                }，尝试 ${attempt}/${action.maxAttempts}，观察：${lastObservation.slice(0, 120) || "无目标"}）`,
              };
              await finishStep({ status: "BLOCKED", error: blocked.detail });
              break actionLoop;
            }
            await finishStep({ status: "PASSED", actual: `等待满足（${attempt} 次）` });
            break;
          }
          case "assert": {
            const page = await currentPage();
            const assertion = assertionById.get(action.assertionId);
            if (!assertion) throw new Error(`断言 ${action.assertionId} 不存在`);
            const progress: AssertionProgress = {
              assertionId: assertion.id,
              required: assertion.required,
              expected: assertion.expected ?? null,
              unit: assertion.unit,
              result: "NOT_EVALUATED",
              evidenceIds: [],
            };
            assertions.push(progress);
            try {
              if (!assertion.targetRef) {
                progress.result = "REVIEW";
                progress.note = "断言缺少 targetRef（应在计划校验时拒绝）";
              } else {
                const binding = bindingByRef.get(assertion.targetRef);
                if (!binding) throw new Error(`targetRef ${assertion.targetRef} 无绑定`);
                const locator = locatorFor(page, binding.locator);
                if (assertion.operator === "exists" || assertion.operator === "notExists") {
                  await locator.waitFor({ state: "attached", timeout });
                  const count = await locator.count();
                  const exists = count > 0;
                  const pass =
                    assertion.operator === "exists" ? exists : !exists;
                  progress.actual = exists ? "1" : "0";
                  progress.result = pass ? "PASS" : "FAIL";
                } else {
                  await locator.waitFor({ state: "visible", timeout });
                  const actual = await readActual(page, locator, assertion.kind);
                  progress.actual = actual;
                  const compared = compareAssertion(
                    assertion.operator,
                    assertion.expected ?? null,
                    actual,
                  );
                  progress.result = compared.result === "PASS" ? "PASS" : compared.result === "FAIL" ? "FAIL" : "REVIEW";
                  progress.note = compared.note;
                }
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              if (isTimeoutError(err)) {
                progress.result = "NOT_EVALUATED";
                progress.note = `断言目标未出现：${message.split("\n")[0] ?? ""}`;
              } else {
                progress.result = "REVIEW";
                progress.note = message.split("\n")[0] ?? "";
              }
            }
            const evidenceId = await saveScreenshot(`assert-${assertion.id}`);
            if (evidenceId) progress.evidenceIds.push(evidenceId);
            const stepEvidence = progress.evidenceIds[0];
            if (stepEvidence) step.evidenceIds.push(stepEvidence);
            await finishStep({ status: "PASSED", actual: `断言 ${progress.result}` });
            await events?.onAssertion?.({ ...progress });
            continue;
          }
          default:
            throw new Error(`未支持动作 ${String((action as { type: string }).type)}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message.split("\n")[0] ?? "" : String(err);
        let reasonCode = "LOCATOR";
        let detail = message;
        try {
          const page = await currentPage();
          if (await looksLikeLoginPage(page)) {
            reasonCode = "AUTH";
            detail = `疑似登录失败/会话失效（页面呈现登录表单）：${message}`;
          }
        } catch {
          /* 页面不可用时保持 LOCATOR */
        }
        if (isTimeoutError(err)) {
          reasonCode = reasonCode === "AUTH" ? "AUTH" : "ENVIRONMENT";
          detail = `操作超时：${message}`;
        }
        // 网络层失败（含被策略拦截的请求）属于环境/策略问题，不是定位问题。
        if (/net::ERR|Navigation failed|ERR_FAILED|ERR_BLOCKED/i.test(message)) {
          reasonCode = "ENVIRONMENT";
          detail = `网络/导航失败（可能被目的地策略拦截）：${message}`;
        }
        const evidenceId = await saveScreenshot("step-failed");
        if (evidenceId) step.evidenceIds.push(evidenceId);
        blocked = { reasonCode, detail };
        await finishStep({ status: "BLOCKED", error: detail });
        break;
      }
    }
  } catch (err) {
    browserCrashed = true;
    const message = err instanceof Error ? err.message.split("\n")[0] ?? "" : String(err);
    blocked ??= { reasonCode: "ENVIRONMENT", detail: `浏览器/执行器故障：${message}` };
  } finally {
    await stopAndStoreTraces().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }

  // 计划中未被评估的断言统一登记为 NOT_EVALUATED。
  for (const assertion of plan.assertions) {
    if (!assertions.some((a) => a.assertionId === assertion.id)) {
      const progress: AssertionProgress = {
        assertionId: assertion.id,
        required: assertion.required,
        expected: assertion.expected ?? null,
        unit: assertion.unit,
        result: "NOT_EVALUATED",
        evidenceIds: [],
        note: blocked ? `执行中断（${blocked.reasonCode}）` : cancelled ? "执行取消" : "",
      };
      assertions.push(progress);
      await events?.onAssertion?.({ ...progress });
    }
  }

  return { steps, assertions, vars, blocked, cancelled, browserCrashed };
}
