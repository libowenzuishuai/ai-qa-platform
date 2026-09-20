import { afterAll, beforeAll, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Queue, Worker } from "bullmq";
import { chromium, type Browser } from "playwright";
import { registerAuth } from "../../api/src/auth.js";
import { registerProjectRoutes } from "../../api/src/routes-projects.js";
import { registerJobRoutes } from "../../api/src/routes-jobs.js";
import { registerDocumentRoutes } from "../../api/src/routes-documents.js";
import { registerReviewRoutes } from "../../api/src/routes-review.js";
import { sendApiError } from "../../api/src/errors.js";
import { createTestEnv, type TestEnv } from "../../api/test/helpers/db.js";
import { processAgentJob, buildCaseGenerationJobInput } from "../src/agent-job-processor.js";
import { reconcileAgentJobs } from "../src/agent-job-recovery.js";
import { TestCaseVersion } from "@ai-qa/contracts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
let env: TestEnv, app: FastifyInstance, queue: Queue, worker: Worker, browser: Browser;
let python: ChildProcess, web: ChildProcess, pythonUrl: string, webUrl: string, apiUrl: string;
let projectId: string, documentId: string, documentVersionId: string, ruleId: string, clarificationId: string;
const appErrors: unknown[] = [];
const cookieHeader = { cookie: "aiqa_sid=platform-session" };
const redisName = `aiqa-platform-${process.pid}`;
let redisStarted = false;
const cfg = () => ({ port: 0, host: "127.0.0.1", databaseUrl: env.databaseUrl, redisUrl: "unused", artifactDir: env.artifactDir,
  demoFixtureToken: "unused", logLevel: "warn", intelligenceBackend: "python" as const,
  intelligenceUrl: pythonUrl, intelligenceToken: "platform-test-token", intelligenceTimeoutMs: 10000 });

async function started(child: ChildProcess, pattern: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("service startup: " + output)), 15000);
    const read = (data: Buffer) => { output += data.toString(); const match = output.match(pattern); if (match) { clearTimeout(timer); resolve(match[1]!); } };
    child.stdout!.on("data", read); child.stderr!.on("data", read);
    child.once("error", e => { clearTimeout(timer); reject(e); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`service exit ${code}: ${output}`)); });
  });
}
async function stop(child?: ChildProcess) {
  if (child && child.exitCode === null) { const done = new Promise(r => child.once("exit", r)); child.kill("SIGTERM"); await done; }
}
async function waitJob(id: string) {
  for (let i = 0; i < 200; i++) { const row = await env.prisma.job.findUniqueOrThrow({ where: { id } });
    if (["SUCCEEDED", "FAILED"].includes(row.status)) return row;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("job did not finish: " + id);
}
async function upload(text: string | Buffer = "金额超过 5000 元须审批", extra: Record<string, unknown> = {}, project = projectId, headers = cookieHeader) {
  const bytes = Buffer.from(text);
  const form = new FormData();
  form.set("metadata", JSON.stringify({ title: "集成 PRD", declaredFormat: "MARKDOWN", fileSizeBytes: bytes.length, mode: "mock", ...extra }));
  form.set("file", new Blob([bytes]), "spec.md");
  const encoded = new Request("http://test", { method: "POST", body: form });
  return app.inject({ method: "POST", url: `/api/projects/${project}/documents`, headers: { ...headers, "content-type": encoded.headers.get("content-type")! }, payload: Buffer.from(await encoded.arrayBuffer()) });
}
const post = (url: string, payload: unknown = {}) => app.inject({ method: "POST", url, headers: cookieHeader, payload });

beforeAll(async () => {
  vi.stubEnv("AIQA_INTELLIGENCE_BACKEND", "python");
  env = await createTestEnv("platformflow");
  const user = await env.prisma.user.create({ data: { username: "platform-user", passwordHash: "unused", displayName: "平台验收", platformRole: "LEAD" } });
  projectId = (await env.prisma.project.create({ data: { name: "平台闭环验收" } })).id;
  await env.prisma.projectMembership.create({ data: { projectId, userId: user.id, role: "LEAD" } });
  await env.prisma.session.create({ data: { id: "platform-session", userId: user.id, expiresAt: new Date(Date.now() + 3600000) } });
  execFileSync("docker", ["run", "--rm", "-d", "--name", redisName, "-p", "127.0.0.1::6379", "redis:7-alpine"]); redisStarted = true;
  const port = Number(execFileSync("docker", ["port", redisName, "6379/tcp"], { encoding: "utf8" }).trim().split(":").at(-1));
  const connection = { host: "127.0.0.1", port };
  queue = new Queue("platform-test", { connection });
  python = spawn(root + "services/intelligence/.venv/bin/python", ["-m", "uvicorn", "platform_fixture:app", "--host", "127.0.0.1", "--port", "0"], {
    cwd: root, env: { ...process.env, AIQA_ARTIFACT_DIR: env.artifactDir, PYTHONPATH: root + "services/intelligence/src:" + root + "services/intelligence/tests" }, stdio: ["ignore", "pipe", "pipe"],
  });
  pythonUrl = await started(python, /Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/);
  worker = new Worker("platform-test", job => processAgentJob(env.prisma, cfg(), job.data.jobId), { connection });
  app = Fastify(); await app.register(cookie); registerAuth(app, env.prisma, 600);
  app.setErrorHandler((error, req, reply) => { appErrors.push(error); sendApiError(req, reply, error); });
  registerProjectRoutes(app, env.prisma); registerJobRoutes(app, env.prisma, queue);
  registerDocumentRoutes(app, env.prisma, queue, env.store); registerReviewRoutes(app, env.prisma);
  apiUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  web = spawn("node", ["--import", "tsx", root + "apps/web/src/server.ts"], { cwd: root + "apps/web",
    env: { ...process.env, WEB_PORT: "0", WEB_HOST: "127.0.0.1", API_BASE_URL: apiUrl }, stdio: ["ignore", "pipe", "pipe"] });
  webUrl = await started(web, /web ready on (http:\/\/127\.0\.0\.1:\d+)/);
  browser = await chromium.launch({ headless: true });
}, 60000);
afterAll(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await browser?.close(); await stop(web); await worker?.close(); await queue?.close();
  await app?.close(); await stop(python);
  if (redisStarted) execFileSync("docker", ["rm", "-f", redisName]);
  await env?.cleanup();
}, 30000);

it("上传鉴权、跨项目、大小不符被拒绝，无资产落库", async () => {
  expect((await upload(undefined, {}, projectId, {} as typeof cookieHeader)).statusCode).toBe(401);
  expect((await upload(undefined, { fileSizeBytes: 1 })).statusCode).toBe(422);
  const other = await env.prisma.project.create({ data: { name: "other" } });
  expect((await upload(undefined, {}, other.id)).statusCode).toBe(403);
  const foreign = await env.prisma.document.create({ data: { projectId: other.id, title: "foreign" } });
  expect((await upload(undefined, { documentId: foreign.id })).statusCode).toBe(422);
  const tooLarge = await app.inject({ method: "POST", url: `/api/projects/${projectId}/documents`, headers: { ...cookieHeader, "content-type": "multipart/form-data; boundary=test" }, payload: Buffer.alloc(21 * 1024 * 1024 + 1) });
  expect(tooLarge.statusCode).toBe(413); expect(tooLarge.json().code).toBe("VALIDATION_ERROR");
  expect(await env.prisma.documentVersion.count()).toBe(0);
});
it("真实文件上传 → Redis → worker → Python → 解析文件/来源入库，并发重复仅一个版本", async () => {
  const responses = await Promise.all([upload(), upload()]);
  expect(responses.every(r => [200, 202].includes(r.statusCode))).toBe(true);
  expect(responses[0]!.json().jobId).toBe(responses[1]!.json().jobId);
  const job = await waitJob(responses[0]!.json().jobId);
  expect(job.status, JSON.stringify(job.error)).toBe("SUCCEEDED");
  const result = job.result as any; documentId = result.documentId; documentVersionId = result.documentVersionId;
  expect(await env.prisma.documentVersion.count()).toBe(1);
  const doc = await env.prisma.documentVersion.findUniqueOrThrow({ where: { id: documentVersionId } });
  expect(env.store.verify(doc.bundleStorageKey!, doc.bundleChecksum)).toBe(true);
  expect(await env.prisma.sourceSpan.count({ where: { documentVersionId } })).toBe(1);
  expect((await app.inject({ url: `/api/document-versions/${documentVersionId}`, headers: cookieHeader })).json().bundle.spans[0].quotedText).toBe("金额超过 5000 元须审批");
});
it("正式 Python 规则/用例管线（模型 mock） → 澄清前禁止批准 → 确认回答 → 批准 → 仅相关回答传给用例生成", async () => {
  const extraction = await post(`/api/projects/${projectId}/rule-extractions`, { documentVersionIds: [documentVersionId], mode: "mock" });
  const job = await waitJob(extraction.json().jobId); expect(job.status, JSON.stringify(job.error)).toBe("SUCCEEDED");
  ruleId = (job.result as any).ruleVersionIds[0]; clarificationId = (job.result as any).clarificationIds[0];
  expect((await post(`/api/rule-versions/${ruleId}/approve`)).statusCode).toBe(409);
  expect((await post(`/api/clarifications/${clarificationId}/resolve`, { answer: "部门主管" })).statusCode).toBe(422);
  const answer = { answer: "部门主管", answerSource: "测试登记的产品确认记录" };
  expect((await post(`/api/clarifications/${clarificationId}/resolve`, answer)).statusCode).toBe(200);
  expect((await post(`/api/clarifications/${clarificationId}/resolve`, answer)).statusCode).toBe(200);
  expect((await post(`/api/clarifications/${clarificationId}/resolve`, { ...answer, answer: "其他" })).statusCode).toBe(409);
  expect((await post(`/api/rule-versions/${ruleId}/approve`)).statusCode).toBe(200);
  await env.prisma.clarification.create({ data: { projectId, ruleVersionIds: ["unrelated"], question: "无关未回答" } });
  const input = await buildCaseGenerationJobInput(env.prisma, projectId, [ruleId]);
  expect(input.clarificationSources.map(c => c.id)).toEqual([clarificationId]);
  expect((await post(`/api/projects/${projectId}/case-generations`, { ruleVersionIds: [ruleId], mode: "real" })).statusCode).toBe(422);
  await env.prisma.ruleVersion.update({ where: { id: ruleId }, data: { generationMode: null } });
  expect((await post(`/api/projects/${projectId}/case-generations`, { ruleVersionIds: [ruleId], mode: "real" })).statusCode).toBe(422);
  await env.prisma.ruleVersion.update({ where: { id: ruleId }, data: { generationMode: "mock" } });
  const generation = await post(`/api/projects/${projectId}/case-generations`, { ruleVersionIds: [ruleId], mode: "mock" });
  const generated = await waitJob(generation.json().jobId); expect(generated.status, JSON.stringify(generated.error)).toBe("SUCCEEDED");
  const c = await env.prisma.testCaseVersion.findUniqueOrThrow({ where: { id: (generated.result as any).caseVersionIds[0] } });
  expect(TestCaseVersion.safeParse({ ...c, createdAt: c.createdAt.toISOString(), description: c.description ?? undefined, approvalHash: c.approvalHash ?? undefined }).success).toBe(true);
  expect(c).toMatchObject({ approvalStatus: "DRAFT", generationMode: "mock" });
  const records = await env.prisma.modelInvocation.findMany({ where: { projectId } });
  expect(records).toHaveLength(2);
  expect(records.every(r => r.provider === "mock" && r.promptVersion === "agents-v2")).toBe(true);
  expect(await env.prisma.auditEvent.count({ where: { entityId: ruleId, action: "ruleVersion.approve" } })).toBe(1);
});
it("追加版本保留旧版本与来源；坏文件为 FAILED，显式重试可恢复状态", async () => {
  const response = await upload("新版本正文", { documentId, title: "新版本" });
  const job = await waitJob(response.json().jobId); expect(job.status).toBe("SUCCEEDED");
  expect(await env.prisma.documentVersion.count({ where: { documentId } })).toBe(2);
  expect((await env.prisma.documentVersion.findUniqueOrThrow({ where: { id: documentVersionId } })).parseStatus).toBe("PARSED");
  const bad = await upload("not a pdf", { declaredFormat: "PDF_TEXT", title: "坏文件" });
  const failed = await waitJob(bad.json().jobId); expect(failed.status).toBe("FAILED");
  expect((failed.result as any).parseStatus).toBe("FAILED");
  await worker.pause();
  try {
    expect((await post(`/api/jobs/${failed.id}/retry`)).statusCode).toBe(202);
    expect((await env.prisma.documentVersion.findUniqueOrThrow({ where: { id: (failed.request as any).documentVersionId } })).parseStatus).toBe("PENDING");
  } finally { worker.resume(); }
  expect((await waitJob(failed.id)).status).toBe("FAILED");
});
it("解析文件篡改后拒绝展示与规则提取", async () => {
  const doc = await env.prisma.documentVersion.findUniqueOrThrow({ where: { id: documentVersionId } });
  const path = env.store.resolveSafe(doc.bundleStorageKey!); const bytes = readFileSync(path);
  try { writeFileSync(path, "tampered");
    expect((await app.inject({ url: `/api/document-versions/${documentVersionId}`, headers: cookieHeader })).statusCode).toBe(422);
    const extraction = await post(`/api/projects/${projectId}/rule-extractions`, { documentVersionIds: [documentVersionId], glossaryUpdates: [{ term: "new", definition: "test" }], mode: "mock" });
    expect((await waitJob(extraction.json().jobId)).status).toBe("FAILED");
  } finally { writeFileSync(path, bytes); }
});
it("失联解析收敛为 FAILED；旧租约响应不能发布解析产物", async () => {
  await worker.pause();
  try {
    const response = await upload("租约测试"); const id = response.json().jobId;
    const actualFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      const response = await actualFetch(...args);
      await env.prisma.job.update({ where: { id }, data: { updatedAt: new Date(Date.now() - 120000) } });
      await reconcileAgentJobs(env.prisma, { add: async () => ({} as never) });
      return response;
    });
    try { await processAgentJob(env.prisma, cfg(), id); } finally { spy.mockRestore(); }
    const job = await env.prisma.job.findUniqueOrThrow({ where: { id } }); expect(job.status).toBe("FAILED");
    const doc = await env.prisma.documentVersion.findUniqueOrThrow({ where: { id: (job.request as any).documentVersionId } });
    expect(doc).toMatchObject({ parseStatus: "FAILED", bundleStorageKey: null });
    expect(await env.prisma.sourceSpan.count({ where: { documentVersionId: doc.id } })).toBe(0);
  } finally { worker.resume(); }
});
it("真实浏览器：审阅页面、模拟标记、原文、上传表单与错误转义", async () => {
  const context = await browser.newContext(); await context.addCookies([{ name: "web_sid", value: "platform-session", url: webUrl }]);
  const page = await context.newPage();
  try {
    await page.goto(`${webUrl}/projects/${projectId}/review`);
    expect(await page.getByRole("heading", { name: /资料与测试审阅/ }).count()).toBe(1);
    expect(await page.getByText("模拟数据（不代表真实模型效果）", { exact: false }).count()).toBeGreaterThan(0);
    await page.locator('#upload input[name="title"]').fill('<script>alert("x")</script>');
    await page.locator('#upload input[name="file"]').setInputFiles({ name: "browser.md", mimeType: "text/markdown", buffer: Buffer.from("浏览器上传正文") });
    await page.getByRole("button", { name: "上传并解析" }).click(); await page.waitForURL(/\/jobs\//);
    const id = page.url().split("/").at(-1)!; expect((await waitJob(id)).status).toBe("SUCCEEDED");
    const jobPage = await page.reload(); expect(jobPage?.status()).toBe(200);
    expect(await page.getByText(/状态：SUCCEEDED/).count()).toBe(1);
    await page.goto(`${webUrl}/projects/${projectId}/review`);
    expect(await page.locator('script').filter({ hasText: 'alert("x")' }).count()).toBe(0);
    await page.goto(`${webUrl}/document-versions/${documentVersionId}`);
    expect(await page.getByText("金额超过 5000 元须审批", { exact: true }).count()).toBeGreaterThan(0);
  } finally { await context.close(); }
}, 20000);

it("扫描 PDF 作业成功但文档 NEEDS_OCR，禁止直接规则提取", async () => {
  const blank = execFileSync(root + "services/intelligence/.venv/bin/python", ["-c", "from pypdf import PdfWriter; import sys; w=PdfWriter(); w.add_blank_page(300,200); from io import BytesIO; b=BytesIO(); w.write(b); sys.stdout.buffer.write(b.getvalue())"]);
  const response = await upload(blank, { declaredFormat: "PDF_TEXT", title: "扫描/空白页" });
  const job = await waitJob(response.json().jobId);
  expect(job.status, JSON.stringify(job.error)).toBe("SUCCEEDED");
  expect((job.result as any).parseStatus).toBe("NEEDS_OCR");
  expect((job.result as any).spanCounts.unparsed).toBe(1);
  const result = await post(`/api/projects/${projectId}/rule-extractions`, { documentVersionIds: [(job.result as any).documentVersionId], mode: "mock" });
  expect(result.statusCode).toBe(422); expect(result.json().code).toBe("NEEDS_OCR");
});
it("冲突规则不能并发双批准，驳回一方后才允许批准另一方", async () => {
  const a = await env.prisma.rule.create({ data: { projectId } });
  const b = await env.prisma.rule.create({ data: { projectId } });
  const fields = { version: 1, statement: "冲突测试", classification: "INFERRED", action: "提交", expectation: "待确认", origin: "manual" };
  const r1 = await env.prisma.ruleVersion.create({ data: { ...fields, ruleId: a.id } });
  const r2 = await env.prisma.ruleVersion.create({ data: { ...fields, ruleId: b.id, conflictsWith: [r1.id] } });
  await env.prisma.ruleVersion.update({ where: { id: r1.id }, data: { conflictsWith: [r2.id] } });
  const results = await Promise.all([post(`/api/rule-versions/${r1.id}/approve`), post(`/api/rule-versions/${r2.id}/approve`)]);
  expect(results.map(r => r.statusCode)).toEqual([409, 409]);
  expect((await post(`/api/rule-versions/${r2.id}/reject`)).statusCode).toBe(200);
  expect((await post(`/api/rule-versions/${r1.id}/approve`)).statusCode).toBe(200);
});
it("只读成员可查看但不可回答/批准/上传", async () => {
  const user = await env.prisma.user.create({ data: { username: "viewer", passwordHash: "unused", displayName: "只读", platformRole: "VIEWER" } });
  await env.prisma.projectMembership.create({ data: { projectId, userId: user.id, role: "VIEWER" } });
  await env.prisma.session.create({ data: { id: "viewer-session", userId: user.id, expiresAt: new Date(Date.now() + 600000) } });
  const headers = { cookie: "aiqa_sid=viewer-session" };
  expect((await app.inject({ url: `/api/projects/${projectId}/review`, headers })).statusCode).toBe(200);
  expect((await app.inject({ method: "POST", url: `/api/rule-versions/${ruleId}/approve`, headers, payload: {} })).statusCode).toBe(403);
  expect((await upload(undefined, {}, projectId, headers)).statusCode).toBe(403);
});
it("解析事务失败回滚来源和发布指针，保留源文件支持显式重试", async () => {
  await worker.pause();
  try {
    const response = await upload("数据库写入失败测试"); const id = response.json().jobId;
    const original = env.prisma.$transaction.bind(env.prisma);
    let count = 0;
    const failing = new Proxy(env.prisma, { get(target, key) {
      if (key === "$transaction") return async (fn: any, options: any) => {
        count++;
        if (count === 2) return original(async tx => { await fn(tx); throw new Error("injected commit rollback"); }, options);
        return original(fn, options);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await processAgentJob(failing, cfg(), id);
    const job = await env.prisma.job.findUniqueOrThrow({ where: { id } }); expect(job.status).toBe("FAILED");
    const doc = await env.prisma.documentVersion.findUniqueOrThrow({ where: { id: (job.request as any).documentVersionId } });
    expect(doc).toMatchObject({ parseStatus: "FAILED", bundleStorageKey: null });
    expect(env.store.verify(doc.storageKey, doc.checksum)).toBe(true);
    expect(await env.prisma.sourceSpan.count({ where: { documentVersionId: doc.id } })).toBe(0);
    const retried = await post(`/api/jobs/${id}/retry`);
    expect(retried.statusCode, appErrors.map(String).join("\n")).toBe(202);
  } finally { worker.resume(); }
});


it("上传入队失败仍可靠登记，对账补投后正常解析", async () => {
  await worker.pause();
  let id: string;
  try {
    const spy = vi.spyOn(queue, "add").mockRejectedValueOnce(new Error("queue temporarily unavailable"));
    try { const response = await upload("入队恢复样例"); expect(response.statusCode).toBe(202); id = response.json().jobId; }
    finally { spy.mockRestore(); }
    expect((await env.prisma.job.findUniqueOrThrow({ where: { id: id! } })).status).toBe("QUEUED");
    await env.prisma.job.update({ where: { id: id! }, data: { updatedAt: new Date(Date.now() - 15000) } });
    await reconcileAgentJobs(env.prisma, queue);
  } finally { worker.resume(); }
  expect((await waitJob(id!)).status).toBe("SUCCEEDED");
});

it("模拟或模式未知的 PDF 视觉产物：API 和 worker 都拒绝进入真实规则生成", async () => {
  const source = await env.prisma.document.create({ data: { projectId, title: "PDF 模式边界" } });
  let version = 0;
  for (const format of ["PDF_TEXT", "PDF_SCANNED"]) {
    for (const mode of ["mock", "unknown"]) {
      const doc = await env.prisma.documentVersion.create({ data: {
        documentId: source.id, version: ++version, format, mode, parseStatus: "PARSED", checksum: "test-only", storageKey: "test-only",
      } });
      const response = await post(`/api/projects/${projectId}/rule-extractions`, { documentVersionIds: [doc.id], mode: "real" });
      expect(response.statusCode).toBe(422);
      expect(response.json().message).toContain("模拟视觉");
      // Bypass HTTP and deliver a job directly: the worker repeats the check.
      const job = await env.prisma.job.create({ data: { projectId, kind: "RULE_EXTRACTION", fingerprint: `pdf-mode-${doc.id}`,
        request: { documentVersionIds: [doc.id], mode: "real" } } });
      const invocations = await env.prisma.modelInvocation.count();
      await processAgentJob(env.prisma, cfg(), job.id);
      const result = await env.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
      expect(result.status).toBe("FAILED");
      expect((result.error as any).code).toBe("VALIDATION_ERROR");
      expect((result.error as any).message).toContain("模拟视觉");
      expect(await env.prisma.modelInvocation.count()).toBe(invocations);
    }
  }
});
