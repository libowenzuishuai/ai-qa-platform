import { beforeAll, afterAll, it, expect } from "vitest";
import Fastify from "fastify";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createTestEnv, type TestEnv } from "../../api/test/helpers/db.js";
import { registerChangeReviewRoutes } from "../../api/src/routes-change-review.js";
import { registerJobRoutes } from "../../api/src/routes-jobs.js";
import { registerReviewRoutes } from "../../api/src/routes-review.js";
import { registerProductRoutes } from "../../api/src/routes-product.js";
import { registerDefectRoutes } from "../../api/src/routes-defects.js";
import { sendApiError } from "../../api/src/errors.js";
import { processAgentJob } from "../src/agent-job-processor.js";
import { reconcileAgentJobs } from "../src/agent-job-recovery.js";
import { createRun } from "../../api/src/runs-service.js";
import { processRun } from "../src/run-processor.js";
import { buildRunReport } from "@ai-qa/reporting";
import { WorkerConfig } from "../src/config.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const vectors = JSON.parse(
  readFileSync(
    root + "packages/contracts/fixtures/source-impact-conformance.json",
    "utf8",
  ),
);
const app = Fastify();
let env: TestEnv,
  actor: any,
  python: ChildProcess,
  web: ChildProcess,
  pythonUrl = "",
  apiUrl = "",
  webUrl = "";
let redisUrl = "",
  redisStarted = false;
const redisName = "aiqa-change-" + randomUUID().slice(0, 8);
const token = randomUUID(),
  queueCalls: string[] = [];
let failQueue = false;
const queue = {
  add: async (_name: string, data: any) => {
    if (failQueue) throw new Error("offline");
    queueCalls.push(data.jobId);
    return {} as any;
  },
};
function config() {
  return WorkerConfig.parse({
    databaseUrl: env.databaseUrl,
    redisUrl,
    artifactDir: env.artifactDir,
    intelligenceBackend: "python",
    intelligenceUrl: pythonUrl,
    intelligenceToken: token,
    intelligenceTimeoutMs: 30000,
  });
}
function ready(child: ChildProcess, pattern: RegExp) {
  return new Promise<string>((resolve, reject) => {
    let log = "";
    const timer = setTimeout(
      () => reject(new Error("service startup timeout " + log)),
      15000,
    );
    const on = (b: Buffer) => {
      log += b.toString();
      const m = pattern.exec(log);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    };
    child.stdout?.on("data", on);
    child.stderr?.on("data", on);
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("service exited " + log));
    });
  });
}
beforeAll(async () => {
  env = await createTestEnv("changes");
  execFileSync("docker", [
    "run",
    "--rm",
    "-d",
    "--name",
    redisName,
    "-p",
    "127.0.0.1::6379",
    "redis:7-alpine",
  ]);
  redisStarted = true;
  redisUrl =
    "redis://127.0.0.1:" +
    execFileSync("docker", ["port", redisName, "6379/tcp"], {
      encoding: "utf8",
    })
      .trim()
      .split(":")
      .at(-1);
  actor = await env.prisma.user.create({
    data: {
      username: randomUUID(),
      displayName: "验收负责人",
      passwordHash: "test-only",
      platformRole: "LEAD",
    },
  });
  app.addHook("onRequest", async (req) => {
    req.auth = {
      userId: actor.id,
      username: actor.username,
      displayName: actor.displayName,
      platformRole: "LEAD",
    };
  });
  app.setErrorHandler((e, q, r) => sendApiError(q, r, e));
  registerChangeReviewRoutes(app, env.prisma, env.store, queue);
  registerJobRoutes(app, env.prisma, queue);
  registerReviewRoutes(app, env.prisma);
  registerProductRoutes(app, env.prisma, env.store, queue, queue);
  registerDefectRoutes(app, env.prisma, env.store, queue);
  apiUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  python = spawn(
    root + "services/intelligence/.venv/bin/python",
    [
      "-c",
      "import uvicorn;uvicorn.run('aiqa_intelligence.app:app',host='127.0.0.1',port=0)",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PYTHONPATH: root + "services/intelligence/src",
        AIQA_INTELLIGENCE_TOKEN: token,
        AIQA_ARTIFACT_DIR: env.artifactDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  pythonUrl = await ready(
    python,
    /Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/,
  );
  web = spawn("node", ["--import", "tsx", root + "apps/web/src/server.ts"], {
    cwd: root + "apps/web",
    env: {
      ...process.env,
      WEB_PORT: "0",
      WEB_HOST: "127.0.0.1",
      API_BASE_URL: apiUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  webUrl = await ready(web, /web ready on (http:\/\/127\.0\.0\.1:\d+)/);
}, 30000);
afterAll(async () => {
  web?.kill("SIGTERM");
  python?.kill("SIGTERM");
  await app.close();
  if (redisStarted) execFileSync("docker", ["rm", "-f", redisName]);
  await env?.cleanup();
});
async function scenario(apiCase = false) {
  const prefix = randomUUID();
  const raw = {
    ...structuredClone(
      vectors.find((v: any) => v.name === "exact-intersection").input,
    ),
    comparison: structuredClone(
      vectors.find((v: any) => v.name === "modified-real-source").input,
    ),
  };
  const ids = new Set<string>();
  for (const b of [raw.comparison.oldBundle, raw.comparison.newBundle]) {
    ids.add(b.documentVersionId);
    for (const s of b.spans) ids.add(s.id);
    for (const x of b.blocks) ids.add(x.id);
  }
  for (const r of raw.approvedRuleVersions) {
    ids.add(r.id);
    ids.add(r.ruleId);
  }
  for (const c of raw.approvedCaseVersions) {
    ids.add(c.id);
    ids.add(c.caseId);
  }
  const map = (v: any): any =>
    typeof v === "string" && ids.has(v)
      ? prefix + "-" + v
      : Array.isArray(v)
        ? v.map(map)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, map(x)]))
          : v;
  const input = map(raw);
  if (apiCase)
    for (const c of input.approvedCaseVersions)
      for (const a of c.assertions) a.kind = "api.response";
  const project = await env.prisma.project.create({
    data: {
      name: "需求变更验收",
      memberships: { create: { userId: actor.id, role: "LEAD" } },
    },
  });
  const document = await env.prisma.document.create({
    data: { projectId: project.id, title: "额度规则" },
  });
  let version = 1;
  for (const b of [input.comparison.oldBundle, input.comparison.newBundle]) {
    const saved = env.store.put({
      runId: "bundles",
      attemptId: b.documentVersionId,
      filename: "bundle.json",
      data: Buffer.from(JSON.stringify(b)),
    });
    await env.prisma.documentVersion.create({
      data: {
        id: b.documentVersionId,
        documentId: document.id,
        version: version++,
        checksum: saved.checksum,
        storageKey: saved.storageKey,
        format: b.format,
        parseStatus: b.parseStatus,
        bundleStorageKey: saved.storageKey,
        bundleChecksum: saved.checksum,
        mode: "real",
      },
    });
    await env.prisma.sourceSpan.createMany({ data: b.spans });
  }
  for (const r of input.approvedRuleVersions) {
    await env.prisma.rule.create({
      data: { id: r.ruleId, projectId: project.id },
    });
    await env.prisma.ruleVersion.create({ data: r });
  }
  for (const c of input.approvedCaseVersions) {
    await env.prisma.testCase.create({
      data: { id: c.caseId, projectId: project.id },
    });
    await env.prisma.testCaseVersion.create({
      data: { ...c, projectId: project.id },
    });
  }
  const baseline = await env.prisma.baseline.create({
    data: {
      projectId: project.id,
      name: "原验收基线",
      ruleVersionIds: input.approvedRuleVersions.map((r: any) => r.id),
      caseVersionIds: input.approvedCaseVersions.map((c: any) => c.id),
    },
  });
  const request = {
    baselineId: baseline.id,
    oldDocumentVersionId: input.comparison.oldBundle.documentVersionId,
    newDocumentVersionId: input.comparison.newBundle.documentVersionId,
    idempotencyKey: randomUUID(),
  };
  return { project, document, baseline, request, input };
}
async function post(path: string, body: any, code = 200) {
  const r = await app.inject({ method: "POST", url: path, payload: body });
  expect(r.statusCode, r.body).toBe(code);
  return r.json();
}
async function start(s: any) {
  return post(`/api/projects/${s.project.id}/changes`, s.request, 202);
}
async function finished(s: any) {
  const r = await start(s);
  await processAgentJob(env.prisma, config(), r.jobId);
  const job = await env.prisma.job.findUniqueOrThrow({
    where: { id: r.jobId },
  });
  expect(job.status, JSON.stringify(job.error)).toBe("SUCCEEDED");
  return r;
}

it("真实 Python HTTP → 固定输入 → 结构化影响；重复投递不产生第二报告", async () => {
  const s = await scenario(),
    r = await finished(s);
  await processAgentJob(env.prisma, config(), r.jobId);
  const detail = await app.inject(`/api/changes/${r.reviewId}`);
  expect(detail.statusCode, detail.body).toBe(200);
  const data = detail.json();
  expect(data.output.impact.affectedRules).toHaveLength(1);
  expect(data.output.impact.affectedCases).toHaveLength(1);
  expect(data.pendingCount).toBe(2);
  expect(
    await env.prisma.changeReview.count({ where: { jobId: r.jobId } }),
  ).toBe(1);
  expect(
    await env.prisma.modelInvocation.count({
      where: { projectId: s.project.id },
    }),
  ).toBe(0);
  expect((await app.inject(`/api/jobs/${r.jobId}`)).statusCode).toBe(200);
});
it("并发同体幂等、异体冲突；入队失败可对账补投", async () => {
  const s = await scenario();
  failQueue = true;
  const results = await Promise.all([
    start(s),
    post(`/api/projects/${s.project.id}/changes`, s.request, 200),
  ]);
  failQueue = false;
  expect(results[0].reviewId).toBe(results[1].reviewId);
  await post(
    `/api/projects/${s.project.id}/changes`,
    { ...s.request, oldDocumentVersionId: "fake" },
    409,
  );
  await env.prisma.job.update({
    where: { id: results[0].jobId },
    data: { updatedAt: new Date(Date.now() - 15000) },
  });
  await reconcileAgentJobs(env.prisma, queue);
  expect(queueCalls).toContain(results[0].jobId);
});
it("取消终态不能复活；失联可显式重试且只保留一份报告", async () => {
  const s = await scenario(),
    r = await start(s);
  await post(`/api/jobs/${r.jobId}/cancel`, {});
  await processAgentJob(env.prisma, config(), r.jobId);
  expect(
    (await env.prisma.job.findUniqueOrThrow({ where: { id: r.jobId } })).status,
  ).toBe("CANCELLED");
  const t = await scenario(),
    j = await start(t);
  await env.prisma.job.update({
    where: { id: j.jobId },
    data: {
      status: "RUNNING",
      startedAt: new Date(Date.now() - 100000),
      updatedAt: new Date(Date.now() - 100000),
    },
  });
  await reconcileAgentJobs(env.prisma, queue);
  expect(
    (await env.prisma.job.findUniqueOrThrow({ where: { id: j.jobId } })).status,
  ).toBe("FAILED");
  await post(`/api/jobs/${j.jobId}/retry`, {}, 202);
  await processAgentJob(env.prisma, config(), j.jobId);
  expect(
    (await env.prisma.job.findUniqueOrThrow({ where: { id: j.jobId } })).status,
  ).toBe("SUCCEEDED");
});
it("跨项目和查看者不能创建或确认；损坏证据不能分析", async () => {
  const a = await scenario(),
    b = await scenario();
  await post(
    `/api/projects/${a.project.id}/changes`,
    { ...a.request, newDocumentVersionId: b.request.newDocumentVersionId },
    422,
  );
  await env.prisma.projectMembership.updateMany({
    where: { projectId: a.project.id, userId: actor.id },
    data: { role: "VIEWER" },
  });
  await post(`/api/projects/${a.project.id}/changes`, a.request, 403);
  const r = await finished(b);
  await env.prisma.projectMembership.updateMany({
    where: { projectId: b.project.id, userId: actor.id },
    data: { role: "VIEWER" },
  });
  await post(
    `/api/changes/${r.reviewId}/resolve`,
    {
      assetType: "RULE",
      assetVersionId: b.input.approvedRuleVersions[0].id,
      decision: "KEEP",
      reason: "测试查看者不能确认",
    },
    403,
  );
  const t = await scenario();
  const d = await env.prisma.documentVersion.findUniqueOrThrow({
    where: { id: t.request.newDocumentVersionId },
  });
  writeFileSync(env.store.resolveSafe(d.bundleStorageKey!), "{}");
  await post(`/api/projects/${t.project.id}/changes`, t.request, 422);
});
it("确认产生新版基线但保留全部旧规则、用例和范围；决策不可覆盖", async () => {
  const s = await scenario(),
    r = await finished(s),
    before = await env.prisma.baseline.findUniqueOrThrow({
      where: { id: s.baseline.id },
    });
  await post(
    `/api/changes/${r.reviewId}/baseline`,
    { name: "不能提前创建" },
    409,
  );
  const rule = s.input.approvedRuleVersions[0],
    tc = s.input.approvedCaseVersions[0];
  await post(
    `/api/changes/${r.reviewId}/resolve`,
    {
      assetType: "CASE",
      assetVersionId: tc.id,
      decision: "KEEP",
      reason: "先处理用例不应通过",
    },
    409,
  );
  const ruleDecision = {
    assetType: "RULE",
    assetVersionId: rule.id,
    decision: "KEEP",
    reason: "负责人确认本次文字更新不改变此标准",
  };
  await post(`/api/changes/${r.reviewId}/resolve`, ruleDecision);
  await post(`/api/changes/${r.reviewId}/resolve`, ruleDecision);
  await post(
    `/api/changes/${r.reviewId}/resolve`,
    { ...ruleDecision, reason: "试图覆盖旧理由不允许" },
    409,
  );
  await post(`/api/changes/${r.reviewId}/resolve`, {
    assetType: "CASE",
    assetVersionId: tc.id,
    decision: "KEEP",
    reason: "保持原标准验证兼容性",
  });
  const baseline = await post(`/api/changes/${r.reviewId}/baseline`, {
    name: "复核后基线",
  });
  expect(baseline.caseVersionIds).toEqual(before.caseVersionIds);
  expect(baseline.ruleVersionIds).toEqual(before.ruleVersionIds);
  expect(
    await env.prisma.baseline.findUniqueOrThrow({
      where: { id: s.baseline.id },
    }),
  ).toEqual(before);
  expect(
    (await post(`/api/changes/${r.reviewId}/baseline`, { name: "重复点击" }))
      .id,
  ).toBe(baseline.id);
});
it("修订规则先草稿再批准；新用例引用新规则且无旧计划；可以形成新基线", async () => {
  const s = await scenario(),
    r = await finished(s),
    old = s.input.approvedRuleVersions[0],
    oldCase = s.input.approvedCaseVersions[0];
  const body = {
    ruleVersionId: old.id,
    statement: "额度 800000 分",
    classification: "EXPLICIT",
    role: "applicant",
    action: "申请",
    expectation: "额度800000分",
    sourceSpanIds: [s.input.comparison.newBundle.spans[0].id],
    reason: "更新额度规则并引用新资料",
  };
  const next = await post(`/api/changes/${r.reviewId}/revise-rule`, body);
  expect(next.reviewStatus).toBe("DRAFT");
  expect((await post(`/api/changes/${r.reviewId}/revise-rule`, body)).id).toBe(
    next.id,
  );
  await post(
    `/api/changes/${r.reviewId}/resolve`,
    {
      assetType: "RULE",
      assetVersionId: old.id,
      decision: "REPLACED",
      replacementVersionId: next.id,
      reason: "不能采用尚未批准的规则",
    },
    422,
  );
  await post(`/api/rule-versions/${next.id}/approve`, {});
  await post(`/api/changes/${r.reviewId}/resolve`, {
    assetType: "RULE",
    assetVersionId: old.id,
    decision: "REPLACED",
    replacementVersionId: next.id,
    reason: "确认使用批准的新额度规则",
  });
  const nextCase = await post(`/api/case-versions/${oldCase.id}/revise`, {
    title: "新版额度用例",
    preconditions: [],
    dataSpec: oldCase.dataSpec,
    steps: oldCase.steps,
    assertions: oldCase.assertions.map((a: any) => ({
      ...a,
      ruleVersionId: next.id,
    })),
    cleanup: oldCase.cleanup,
    roles: oldCase.roles,
    ruleVersionIds: [next.id],
  });
  await post(`/api/case-versions/${nextCase.id}/approve`, {});
  await post(
    `/api/changes/${r.reviewId}/resolve`,
    {
      assetType: "CASE",
      assetVersionId: oldCase.id,
      decision: "KEEP",
      reason: "不允许旧用例配新规则",
    },
    409,
  );
  await post(`/api/changes/${r.reviewId}/resolve`, {
    assetType: "CASE",
    assetVersionId: oldCase.id,
    decision: "REPLACED",
    replacementVersionId: nextCase.id,
    reason: "采用引用新规则的批准用例",
  });
  const baseline = await post(`/api/changes/${r.reviewId}/baseline`, {
    name: "新额度基线",
  });
  expect(baseline.ruleVersionIds).toContain(next.id);
  expect(baseline.caseVersionIds).toContain(nextCase.id);
  expect(
    await env.prisma.testPlanVersion.count({
      where: { caseVersionId: nextCase.id },
    }),
  ).toBe(0);
  expect(
    (await env.prisma.ruleVersion.findUniqueOrThrow({ where: { id: old.id } }))
      .reviewStatus,
  ).toBe("APPROVED");
});
it("真实浏览器查看逐项来源、通过表单确认；移动端不溢出", async () => {
  const s = await scenario(),
    r = await finished(s);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.addCookies([{ name: "web_sid", value: "test", url: webUrl }]);
    const page = await context.newPage();
    await page.goto(webUrl + "/changes/" + r.reviewId);
    await page
      .getByRole("heading", { name: "来源对比", exact: true })
      .waitFor();
    expect(
      await page.getByText("额度 800000 分", { exact: true }).count(),
    ).toBeGreaterThan(0);
    const first = page.locator('form[action$="/resolve"]').first();
    await first
      .getByLabel("复核依据与处理说明")
      .fill("页面确认保留原标准用于兼容性验收");
    await first.getByRole("button", { name: "确认处理" }).click();
    await page.waitForLoadState();
    expect(
      await page.getByText("已确认：保留原标准", { exact: false }).count(),
    ).toBe(1);
    const out = root + "docs/delivery/evidence";
    mkdirSync(out, { recursive: true });
    await page.screenshot({
      path: out + "/change-review-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: out + "/change-review-mobile.png",
      fullPage: true,
    });
    await context.close();
  } finally {
    await browser.close();
  }
}, 30000);

it("进程在认领后 SIGKILL，恢复标失败，再试复用冻结输入", async () => {
  const s = await scenario(),
    j = await start(s);
  const child = spawn(
    "node",
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import {PrismaClient} from '@prisma/client'; const db=new PrismaClient({datasources:{db:{url:process.env.DATABASE_URL}}});await db.job.updateMany({where:{id:process.env.TEST_JOB,status:'QUEUED'},data:{status:'RUNNING',startedAt:new Date()}});console.log('CLAIMED');setInterval(()=>{},1000);`,
    ],
    {
      cwd: root + "apps/worker",
      env: { ...process.env, DATABASE_URL: env.databaseUrl, TEST_JOB: j.jobId },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    await ready(child, /(CLAIMED)/);
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await env.prisma.job.update({
      where: { id: j.jobId },
      data: { updatedAt: new Date(Date.now() - 100000) },
    });
    await reconcileAgentJobs(env.prisma, queue);
    await post(`/api/jobs/${j.jobId}/retry`, {}, 202);
    await processAgentJob(env.prisma, config(), j.jobId);
    expect(
      (await env.prisma.job.findUniqueOrThrow({ where: { id: j.jobId } }))
        .status,
    ).toBe("SUCCEEDED");
    expect(
      await env.prisma.changeReview.count({ where: { jobId: j.jobId } }),
    ).toBe(1);
  } finally {
    child.kill("SIGKILL");
  }
}, 15000);

it("变更复核页发起原标准复测：旧构建 FAIL，新构建 PASS，计划和预期保持不变", async () => {
  const s = await scenario(true),
    review = await finished(s),
    target = Fastify();
  let fixed = false;
  target.get("/status", async () => ({ state: fixed ? "已提交" : "错误状态" }));
  target.get("/build", async () => ({
    buildId: fixed ? "fixed-v2" : "broken-v1",
  }));
  const targetUrl = await target.listen({ host: "127.0.0.1", port: 0 });
  try {
    await env.prisma.projectMembership.updateMany({
      where: { projectId: s.project.id, userId: actor.id },
      data: { role: "ADMIN" },
    });
    const environment = await env.prisma.environment.create({
      data: {
        projectId: s.project.id,
        name: "验收环境",
        baseUrl: targetUrl,
        allowedOrigins: [targetUrl],
        runtime: {
          fixture: "none",
          buildProbe: { path: "/build", field: "buildId" },
        },
      },
    });
    for (const c of s.input.approvedCaseVersions) {
      const template = await post(
        `/api/projects/${s.project.id}/api-templates`,
        {
          environmentId: environment.id,
          request: {
            name: "状态接口",
            method: "GET",
            path: "/status",
            responseField: "body.state",
          },
        },
      );
      const plan = await post(`/api/case-versions/${c.id}/api-plan`, {
        templateId: template.id,
      });
      await post(`/api/plan-proposals/${plan.id}/approve`, {});
    }
    const original = await createRun(env.prisma, env.store, {
      projectId: s.project.id,
      baselineId: s.baseline.id,
      environmentId: environment.id,
      caseVersionIds: s.baseline.caseVersionIds,
      mode: "real",
      buildId: "broken-v1",
      idempotencyKey: randomUUID(),
    });
    await processRun(env.prisma, config(), original.runId);
    const before = await env.prisma.run.findUniqueOrThrow({
      where: { id: original.runId },
    });
    expect(
      (await buildRunReport(env.prisma, env.store, original.runId)).run
        .acceptanceStatus,
    ).toBe("FAIL");
    fixed = true;
    const browser = await chromium.launch();
    let newId: string;
    try {
      const context = await browser.newContext();
      await context.addCookies([
        { name: "web_sid", value: "test", url: webUrl },
      ]);
      const page = await context.newPage();
      await page.goto(webUrl + "/changes/" + review.reviewId);
      const form = page.locator('form[action$="/retest"]');
      await form.getByLabel("原运行").selectOption(original.runId);
      await form.getByLabel("修复后的新构建版本").fill("fixed-v2");
      await form.getByRole("button").click();
      await page.waitForURL(/\/runs\//);
      newId = page.url().split("/").at(-1)!;
      await context.close();
    } finally {
      await browser.close();
    }
    await processRun(env.prisma, config(), newId!);
    const after = await env.prisma.run.findUniqueOrThrow({
      where: { id: newId! },
    });
    expect(after.casePlanPins).toEqual(before.casePlanPins);
    expect(after.selectedCaseVersionIds).toEqual(before.selectedCaseVersionIds);
    const report = await buildRunReport(env.prisma, env.store, newId!);
    expect(report.run.acceptanceStatus, JSON.stringify(report)).toBe("PASS");
    expect(
      (await buildRunReport(env.prisma, env.store, original.runId)).run
        .acceptanceStatus,
    ).toBe("FAIL");
    expect(
      (
        await env.prisma.missionRun.findUniqueOrThrow({
          where: { runId: newId! },
        })
      ).retestOf,
    ).toBe(original.runId);
  } finally {
    await target.close();
  }
}, 30000);
