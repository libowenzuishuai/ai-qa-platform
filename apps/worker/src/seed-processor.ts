import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { chromium } from "playwright";
import { checkDestination, startPolicyProxy } from "@ai-qa/test-runtime";
import {
  TestCaseVersion,
  TestPlanV1,
  computePlanAcceptanceHash,
  validatePlanAgainstApprovedCase,
} from "@ai-qa/contracts";
import { ArtifactStore } from "@ai-qa/artifact-store";
import type { WorkerConfig } from "./config.js";
import { makeCredentialResolver, type SecretRefs } from "./credentials.js";
import { DemoFixtureClient } from "./fixtures.js";

/**
 * 固定资产种子（origin=manual，阶段 1 提示词 A 节）。
 *
 * 1. 用真实浏览器观察 demo-app 的候选定位（每个 testId 必须唯一命中），
 *    截图存为 Artifact，再以真实 evidenceId 登记绑定 —— 不预置假证据。
 * 2. 创建规则/用例（APPROVED + approvalHash）/计划（服务端计算哈希）/基线。
 * 3. 幂等：固定 ID，已存在且语义一致则跳过。
 */

/** 每次种子观察使用唯一命名空间（§三.5：多项目并行观察隔离）。 */

interface ObservedBinding {
  targetRef: string;
  locator: { type: "testId"; value: string };
  observedUrl: string;
  observedAt: string;
  evidenceId: string;
}

/**
 * 观察序列。注意状态依赖：
 * - /orders/:id（applicant）必须在草稿态观察（submit-button 仅在 DRAFT 渲染）；
 * - /orders/:id（supervisor）必须在提交后观察（approve-button 仅在待审批渲染）。
 */
const OBSERVATION_TARGETS: Array<{
  path: string;
  role: "anon" | "applicant" | "supervisor";
  testIds: string[];
  /** 执行到该目标前需要先把观察订单提交送审。 */
  submitFirst?: boolean;
}> = [
  { path: "/login", role: "anon", testIds: ["login-username", "login-password", "login-submit"] },
  { path: "/orders/new", role: "applicant", testIds: ["title-input", "amount-input", "note-input", "create-submit"] },
  { path: "/orders/:id", role: "applicant", testIds: ["order-id", "order-status", "submit-button"] },
  { path: "/orders", role: "applicant", testIds: ["orders-count"] },
  { path: "/payments", role: "applicant", testIds: ["payments-count"] },
  { path: "/orders/:id", role: "supervisor", testIds: ["approve-button"], submitFirst: true },
];

async function observeBindings(
  prisma: PrismaClient,
  store: ArtifactStore,
  projectId: string,
  baseUrl: string,
  resolveCredential: (ref: string) => string | undefined,
  NS: string,
): Promise<{ bindings: ObservedBinding[]; orderId: string; namespace: string }> {
  const bindings: ObservedBinding[] = [];
  // 观察流程与执行器同一网络策略（R1）：全部流量经本地策略代理，
  // 登录凭据只可能到达环境白名单内的目的地。
  const allowedPolicy = { allowedOrigins: [baseUrl], dependencyOrigins: [] };
  const proxy = await startPolicyProxy(allowedPolicy);
  let browser: import("playwright").Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, proxy: { server: "per-context" } });
    const contexts = new Map<string, import("playwright").BrowserContext>();
    const contextFor = async (role: string) => {
      const existing = contexts.get(role);
      if (existing) return existing;
      // per-context 模式下所有 context 必须经策略代理（R1：观察流程与
      // 执行器同一网络边界，登录凭据只可能到达白名单目的地）。
      const context = await browser!.newContext({ proxy: { server: proxy.url } });
      await context.addCookies([{ name: "demo_ns", value: NS, url: baseUrl, sameSite: "Lax" }]);
      contexts.set(role, context);
      return context;
    };
    const login = async (role: "applicant" | "supervisor") => {
      const context = await contextFor(role);
      const page = await context.newPage();
      await page.goto(`${baseUrl}/login`);
      await page.getByTestId("login-username").fill(resolveCredential(`${role}.username`)!);
      await page.getByTestId("login-password").fill(resolveCredential(`${role}.password`)!);
      await page.getByTestId("login-submit").click();
      await page.getByTestId("nav-orders").waitFor({ timeout: 10_000 });
      return page;
    };

    // 创建一笔观察用订单（草稿态；submit-button 仅在 DRAFT 渲染）。
    const applicantPage = await login("applicant");
    await applicantPage.getByTestId("nav-new-order").click();
    await applicantPage.getByTestId("title-input").fill("观察用订单");
    await applicantPage.getByTestId("amount-input").fill("6000.00");
    await applicantPage.getByTestId("create-submit").click();
    await applicantPage.getByTestId("order-id").waitFor({ timeout: 10_000 });
    const orderId = ((await applicantPage.getByTestId("order-id").textContent()) ?? "").trim();

    let evidenceCounter = 0;
    let submitted = false;
    // 登录页观察必须用匿名上下文（已登录会话会被重定向离开 /login）。
    let anonPage: import("playwright").Page | null = null;
    const anonContext = await browser!.newContext({ proxy: { server: proxy.url } });
    await anonContext.addCookies([{ name: "demo_ns", value: NS, url: baseUrl, sameSite: "Lax" }]);
    for (const target of OBSERVATION_TARGETS) {
      if (target.submitFirst && !submitted) {
        await applicantPage.goto(`${baseUrl}/orders/${orderId}`);
        await applicantPage.getByTestId("submit-button").click();
        await applicantPage
          .getByTestId("order-status")
          .filter({ hasText: "待审批" })
          .waitFor({ timeout: 10_000 });
        submitted = true;
      }
      let page: import("playwright").Page;
      if (target.role === "anon") {
        anonPage = anonPage ?? (await anonContext.newPage());
        page = anonPage;
      } else if (target.role === "supervisor") {
        const supervisorContext = contexts.get("supervisor");
        const supervisorPage = supervisorContext?.pages()[0];
        page = supervisorPage ?? (await login("supervisor"));
      } else {
        page = applicantPage;
      }
      const path = target.path.replace(":id", orderId);
      await page.goto(`${baseUrl}${path}`);
      // 候选定位必须唯一命中，否则观察失败（不猜测）。
      for (const testId of target.testIds) {
        const count = await page.getByTestId(testId).count();
        if (count !== 1) {
          throw new Error(`观察失败：${path} 上 testId=${testId} 命中 ${count} 次（要求唯一）`);
        }
      }
      evidenceCounter += 1;
      const screenshot = await page.screenshot({ fullPage: false });
      const stored = store.put({
        runId: NS,
        attemptId: "observation",
        filename: `observe-${String(evidenceCounter).padStart(2, "0")}.png`,
        data: screenshot,
      });
      const artifact = await prisma.artifact.create({
        data: {
          projectId,
          attemptId: null,
          storageKey: stored.storageKey,
          type: "OBSERVATION",
          sensitivity: "NORMAL",
          checksum: stored.checksum,
        },
        select: { id: true },
      });
      const observedAt = new Date().toISOString();
      for (const testId of target.testIds) {
        bindings.push({
          targetRef: testId,
          locator: { type: "testId", value: testId },
          observedUrl: `${baseUrl}${path}`,
          observedAt,
          evidenceId: artifact.id,
        });
      }
    }
    return { bindings, orderId, namespace: NS };
  } finally {
    await browser?.close().catch(() => undefined);
    await proxy.close().catch(() => undefined);
  }
}

// ---------- 固定资产定义 ----------

interface FixedAssertion {
  id: string;
  description: string;
  kind: "ui.text" | "ui.element" | "data.value";
  required: boolean;
  ruleVersionId: string;
  operator: string;
  expected: string;
  targetRef: string;
}

interface FixedCase {
  key: string;
  title: string;
  amountYuan: string;
  ruleVersionIds: string[];
  bindings: string[];
  actions: Array<Record<string, unknown>>;
  assertions: FixedAssertion[];
  waitForNever?: boolean;
}

function applicantLoginActions(): Array<Record<string, unknown>> {
  return [
    { id: "s1", type: "switchRole", role: "applicant", effect: "READ" },
    { id: "s2", type: "goto", path: "/login", effect: "READ" },
    { id: "s3", type: "fill", targetRef: "login-username", value: { source: "credential", ref: "applicant.username" }, effect: "READ" },
    { id: "s4", type: "fill", targetRef: "login-password", value: { source: "credential", ref: "applicant.password" }, effect: "READ" },
    { id: "s5", type: "click", targetRef: "login-submit", effect: "READ" },
  ];
}

function createOrderActions(caseKey: string, amountYuan: string, startId: number): Array<Record<string, unknown>> {
  return [
    { id: `s${startId}`, type: "goto", path: "/orders/new", effect: "READ" },
    { id: `s${startId + 1}`, type: "fill", targetRef: "title-input", value: { source: "literal", value: `固定用例-${caseKey}` }, effect: "READ" },
    { id: `s${startId + 2}`, type: "fill", targetRef: "amount-input", value: { source: "literal", value: amountYuan }, effect: "READ" },
    { id: `s${startId + 3}`, type: "click", targetRef: "create-submit", effect: "READ" },
    { id: `s${startId + 4}`, type: "captureValue", targetRef: "order-id", saveAs: "orderId", effect: "READ" },
    { id: `s${startId + 5}`, type: "click", targetRef: "submit-button", effect: "WRITE" },
  ];
}

function supervisorApproveActions(startId: number): Array<Record<string, unknown>> {
  return [
    { id: `s${startId}`, type: "switchRole", role: "supervisor", effect: "READ" },
    { id: `s${startId + 1}`, type: "goto", path: "/login", effect: "READ" },
    { id: `s${startId + 2}`, type: "fill", targetRef: "login-username", value: { source: "credential", ref: "supervisor.username" }, effect: "READ" },
    { id: `s${startId + 3}`, type: "fill", targetRef: "login-password", value: { source: "credential", ref: "supervisor.password" }, effect: "READ" },
    { id: `s${startId + 4}`, type: "click", targetRef: "login-submit", effect: "READ" },
    { id: `s${startId + 5}`, type: "goto", pathTemplate: "/orders/{orderId}", effect: "READ" },
    { id: `s${startId + 6}`, type: "click", targetRef: "approve-button", effect: "WRITE" },
  ];
}

function buildFixedCases(): FixedCase[] {
  const allBindings = [
    "login-username", "login-password", "login-submit",
    "title-input", "amount-input", "note-input", "create-submit",
    "order-id", "order-status", "submit-button", "approve-button",
    "orders-count", "payments-count",
  ];

  const overThreshold: FixedCase = {
    key: "over-threshold",
    title: "金额 5000.01 元（>500000 分）需主管审批并进入付款待办",
    amountYuan: "5000.01",
    ruleVersionIds: ["fx-rule-threshold-v1", "fx-rule-payment-v1", "fx-rule-persistence-v1"],
    bindings: allBindings,
    actions: [
      ...applicantLoginActions(),
      ...createOrderActions("over-threshold", "5000.01", 6),
      { id: "s12", type: "assert", assertionId: "a-status-pending", effect: "READ" },
      ...supervisorApproveActions(13),
      { id: "s20", type: "assert", assertionId: "a-status-awaiting", effect: "READ" },
      { id: "s21", type: "switchRole", role: "applicant", effect: "READ" },
      { id: "s22", type: "goto", pathTemplate: "/orders/{orderId}", effect: "READ" },
      { id: "s23", type: "assert", assertionId: "a-persist-recheck", effect: "READ" },
      { id: "s24", type: "goto", path: "/payments", effect: "READ" },
      { id: "s25", type: "assert", assertionId: "a-payments-count", effect: "READ" },
    ],
    assertions: [
      { id: "a-status-pending", description: "提交后状态为待审批（>500000 分需审批）", kind: "ui.text", required: true, ruleVersionId: "fx-rule-threshold-v1", operator: "equals", expected: "待审批", targetRef: "order-status" },
      { id: "a-status-awaiting", description: "审批通过后状态为付款待办", kind: "ui.text", required: true, ruleVersionId: "fx-rule-payment-v1", operator: "equals", expected: "付款待办", targetRef: "order-status" },
      { id: "a-persist-recheck", description: "重新导航后状态仍为付款待办（持久化）", kind: "ui.text", required: true, ruleVersionId: "fx-rule-persistence-v1", operator: "equals", expected: "付款待办", targetRef: "order-status" },
      { id: "a-payments-count", description: "付款待办（当前命名空间）数量为 1", kind: "data.value", required: true, ruleVersionId: "fx-rule-payment-v1", operator: "equals", expected: "1", targetRef: "payments-count" },
    ],
  };

  const boundary: FixedCase = {
    key: "boundary",
    title: "恰好 5000.00 元（=500000 分）直接进入付款待办",
    amountYuan: "5000.00",
    ruleVersionIds: ["fx-rule-threshold-v1", "fx-rule-payment-v1"],
    bindings: allBindings,
    actions: [
      ...applicantLoginActions(),
      ...createOrderActions("boundary", "5000.00", 6),
      { id: "s12", type: "assert", assertionId: "a-direct-awaiting", effect: "READ" },
      { id: "s13", type: "goto", path: "/payments", effect: "READ" },
      { id: "s14", type: "assert", assertionId: "a-payments-count", effect: "READ" },
    ],
    assertions: [
      { id: "a-direct-awaiting", description: "提交后直接为付款待办（<=500000 分免审批）", kind: "ui.text", required: true, ruleVersionId: "fx-rule-threshold-v1", operator: "equals", expected: "付款待办", targetRef: "order-status" },
      { id: "a-payments-count", description: "付款待办（当前命名空间）数量为 1", kind: "data.value", required: true, ruleVersionId: "fx-rule-payment-v1", operator: "equals", expected: "1", targetRef: "payments-count" },
    ],
  };

  const persist: FixedCase = {
    key: "persist",
    title: "创建的采购单必须持久化（列表可见）",
    amountYuan: "300.00",
    ruleVersionIds: ["fx-rule-persistence-v1", "fx-rule-threshold-v1"],
    bindings: allBindings,
    actions: [
      ...applicantLoginActions(),
      ...createOrderActions("persist", "300.00", 6),
      { id: "s12", type: "assert", assertionId: "a-awaiting", effect: "READ" },
      { id: "s13", type: "goto", path: "/orders", effect: "READ" },
      { id: "s14", type: "assert", assertionId: "a-orders-count", effect: "READ" },
    ],
    assertions: [
      { id: "a-awaiting", description: "提交后为付款待办", kind: "ui.text", required: true, ruleVersionId: "fx-rule-threshold-v1", operator: "equals", expected: "付款待办", targetRef: "order-status" },
      { id: "a-orders-count", description: "采购单列表（当前命名空间）数量为 1（持久化）", kind: "data.value", required: true, ruleVersionId: "fx-rule-persistence-v1", operator: "equals", expected: "1", targetRef: "orders-count" },
    ],
  };

  const waitSlow: FixedCase = {
    key: "wait-slow",
    title: "长等待用例（用于取消/预算验证；等待条件不满足）",
    amountYuan: "100.00",
    ruleVersionIds: ["fx-rule-threshold-v1"],
    bindings: allBindings,
    actions: [
      ...applicantLoginActions(),
      ...createOrderActions("wait-slow", "100.00", 6),
      {
        id: "s12", type: "waitFor", targetRef: "order-status",
        condition: { kind: "text", value: "永不存在的状态文本" },
        timeoutMs: 60_000, pollMs: 1_000, maxAttempts: 60, effect: "READ",
      },
      { id: "s13", type: "assert", assertionId: "a-awaiting", effect: "READ" },
    ],
    assertions: [
      { id: "a-awaiting", description: "等待结束后状态为付款待办", kind: "ui.text", required: true, ruleVersionId: "fx-rule-threshold-v1", operator: "equals", expected: "付款待办", targetRef: "order-status" },
    ],
  };

  return [overThreshold, boundary, persist, waitSlow];
}

const FIXED_RULES = [
  {
    id: "fx-rule-threshold",
    statement: "采购单金额单位为分；金额 > 500000 分需主管审批，<= 500000 分直接进入付款待办",
    expectation: "超过 500000 分的提交后状态为待审批；不超过的提交后状态为付款待办",
    spanLine: 1,
  },
  {
    id: "fx-rule-payment",
    statement: "审批通过后采购单进入付款待办",
    expectation: "审批完成后付款待办列表包含该采购单",
    spanLine: 2,
  },
  {
    id: "fx-rule-persistence",
    statement: "创建成功的采购单必须持久化，刷新或重新导航后仍存在",
    expectation: "列表中可见该采购单（按测试命名空间计数为 1）",
    spanLine: 3,
  },
];

export async function seedFixedAssets(
  prisma: PrismaClient,
  config: WorkerConfig,
  projectId: string,
  environmentId: string,
): Promise<{ created: boolean; detail: string }> {
  const environment = await prisma.environment.findFirst({
    where: { id: environmentId, projectId },
  });
  if (!environment) throw new Error("环境不存在或不属于该项目");

  // 固定资产 ID 按项目前缀隔离（全局唯一 id 会跨项目冲突）。
  const P = `${projectId}-fx`;
  const existingCase = await prisma.testCaseVersion.findFirst({
    where: { id: `${P}-case-over-threshold-v1`, projectId },
  });
  if (existingCase) {
    return { created: false, detail: "固定资产已存在（幂等跳过）" };
  }

  const store = new ArtifactStore(config.artifactDir);
  let bindings: ObservedBinding[] = [];
  const snapshotSecretRefs = (environment.secretRefs ?? {}) as SecretRefs;
  const resolveCredential = makeCredentialResolver(snapshotSecretRefs);
  const missing = ["applicant.username", "applicant.password", "supervisor.username", "supervisor.password"]
    .filter((ref) => resolveCredential(ref) === undefined);
  if (missing.length > 0) {
    throw new Error(
      `缺少测试账号凭据环境变量（需要 ${missing.join(", ")}；请配置 DEMO_APPLICANT_USERNAME 等）`,
    );
  }

  // —— 真实浏览器观察（同一网络策略；唯一命名空间；失败也清理） ——
  const fixture = new DemoFixtureClient(environment.baseUrl, config.demoFixtureToken);
  const observeNamespace = `seed-observe-${randomUUID()}`;
  try {
    const observed = await observeBindings(
      prisma,
      store,
      projectId,
      environment.baseUrl,
      resolveCredential,
      observeNamespace,
    );
    bindings = observed.bindings;
  } finally {
    await fixture.resetNamespace(observeNamespace).catch(() => undefined);
  }

  // —— 来源文档（固定种子说明） ——
  const doc = await prisma.document.upsert({
    where: { id: `${P}-doc` },
    create: { id: `${P}-doc`, projectId, title: "演示业务规则（固定种子说明）" },
    update: {},
  });
  const docVersion = await prisma.documentVersion.upsert({
    where: { documentId_version: { documentId: doc.id, version: 1 } },
    create: {
      id: `${P}-doc-v1`,
      documentId: doc.id,
      version: 1,
      checksum: "seed-fixed",
      storageKey: "seed://fixed-rules",
      format: "MARKDOWN",
      parseStatus: "PARSED",
      parserVersion: "seed-1",
      coverageSummary: { source: "manual-seed" },
    },
    update: {},
  });
  for (const rule of FIXED_RULES) {
    await prisma.sourceSpan.upsert({
      where: { id: `${P}-span-${rule.id}` },
      create: {
        id: `${P}-span-${rule.id}`,
        documentVersionId: docVersion.id,
        locator: { kind: "markdown-line", line: rule.spanLine },
        quotedText: rule.statement,
        extractionQuality: "GOOD",
      },
      update: {},
    });
  }

  // —— 规则（APPROVED，来源指向种子文档） ——
  for (const rule of FIXED_RULES) {
    await prisma.rule.upsert({
      where: { id: `${P}-${rule.id}` },
      create: { id: `${P}-${rule.id}`, projectId, currentVersionId: `${P}-${rule.id}-v1` },
      update: {},
    });
    await prisma.ruleVersion.upsert({
      where: { id: `${P}-${rule.id}-v1` },
      create: {
        id: `${P}-${rule.id}-v1`,
        ruleId: `${P}-${rule.id}`,
        version: 1,
        statement: rule.statement,
        classification: "EXPLICIT",
        role: "applicant",
        action: "提交/审批采购单",
        expectation: rule.expectation,
        businessFields: [
          { key: "amountCents", operator: "gt", value: 500000, unit: "fen" },
        ],
        sources: [{ documentVersionId: docVersion.id, sourceSpanIds: [`${P}-span-${rule.id}`] }],
        reviewStatus: "APPROVED",
        origin: "manual",
        reviewedBy: "seed:manual",
        reviewedAt: new Date(),
      },
      update: {},
    });
  }

  // —— 用例 + 计划（断言/规则引用统一加项目前缀） ——
  for (const fixedRaw of buildFixedCases()) {
    const fixed: FixedCase = {
      ...fixedRaw,
      ruleVersionIds: fixedRaw.ruleVersionIds.map((r) => `${P}-${r}`),
      assertions: fixedRaw.assertions.map((a) => ({ ...a, ruleVersionId: `${P}-${a.ruleVersionId}` })),
    };
    const caseId = `${P}-case-${fixed.key}`;
    await prisma.testCase.upsert({
      where: { id: caseId },
      create: { id: caseId, projectId, currentVersionId: `${caseId}-v1` },
      update: {},
    });
    const caseDraft = {
      id: `${caseId}-v1`,
      caseId,
      version: 1,
      title: fixed.title,
      ruleVersionIds: fixed.ruleVersionIds,
      roles: ["applicant", "supervisor"],
      preconditions: ["申请人账号可用", "目标环境可访问"],
      dataSpec: { strategy: "create", note: "通过浏览器真实创建采购单" },
      steps: fixed.actions
        .filter((a) => a.type === "click" || a.type === "fill" || a.type === "switchRole")
        .map((a, i) => ({
          id: `st-${i + 1}`,
          role: a.role === "supervisor" ? "supervisor" : "applicant",
          action: `${a.type}:${a.targetRef ?? a.path ?? ""}`,
        })),
      assertions: fixed.assertions.map((a) => ({
        id: a.id,
        description: a.description,
        kind: a.kind,
        required: a.required,
        ruleVersionId: a.ruleVersionId,
        operator: a.operator,
        expected: a.expected,
        targetRef: a.targetRef,
      })),
      cleanup: { strategy: "namespace", note: "按 attempt 命名空间清理" },
      priority: "P0",
      approvalStatus: "APPROVED",
      origin: "manual",
      projectId,
    };

    const usedBindings = bindings.filter((b) => fixed.bindings.includes(b.targetRef));
    const planDraft = {
      schemaVersion: "1.0",
      caseVersionId: `${caseId}-v1`,
      ruleVersionIds: fixed.ruleVersionIds,
      roles: ["applicant", "supervisor"],
      bindings: usedBindings,
      actions: fixed.actions,
      assertions: fixed.assertions.map((a) => ({
        id: a.id,
        stepId: stepIdForAssertion(fixed.actions, a.id),
        required: a.required,
        ruleVersionId: a.ruleVersionId,
        kind: a.kind,
        targetRef: a.targetRef,
        operator: a.operator,
        expected: a.expected,
      })),
    };

    // 先计算哈希再建行：APPROVED 行创建即冻结（F1），不能事后回填 approvalHash。
    // 哈希阶段按 DRAFT 解析（approvalStatus 是工作流元数据，不参与哈希）。
    const parsedCase = TestCaseVersion.parse({
      ...caseDraft,
      approvalStatus: "DRAFT",
      approvalHash: undefined,
      createdAt: new Date().toISOString(),
    });
    const acceptanceHash = computePlanAcceptanceHash({
      testCase: parsedCase,
      plan: planDraft as never,
    });
    const finalCase = TestCaseVersion.parse({
      ...caseDraft,
      approvalHash: acceptanceHash,
      createdAt: new Date().toISOString(),
    });
    const consistency = validatePlanAgainstApprovedCase(planDraft as never, finalCase);
    if (!consistency.ok) {
      throw new Error(`固定用例 ${caseId} 计划与批准语义不一致：${consistency.mismatches.join("; ")}`);
    }
    const caseRow = await prisma.testCaseVersion.upsert({
      where: { id: `${caseId}-v1` },
      create: { ...caseDraft, approvalHash: acceptanceHash },
      update: {},
    });
    const plan = TestPlanV1.parse({ ...planDraft, acceptanceHash });
    await prisma.testPlanVersion.upsert({
      where: { id: `${P}-plan-${fixed.key}-v1` },
      create: {
        id: `${P}-plan-${fixed.key}-v1`,
        caseVersionId: caseRow.id,
        version: 1,
        schemaVersion: "1.0",
        plan: plan as unknown as object,
        bindingEvidenceIds: usedBindings.map((b) => b.evidenceId),
        acceptanceHash,
      },
      update: {},
    });
  }

  // —— 基线 ——
  const ruleVersionIds = FIXED_RULES.map((r) => `${P}-${r.id}-v1`);
  const caseVersionIds = buildFixedCases().map((c) => `${P}-case-${c.key}-v1`);
  await prisma.baseline.upsert({
    where: { id: `${P}-baseline-v1` },
    create: {
      id: `${P}-baseline-v1`,
      projectId,
      name: "固定基线 v1（阶段 1）",
      ruleVersionIds,
      caseVersionIds,
      scope: { origin: "manual-seed" },
    },
    update: {},
  });
  await prisma.project.update({
    where: { id: projectId },
    data: { activeBaselineId: `${P}-baseline-v1` },
  });
  await prisma.auditEvent.create({
    data: {
      actorId: "seed:worker",
      action: "project.seed_fixed_assets",
      entityType: "Project",
      entityId: projectId,
      afterRef: JSON.stringify({ environmentId, bindings: bindings.length }),
    },
  });
  return { created: true, detail: `已创建 ${ruleVersionIds.length} 规则 / ${caseVersionIds.length} 用例 / 1 基线 / ${bindings.length} 观察绑定` };
}

function stepIdForAssertion(actions: Array<Record<string, unknown>>, assertionId: string): string {
  const assertAction = actions.find((a) => a.assertionId === assertionId);
  if (!assertAction) throw new Error(`断言 ${assertionId} 没有对应检查动作`);
  return String(assertAction.id);
}
