import { beforeAll, afterAll, it, expect } from "vitest";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { Queue } from "bullmq";
import { TestCaseVersion, computePlanAcceptanceHash } from "@ai-qa/contracts";
import { emitWorkflowEvent } from "@ai-qa/run-events";
import { buildRunReport } from "@ai-qa/reporting";
import {
  createTestEnv,
  seedMinimalAssets,
  type TestEnv,
} from "../../api/test/helpers/db.js";
import { registerPreparationRoutes } from "../../api/src/routes-preparation.js";
import { registerDataPluginRoutes } from "../../api/src/routes-data-plugins.js";
import { registerWorkflowRoutes } from "../../api/src/routes-workflow.js";
import { registerJobRoutes } from "../../api/src/routes-jobs.js";
import { registerProductRoutes } from "../../api/src/routes-product.js";
import { registerDocumentRoutes } from "../../api/src/routes-documents.js";
import { sendApiError } from "../../api/src/errors.js";
import { WorkerConfig } from "../src/config.js";
import { processAgentJob } from "../src/agent-job-processor.js";
import { reconcileAgentJobs } from "../src/agent-job-recovery.js";
import { prepareData, operateData } from "../src/data-plugin-job.js";
import { advanceWorkflow } from "../src/workflow-orchestrator.js";
import { observeProject } from "../src/observation.js";
import { processRun } from "../src/run-processor.js";

let env: TestEnv,
  actor: any,
  project: any,
  environment: any,
  baseUrl = "",
  outsideUrl = "",
  apiUrl = "",
  queue: Queue,
  redisStarted = false,
  web: ChildProcess | undefined,
  webUrl = "",
  python: ChildProcess | undefined,
  intelligenceUrl = "",
  redisUrl = "";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const app = Fastify(),
  target = Fastify(),
  outside = Fastify();
const resources = new Map<string, unknown>();
let writes = 0,
  leaks = 0,
  failDelete = false,
  loginMode = "good",
  role = "ADMIN",
  queueDown = false,
  browserWrites = 0;
const redisName = "aiqa-p0-" + randomUUID().slice(0, 8);
const password = "p0-test-" + randomUUID();
let modelRequests = 0;
const modelErrors: string[] = [];
const businessRequirement = "申请人提交后显示付款待办。";
function config() {
  return WorkerConfig.parse({
    databaseUrl: env.databaseUrl,
    redisUrl: "redis://127.0.0.1:1",
    artifactDir: env.artifactDir,
    intelligenceBackend: "python",
    intelligenceUrl: intelligenceUrl || undefined,
    intelligenceToken: "p0-internal-only",
  });
}
async function until<T>(fn: () => Promise<T | undefined>, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const r = await fn();
    if (r !== undefined) return r;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("condition timeout");
}
async function request(method: any, url: string, payload?: any, status = 200) {
  const response = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
  });
  expect(response.statusCode, response.body).toBe(status);
  return response.json();
}
const loginUrl = () =>
  `/api/projects/${project.id}/environments/${environment.id}/login-preparations/tester`;
function loginConfig(extra: Record<string, unknown> = {}) {
  return {
    credentialRef: "tester",
    loginPath: "/login",
    timeoutMs: 3000,
    steps: [
      {
        type: "fill",
        locator: { type: "testId", value: "username" },
        value: { source: "credential", ref: "tester.username" },
      },
      {
        type: "fill",
        locator: { type: "testId", value: "password" },
        value: { source: "credential", ref: "tester.password" },
      },
      { type: "click", locator: { type: "testId", value: "submit" } },
    ],
    successIndicator: {
      locator: { type: "testId", value: "success" },
      expectedText: "Welcome",
    },
    invalidIndicator: { type: "testId", value: "invalid" },
    interactiveIndicator: { type: "testId", value: "mfa" },
    ...extra,
  };
}
async function check() {
  const j = await request("POST", loginUrl() + "/check", {}, 202);
  await processAgentJob(env.prisma, config(), j.jobId);
  return request("GET", `/api/jobs/${j.jobId}`);
}
async function plugin(extra: Record<string, unknown> = {}) {
  return request("POST", `/api/projects/${project.id}/data-plugins`, {
    kind: "http-request",
    name: "isolated data",
    environmentId: environment.id,
    definition: {
      prepare: { method: "POST", path: "/resources" },
      inspect: { method: "GET", path: "/resources/{resourceId}" },
      cleanup: {
        method: "DELETE",
        path: "/resources/{resourceId}",
        allow404: true,
      },
      timeoutMs: 1000,
    },
    paramSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: [],
    },
    ...extra,
  });
}
async function data(p: any, key = randomUUID()) {
  return prepareData(
    env.prisma,
    env.store,
    project.id,
    { pluginId: p.id, idempotencyKey: key, params: { name: "pilot" } },
    AbortSignal.timeout(5000),
  );
}
async function workflow(body: any, pid = project.id) {
  return request(
    "POST",
    `/api/projects/${pid}/workflows`,
    { idempotencyKey: randomUUID(), templateVersion: "v1", ...body },
    202,
  );
}
async function tick(id: string) {
  await advanceWorkflow(env.prisma, id, env.store);
  return env.prisma.workflowRun.findUniqueOrThrow({
    where: { id },
    include: { nodes: { orderBy: { seq: "asc" } } },
  });
}
async function childTickAndKill(id: string) {
  const code = `import {PrismaClient} from '@prisma/client';import {ArtifactStore} from '@ai-qa/artifact-store';import {advanceWorkflow} from './src/workflow-orchestrator.ts';const p=new PrismaClient();await advanceWorkflow(p,process.argv[1],new ArtifactStore(process.argv[2]));console.log('checkpoint');setInterval(()=>{},1000);`;
  const child = spawn(
    "node",
    ["--import", "tsx", "--input-type=module", "-e", code, id, env.artifactDir],
    {
      cwd: root + "apps/worker",
      env: { ...process.env, DATABASE_URL: env.databaseUrl },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      let log = "";
      const timer = setTimeout(
        () => reject(new Error("child checkpoint timeout: " + log)),
        10000,
      );
      child.stdout!.on("data", (b) => {
        if (String(b).includes("checkpoint")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.stderr!.on("data", (b) => (log += String(b)));
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(log));
      });
    });
  } finally {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}
beforeAll(async () => {
  env = await createTestEnv("p0");
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
  const port = Number(
    execFileSync("docker", ["port", redisName, "6379/tcp"], {
      encoding: "utf8",
    })
      .trim()
      .split(":")
      .at(-1),
  );
  redisUrl = `redis://127.0.0.1:${port}`;
  queue = new Queue("p0-jobs", { connection: { host: "127.0.0.1", port } });
  actor = await env.prisma.user.create({
    data: {
      username: randomUUID(),
      displayName: "P0 reviewer",
      passwordHash: "unused",
      platformRole: "LEAD",
    },
  });
  project = await env.prisma.project.create({
    data: {
      name: "P0 验收项目",
      memberships: { create: { userId: actor.id, role: "ADMIN" } },
    },
  });
  outside.all("/*", async () => {
    leaks++;
    return { received: true };
  });
  outsideUrl = await outside.listen({ host: "127.0.0.1", port: 0 });
  target.get("/login", async (_req, reply) =>
    reply
      .type("text/html")
      .send(
        `<meta charset="utf-8"><h1>登录</h1><form method="post" action="${loginMode === "external" ? outsideUrl + "/collect" : "/login"}"><input data-testid="username" name="username"><input data-testid="password" name="password" type="password"><button data-testid="submit">登录</button></form>${loginMode === "mfa" ? '<p data-testid="mfa">验证码</p>' : ""}`,
      ),
  );
  target.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) =>
      done(null, Object.fromEntries(new URLSearchParams(String(body)))),
  );
  target.post("/login", async (req, reply) => {
    if (loginMode === "redirect")
      return reply.redirect(outsideUrl + "/collect");
    if (loginMode === "bad")
      return reply
        .type("text/html")
        .send('<p data-testid="invalid">denied</p>');
    if (loginMode === "slow") {
      await new Promise((r) => setTimeout(r, 3500));
      return reply.type("text/html").send("<p>wait</p>");
    }
    const b = req.body as any;
    return reply
      .type("text/html")
      .send(
        b.password === password
          ? '<p data-testid="success">Welcome</p>'
          : '<p data-testid="invalid">denied</p>',
      );
  });
  target.post("/resources", async (req) => {
    writes++;
    const body = req.body as any;
    resources.set(body.resourceId, body);
    return { id: body.resourceId };
  });
  target.post("/delayed-resources", async (req) => {
    writes++;
    const body = req.body as any;
    resources.set(body.resourceId, body);
    await new Promise((r) => setTimeout(r, 3000));
    return { id: body.resourceId };
  });
  target.post("/redirect-resources", async (_req, reply) =>
    reply
      .code(307)
      .header("location", outsideUrl + "/collect")
      .send(),
  );
  target.get("/resources/:id", async (req, reply) =>
    resources.has((req.params as any).id)
      ? { exists: true }
      : reply.code(404).send({ absent: true }),
  );
  target.delete("/resources/:id", async (req, reply) => {
    if (failDelete) return reply.code(500).send({});
    resources.delete((req.params as any).id);
    return { deleted: true };
  });
  // A protocol simulator for orchestration acceptance. This is not a real Kimi quality evaluation.
  target.addHook("onResponse", async (req, reply) => {
    if (req.url.includes("completions") && reply.statusCode >= 400)
      modelErrors.push(req.url + ":" + reply.statusCode);
  });
  target.setErrorHandler((err, _req, reply) => {
    modelErrors.push(err.message);
    return reply.code(500).send({ error: "protocol fixture error" });
  });
  target.post("/v1/chat/completions", async (req, reply) => {
    const wire = req.body as any;
    const u = JSON.parse(
      wire.messages.find((m: any) => m.role === "user").content,
    );
    let result: any;
    modelRequests++;
    if (u.documentVersions) {
      const doc = u.documentVersions[0];
      const span = doc.sourceSpans.find((x: any) =>
        x.quotedText?.includes(businessRequirement),
      );
      if (!span) {
        modelErrors.push(JSON.stringify(doc));
        return reply.code(422).send({ error: "fixture miss" });
      }
      result = {
        ruleDrafts: [
          {
            key: "rule-draft-01",
            statement: businessRequirement,
            classification: "EXPLICIT",
            role: "applicant",
            action: "提交",
            expectation: "付款待办",
            businessFields: [],
            sources: [
              {
                documentVersionId: doc.documentVersionId,
                sourceSpanIds: [span.id],
              },
            ],
            conflictsWith: [],
          },
        ],
        clarifications: [],
        unparsedRanges: [],
      };
    } else if (u.approvedRuleVersions) {
      const rule = u.approvedRuleVersions[0];
      if (rule.statement !== businessRequirement)
        return reply.code(422).send({ error: "fixture miss" });
      result = {
        caseDrafts: [
          {
            title: "提交后状态",
            ruleVersionIds: [rule.id],
            roles: ["applicant"],
            preconditions: [],
            dataSpec: { strategy: "create", note: "浏览器提交" },
            steps: [{ role: "applicant", action: "提交" }],
            assertions: [
              {
                id: "status",
                description: "提交结果",
                kind: "ui.text",
                operator: "equals",
                expected: "付款待办",
                required: true,
                ruleVersionId: rule.id,
              },
            ],
            cleanup: { strategy: "manual", note: "仅隔离测试服务器计数" },
            priority: "P1",
            dimensions: ["HAPPY_PATH"],
          },
        ],
        coverageMap: [
          {
            ruleVersionId: rule.id,
            caseCount: 1,
            dimensionsCovered: ["HAPPY_PATH"],
          },
        ],
        blockedRequirements: [],
      };
    } else if (u.testCase && u.observation) {
      const ref = (id: string) =>
        u.observation.bindings.find(
          (b: any) => b.locator.type === "testId" && b.locator.value === id,
        )?.targetRef;
      if (!ref("submit") || !ref("order-status"))
        return reply.code(422).send({ error: "fixture miss" });
      result = {
        actions: [
          { id: "role", type: "switchRole", role: "applicant", effect: "READ" },
          { id: "goto", type: "goto", path: "/orders", effect: "READ" },
          {
            id: "submit",
            type: "click",
            targetRef: ref("submit"),
            effect: "WRITE",
          },
          {
            id: "check",
            type: "assert",
            assertionId: "status",
            effect: "READ",
          },
        ],
        targets: [{ assertionId: "status", targetRef: ref("order-status") }],
        blockedReasons: [],
      };
    } else {
      modelErrors.push("unexpected input keys " + Object.keys(u).join(","));
      return reply.code(422).send({ error: "fixture miss" });
    }
    return {
      id: "protocol-simulator-" + randomUUID(),
      choices: [
        { finish_reason: "stop", message: { content: JSON.stringify(result) } },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 100 },
    };
  });
  target.get("/build", async () => ({ buildId: "v1" }));
  target.get("/orders", async (_req, reply) =>
    reply
      .type("text/html")
      .send(
        "<meta charset=\"utf-8\"><button data-testid=\"submit\" onclick=\"fetch('/business-write',{method:'POST'}).then(()=>document.querySelector('[data-testid=order-status]').textContent='付款待办')\">Submit</button><output data-testid=\"order-status\">未提交</output>",
      ),
  );
  target.post("/business-write", async () => {
    browserWrites++;
    return { okay: true };
  });
  baseUrl = await target.listen({ host: "127.0.0.1", port: 0 });
  python = spawn(
    root + "services/intelligence/.venv/bin/python",
    [
      "-m",
      "uvicorn",
      "aiqa_intelligence.app:app",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
    ],
    {
      cwd: root + "services/intelligence",
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([k]) => !k.toLowerCase().endsWith("_proxy"),
          ),
        ),
        NO_PROXY: "127.0.0.1,localhost",
        PYTHONPATH: root + "services/intelligence/src",
        AIQA_ARTIFACT_DIR: env.artifactDir,
        AIQA_INTELLIGENCE_TOKEN: "p0-internal-only",
        AIQA_TEXT_PROVIDER: "moonshot",
        AIQA_TEXT_BASE_URL: baseUrl + "/v1",
        AIQA_TEXT_MODEL: "protocol-simulator",
        AIQA_TEXT_API_KEY: "test-only-no-real-key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  intelligenceUrl = await new Promise<string>((resolve, reject) => {
    let log = "";
    const timer = setTimeout(
      () => reject(new Error("Python timeout " + log)),
      10000,
    );
    python!.stderr!.on("data", (b) => {
      log += String(b);
      const m = /Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/.exec(log);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    });
  });
  environment = await env.prisma.environment.create({
    data: {
      projectId: project.id,
      name: "独立测试环境",
      baseUrl,
      allowedOrigins: [baseUrl],
      runtime: {
        secretRefs: {
          tester: {
            usernameEnv: "AIQA_TARGET_P0_USERNAME",
            passwordEnv: "AIQA_TARGET_P0_PASSWORD",
          },
        },
        buildProbe: { path: "/build", field: "buildId" },
      },
    },
  });
  process.env.AIQA_TARGET_P0_USERNAME = "test-user";
  process.env.AIQA_TARGET_P0_PASSWORD = password;
  app.addHook("onRequest", async (req) => {
    req.auth = {
      userId: actor.id,
      username: actor.username,
      displayName: actor.displayName,
      platformRole: "LEAD",
    };
  });
  app.setErrorHandler((e, req, reply) => sendApiError(req, reply, e));
  const outbox = {
    add: async (...args: any[]) => {
      if (queueDown) throw new Error("Redis unavailable");
      return (queue.add as any)(...args);
    },
  };
  registerPreparationRoutes(app, env.prisma, outbox);
  registerDataPluginRoutes(app, env.prisma, outbox);
  registerWorkflowRoutes(app, env.prisma);
  registerJobRoutes(app, env.prisma, queue);
  registerProductRoutes(app, env.prisma, env.store, queue, queue);
  registerDocumentRoutes(app, env.prisma, queue, env.store);
  apiUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  web = spawn("node", ["--import", "tsx", root + "apps/web/src/server.ts"], {
    cwd: root + "apps/web",
    env: { ...process.env, WEB_PORT: "0", API_BASE_URL: apiUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  webUrl = await new Promise<string>((resolve, reject) => {
    let log = "";
    const timer = setTimeout(
      () => reject(new Error("web timeout " + log)),
      10000,
    );
    const read = (b: Buffer) => {
      log += String(b);
      const m = /web ready on (http:\/\/127\.0\.0\.1:\d+)/.exec(log);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    };
    web!.stdout!.on("data", read);
    web!.stderr!.on("data", read);
  });
}, 30000);
afterAll(async () => {
  python?.kill("SIGTERM");
  web?.kill("SIGTERM");
  await app.close();
  await target.close();
  await outside.close();
  await queue?.close();
  if (redisStarted) execFileSync("docker", ["rm", "-f", redisName]);
  delete process.env.AIQA_TARGET_P0_USERNAME;
  delete process.env.AIQA_TARGET_P0_PASSWORD;
  await env?.cleanup();
});

it("登录配置保存不丢字段，真实 Chromium 成功，证据不含凭据", async () => {
  await request("PUT", loginUrl(), loginConfig());
  const j = await check();
  expect(j.result.result.status).toBe("PASS");
  const summary = await request(
    "GET",
    `/api/projects/${project.id}/preparation-summary`,
  );
  expect(summary.environments[0].roles[0].valid).toBe(true);
  const a = await env.prisma.artifact.findUniqueOrThrow({
    where: { id: j.result.result.evidenceArtifactId },
  });
  expect(env.store.read(a.storageKey).toString()).not.toContain(password);
}, 15000);
it.each([
  ["bad", "FAIL_INVALID_CREDENTIALS"],
  ["mfa", "FAIL_INTERACTIVE_AUTH_REQUIRED"],
  ["slow", "FAIL_TIMEOUT"],
])(
  "登录 %s 正确收敛到 %s",
  async (mode, status) => {
    loginMode = mode!;
    try {
      const j = await check();
      expect(j.status).toBe("SUCCEEDED");
      expect(j.result.result.status).toBe(status);
    } finally {
      loginMode = "good";
    }
  },
  15000,
);
it("环境变量缺失明确返回，过期检查不能作为准备证明", async () => {
  delete process.env.AIQA_TARGET_P0_PASSWORD;
  try {
    expect((await check()).result.result.status).toBe("FAIL_MISSING_ENV");
  } finally {
    process.env.AIQA_TARGET_P0_PASSWORD = password;
  }
  await check();
  await env.prisma.loginPreparation.updateMany({
    where: { projectId: project.id },
    data: { lastCheckAt: new Date(0) },
  });
  expect(
    (await request("GET", `/api/projects/${project.id}/preparation-summary`))
      .environments[0].roles[0].valid,
  ).toBe(false);
});
it.each(["external", "redirect"])(
  "登录 %s 越界不泄露凭据",
  async (mode) => {
    loginMode = mode;
    const before = leaks;
    try {
      expect((await check()).result.result.status).not.toBe("PASS");
      expect(leaks).toBe(before);
    } finally {
      loginMode = "good";
    }
  },
  15000,
);
it("定位失败和配置变更使旧检查无效", async () => {
  await request(
    "PUT",
    loginUrl(),
    loginConfig({
      steps: [{ type: "click", locator: { type: "testId", value: "missing" } }],
      timeoutMs: 1000,
    }),
  );
  expect((await check()).result.result.status).toBe("FAIL_LOCATOR_NOT_FOUND");
  await request("PUT", loginUrl(), loginConfig());
  expect(
    (await request("GET", `/api/projects/${project.id}/preparation-summary`))
      .environments[0].roles[0].valid,
  ).toBe(false);
});
it("Redis 入队失败保留检查，真实 Redis 对账补投；取消不复活", async () => {
  queueDown = true;
  const j = await request("POST", loginUrl() + "/check", {}, 202);
  queueDown = false;
  await env.prisma.job.update({
    where: { id: j.jobId },
    data: { updatedAt: new Date(0) },
  });
  await reconcileAgentJobs(env.prisma, queue);
  expect(
    (await queue.getJobs(["waiting"])).some((x) => x.data.jobId === j.jobId),
  ).toBe(true);
  await request("POST", `/api/jobs/${j.jobId}/cancel`, {});
  await processAgentJob(env.prisma, config(), j.jobId);
  expect((await request("GET", `/api/jobs/${j.jobId}`)).status).toBe(
    "CANCELLED",
  );
});
it("登录检查执行中取消和过期租约不能覆盖新结果", async () => {
  loginMode = "slow";
  const j = await request("POST", loginUrl() + "/check", {}, 202);
  const running = processAgentJob(env.prisma, config(), j.jobId);
  await until(async () => {
    const r = await env.prisma.job.findUniqueOrThrow({
      where: { id: j.jobId },
    });
    return r.status === "RUNNING" ? r : undefined;
  });
  await request("POST", `/api/jobs/${j.jobId}/cancel`, {});
  await running;
  loginMode = "good";
  expect((await request("GET", `/api/jobs/${j.jobId}`)).status).toBe(
    "CANCELLED",
  );
}, 10000);
it("并发准备只有一次写入，两个命名空间资源互不影响", async () => {
  const p = await plugin();
  const before = writes;
  const key = randomUUID();
  const results = await Promise.allSettled([data(p, key), data(p, key)]);
  expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  expect(writes - before).toBe(1);
  const first = await data(p, key),
    second = await data(p);
  expect(first.namespace).not.toBe(second.namespace);
  await operateData(
    env.prisma,
    env.store,
    project.id,
    p.id,
    [first.id],
    "cleanup",
    AbortSignal.timeout(5000),
  );
  expect(resources.has(first.externalRef)).toBe(false);
  expect(resources.has(second.externalRef)).toBe(true);
});
it("数据请求 307 不外发，未知结果不会自动重放", async () => {
  const p = await plugin({
    definition: {
      prepare: { method: "POST", path: "/redirect-resources" },
      inspect: { method: "GET", path: "/resources/{resourceId}" },
      cleanup: {
        method: "DELETE",
        path: "/resources/{resourceId}",
        allow404: true,
      },
    },
  });
  const before = leaks,
    key = randomUUID();
  const r = await data(p, key);
  expect(r.status).toBe("unknown");
  await expect(data(p, key)).rejects.toThrow("未重放");
  expect(leaks).toBe(before);
});
it("清理失败保留资源；显式复核后重清理，404 按登记语义处理", async () => {
  const p = await plugin(),
    r = await data(p);
  failDelete = true;
  try {
    expect(
      (
        await operateData(
          env.prisma,
          env.store,
          project.id,
          p.id,
          [r.id],
          "cleanup",
          AbortSignal.timeout(5000),
        )
      )[0]?.status,
    ).toBe("cleanup_failed");
    expect(resources.has(r.externalRef)).toBe(true);
  } finally {
    failDelete = false;
  }
  expect(
    (
      await operateData(
        env.prisma,
        env.store,
        project.id,
        p.id,
        [r.id],
        "cleanup",
        AbortSignal.timeout(5000),
      )
    )[0]?.status,
  ).toBe("cleaned");
  const absent = await data(p);
  resources.delete(absent.externalRef);
  expect(
    (
      await operateData(
        env.prisma,
        env.store,
        project.id,
        p.id,
        [absent.id],
        "inspect",
        AbortSignal.timeout(5000),
      )
    )[0]?.status,
  ).toBe("cleaned");
});
it("拒绝未登记参数、任意 URL、集合清理路径和跨插件资源", async () => {
  await request(
    "POST",
    `/api/projects/${project.id}/data-plugins`,
    {
      kind: "http-request",
      name: "bad",
      environmentId: environment.id,
      definition: {
        prepare: { method: "POST", path: "https://example.com" },
        cleanup: { method: "DELETE", path: "/resources" },
        inspect: { method: "GET", path: "/resources/{resourceId}" },
      },
      paramSchema: { type: "object" },
    },
    422,
  );
  const p = await plugin(),
    q = await plugin();
  const r = await data(p);
  await request(
    "POST",
    `/api/projects/${project.id}/data-plugins/${p.id}/prepare`,
    { idempotencyKey: "bad", params: { url: "https://example.com" } },
    422,
  );
  await request(
    "POST",
    `/api/projects/${project.id}/data-plugins/${q.id}/cleanup`,
    { resourceIds: [r.id] },
    422,
  );
  await request(
    "POST",
    `/api/projects/${project.id}/data-plugins/${p.id}/cleanup`,
    { resourceIds: [] },
    422,
  );
});
it("数据作业状态信封可读，不会返回 500", async () => {
  const p = await plugin();
  const j = await request(
    "POST",
    `/api/projects/${project.id}/data-plugins/${p.id}/prepare`,
    { idempotencyKey: randomUUID(), params: {} },
    202,
  );
  await processAgentJob(env.prisma, config(), j.jobId);
  expect((await request("GET", `/api/jobs/${j.jobId}`)).status).toBe(
    "SUCCEEDED",
  );
});

async function baseline(withPlugin = false) {
  const a = await seedMinimalAssets(env.prisma, env.store);
  await env.prisma.projectMembership.create({
    data: { projectId: a.projectId, userId: actor.id, role: "ADMIN" },
  });
  await env.prisma.environment.update({
    where: { id: a.environmentId },
    data: {
      baseUrl,
      allowedOrigins: [baseUrl],
      runtime: { buildProbe: { path: "/build", field: "buildId" } },
    },
  });
  const observation = await observeProject(env.prisma, env.store, a.projectId, {
    environmentId: a.environmentId,
    pages: [{ role: "applicant", path: "/orders" }],
  });
  const artifact = await env.prisma.artifact.findUniqueOrThrow({
    where: { id: observation.artifactId },
  });
  const bundle = JSON.parse(env.store.read(artifact.storageKey).toString());
  const fixture = withPlugin
    ? await request("POST", `/api/projects/${a.projectId}/data-plugins`, {
        kind: "http-request",
        name: "运行数据",
        environmentId: a.environmentId,
        definition: {
          prepare: { method: "POST", path: "/resources" },
          inspect: { method: "GET", path: "/resources/{resourceId}" },
          cleanup: {
            method: "DELETE",
            path: "/resources/{resourceId}",
            allow404: true,
          },
        },
        paramSchema: { type: "object", properties: {}, required: [] },
      })
    : undefined;
  const old = await env.prisma.testCaseVersion.findUniqueOrThrow({
    where: { id: a.caseVersionId },
  });
  const { id: oldId, createdAt, ...oldData } = old;
  const draft = await env.prisma.testCaseVersion.create({
    data: {
      ...oldData,
      version: 2,
      approvalStatus: "DRAFT",
      semanticFrozen: false,
      approvalHash: null,
      cleanup: fixture
        ? { strategy: "fixture" }
        : { strategy: "manual", note: "测试服务不持久化此计数" },
      ...(fixture
        ? {
            dataSpec: {
              strategy: "fixture",
              fixtureId: fixture.id,
              params: {},
            },
          }
        : {}),
    } as any,
  });
  a.caseVersionId = draft.id;
  await env.prisma.baseline.update({
    where: { id: a.baselineId },
    data: { caseVersionIds: [draft.id] },
  });
  await request("POST", `/api/case-versions/${draft.id}/approve`, {});
  const cv = await env.prisma.testCaseVersion.findUniqueOrThrow({
    where: { id: draft.id },
  });
  const tc = TestCaseVersion.parse({
    ...cv,
    createdAt: cv.createdAt.toISOString(),
    description: undefined,
  });
  const ref = (id: string) =>
    bundle.bindings.find(
      (b: any) => b.locator.type === "testId" && b.locator.value === id,
    ).targetRef;
  const plan: any = {
    schemaVersion: "1.0",
    caseVersionId: cv.id,
    ruleVersionIds: cv.ruleVersionIds,
    roles: cv.roles,
    bindings: bundle.bindings,
    actions: [
      { id: "role", type: "switchRole", role: "applicant", effect: "READ" },
      { id: "goto", type: "goto", path: "/orders", effect: "READ" },
      {
        id: "submit",
        type: "click",
        targetRef: ref("submit"),
        effect: "WRITE",
      },
      { id: "check", type: "assert", assertionId: "a1", effect: "READ" },
    ],
    assertions: [
      {
        ...tc.assertions[0],
        timeoutMs: 1500,
        stepId: "check",
        targetRef: ref("order-status"),
      },
    ],
  };
  plan.acceptanceHash = computePlanAcceptanceHash({ testCase: tc, plan });
  const proposal = await env.prisma.planProposal.create({
    data: {
      projectId: a.projectId,
      caseVersionId: cv.id,
      environmentId: a.environmentId,
      environmentRevision: 1,
      mode: "real",
      plan,
    },
  });
  await request("POST", `/api/plan-proposals/${proposal.id}/approve`, {});
  a.planVersionId = (
    await env.prisma.testPlanVersion.findFirstOrThrow({
      where: { caseVersionId: cv.id },
    })
  ).id;
  return a;
}
it("真实基线→浏览器执行→报告；进程在执行提交点退出后不重复创建 Run", async () => {
  const a = await baseline();
  const w = await workflow(
    {
      inputs: {
        environmentId: a.environmentId,
        baselineId: a.baselineId,
        buildId: "v1",
      },
    },
    a.projectId,
  );
  for (let i = 0; i < 8; i++) await tick(w.workflowId);
  await childTickAndKill(w.workflowId);
  const execution = await env.prisma.workflowNode.findFirstOrThrow({
    where: { workflowId: w.workflowId, nodeKey: "execution" },
  });
  const runId = (execution.outputRef as any).runId;
  expect(runId).toBeTruthy();
  await childTickAndKill(w.workflowId);
  expect(
    await env.prisma.run.count({ where: { projectId: a.projectId } }),
  ).toBe(1);
  const before = browserWrites;
  await processRun(env.prisma, config(), runId);
  expect(browserWrites - before).toBe(1);
  const report = await buildRunReport(env.prisma, env.store, runId);
  expect(report.run.acceptanceStatus, JSON.stringify(report.cases)).toBe(
    "PASS",
  );
  await tick(w.workflowId);
  await tick(w.workflowId);
  expect((await tick(w.workflowId)).status).toBe("COMPLETED");
  const again = await tick(w.workflowId);
  expect(again.status).toBe("COMPLETED");
  expect(browserWrites - before).toBe(1);
  const stream = await fetch(`${apiUrl}/api/workflows/${w.workflowId}/events`, {
    headers: { "last-event-id": "2" },
  });
  const text = await stream.text();
  expect(text).not.toContain("id: 1\n");
  expect(text).toContain("event: stream.end");
}, 40000);
it("入队检查点 SIGKILL 重启复用 Job；过期作业明确失败而不是永久进行中", async () => {
  const doc = await env.prisma.document.create({
    data: { projectId: project.id, title: "采购要求" },
  });
  const v = await env.prisma.documentVersion.create({
    data: {
      documentId: doc.id,
      version: 1,
      format: "MARKDOWN",
      mode: "real",
      parseStatus: "PENDING",
      storageKey: "missing-test",
      checksum: "x",
    },
  });
  const w = await workflow({
    inputs: { environmentId: environment.id, documentVersionIds: [v.id] },
  });
  await childTickAndKill(w.workflowId);
  const node = await env.prisma.workflowNode.findFirstOrThrow({
    where: { workflowId: w.workflowId, nodeKey: "document_parse" },
  });
  const id = (node.outputRef as any).jobIds[0];
  await childTickAndKill(w.workflowId);
  expect(
    (
      await env.prisma.workflowNode.findUniqueOrThrow({
        where: { id: node.id },
      })
    ).outputRef,
  ).toEqual(node.outputRef);
  await env.prisma.job.update({
    where: { id },
    data: { status: "RUNNING", startedAt: new Date(0), updatedAt: new Date(0) },
  });
  await reconcileAgentJobs(env.prisma, queue);
  expect((await tick(w.workflowId)).status).toBe("FAILED");
  expect((await request("GET", `/api/jobs/${id}`)).status).toBe("FAILED");
}, 25000);
it("人工门重启保留待办；VIEWER 不能确认，未批准资产不能越过门，取消后不能复活", async () => {
  const a = await baseline();
  const w = await workflow(
    { inputs: { environmentId: a.environmentId, baselineId: a.baselineId } },
    a.projectId,
  );
  for (let i = 0; i < 3; i++) await tick(w.workflowId);
  // Explicitly put a real rule approval gate into a review-required state, as document generation does.
  const node = await env.prisma.workflowNode.findFirstOrThrow({
    where: { workflowId: w.workflowId, nodeKey: "rule_approval_gate" },
  });
  await env.prisma.workflowNode.update({
    where: { id: node.id },
    data: { status: "waiting_human" },
  });
  await env.prisma.workflowRun.update({
    where: { id: w.workflowId },
    data: { status: "WAITING_HUMAN", currentGate: node.nodeKey },
  });
  await childTickAndKill(w.workflowId);
  expect((await tick(w.workflowId)).status).toBe("WAITING_HUMAN");
  await env.prisma.projectMembership.updateMany({
    where: { projectId: a.projectId, userId: actor.id },
    data: { role: "VIEWER" },
  });
  await request(
    "POST",
    `/api/workflows/${w.workflowId}/nodes/${node.nodeKey}/confirm`,
    { decision: "approve" },
    403,
  );
  await request("POST", `/api/workflows/${w.workflowId}/cancel`, {}, 403);
  await env.prisma.projectMembership.updateMany({
    where: { projectId: a.projectId, userId: actor.id },
    data: { role: "ADMIN" },
  });
  const base = await env.prisma.baseline.findUniqueOrThrow({
    where: { id: a.baselineId },
  });
  await env.prisma.ruleVersion.update({
    where: { id: base.ruleVersionIds[0] },
    data: { reviewStatus: "DRAFT" },
  });
  await request(
    "POST",
    `/api/workflows/${w.workflowId}/nodes/${node.nodeKey}/confirm`,
    { decision: "approve" },
    409,
  );
  await request("POST", `/api/workflows/${w.workflowId}/cancel`, {});
  await request(
    "POST",
    `/api/workflows/${w.workflowId}/nodes/${node.nodeKey}/confirm`,
    { decision: "approve" },
    409,
  );
  expect((await tick(w.workflowId)).status).toBe("CANCELLED");
}, 20000);
it("工作流并发幂等、事件序号连续、预算耗尽不启动后续节点", async () => {
  const a = await baseline();
  const body = {
    idempotencyKey: randomUUID(),
    templateVersion: "v1",
    inputs: { environmentId: a.environmentId, baselineId: a.baselineId },
  };
  const [x, y] = await Promise.all([
    request("POST", `/api/projects/${a.projectId}/workflows`, body, 202),
    request("POST", `/api/projects/${a.projectId}/workflows`, body, 202),
  ]);
  expect(x.workflowId).toBe(y.workflowId);
  await request(
    "POST",
    `/api/projects/${a.projectId}/workflows`,
    { ...body, inputs: { ...body.inputs, buildId: "other" } },
    409,
  );
  await Promise.all(
    Array.from({ length: 20 }, () =>
      emitWorkflowEvent(env.prisma, x.workflowId, "workflow.node_started", {}),
    ),
  );
  const events = await env.prisma.workflowEvent.findMany({
    where: { workflowId: x.workflowId },
    orderBy: { seq: "asc" },
  });
  expect(events.map((e) => e.seq)).toEqual(
    Array.from({ length: 21 }, (_, i) => i + 1),
  );
  await env.prisma.workflowRun.update({
    where: { id: x.workflowId },
    data: { createdAt: new Date(0) },
  });
  expect((await tick(x.workflowId)).status).toBe("FAILED");
  expect(
    await env.prisma.run.count({ where: { projectId: a.projectId } }),
  ).toBe(0);
});
it("准备中心及工作流页面能在真实浏览器打开、填写和提交", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addCookies([
      { name: "web_sid", value: "p0-test", url: webUrl },
    ]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    expect(
      (await page.goto(`${webUrl}/preparation/${project.id}`))?.status(),
    ).toBe(200);
    await expect(page.locator("h1").innerText()).resolves.toBe("准备中心");
    await page.getByText("配置登录步骤", { exact: true }).click();
    const form = page.locator('form[action$="/login"]');
    for (const [name, value] of Object.entries({
      role: "tester",
      credentialRef: "tester",
      loginPath: "/login",
      usernameTarget: "username",
      passwordTarget: "password",
      submitTarget: "submit",
      successTarget: "success",
      successText: "Welcome",
    }))
      await form.locator(`[name="${name}"]`).fill(value);
    await form.getByRole("button").click();
    expect(
      (
        await env.prisma.loginPreparation.findFirstOrThrow({
          where: { projectId: project.id },
        })
      ).configuration,
    ).toMatchObject({ loginPath: "/login" });
    expect(
      (await page.goto(`${webUrl}/workflows/project/${project.id}`))?.status(),
    ).toBe(200);
    expect(await page.locator("h1").innerText()).toBe("测试工作流");
    expect(errors).toEqual([]);
    mkdirSync(root + "data/pilot-evidence", { recursive: true });
    await page.screenshot({
      path: root + "data/pilot-evidence/p0-workflows.png",
      fullPage: true,
    });
    await page.goto(`${webUrl}/preparation/${project.id}`);
    await page.screenshot({
      path: root + "data/pilot-evidence/p0-preparation.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  } finally {
    await browser.close();
  }
}, 25000);

it("需求资料→Python真实解析与网关→三个批准门→真实浏览器→评估（模型协议模拟器）", async () => {
  const p = await env.prisma.project.create({
    data: {
      name: "完整流程",
      memberships: { create: { userId: actor.id, role: "ADMIN" } },
    },
  });
  const e = await env.prisma.environment.create({
    data: {
      projectId: p.id,
      name: "测试",
      baseUrl,
      allowedOrigins: [baseUrl],
      runtime: { buildProbe: { path: "/build", field: "buildId" } },
    },
  });
  const file = env.store.put({
    runId: "workflow-doc",
    attemptId: randomUUID(),
    filename: "requirements.md",
    data: Buffer.from(businessRequirement),
  });
  const doc = await env.prisma.document.create({
    data: { projectId: p.id, title: "提交状态要求" },
  });
  const v = await env.prisma.documentVersion.create({
    data: {
      documentId: doc.id,
      version: 1,
      mode: "real",
      format: "MARKDOWN",
      parseStatus: "PENDING",
      storageKey: file.storageKey,
      checksum: file.checksum,
      fileSizeBytes: file.size,
    },
  });
  const w = await workflow(
    {
      inputs: {
        environmentId: e.id,
        documentVersionIds: [v.id],
        observationPages: [{ role: "applicant", path: "/orders" }],
        buildId: "v1",
      },
    },
    p.id,
  );
  const gates: string[] = [];
  const before = modelRequests;
  for (let i = 0; i < 35; i++) {
    const current = await tick(w.workflowId);
    expect(
      current.status,
      JSON.stringify(current.nodes.filter((n) => n.error)),
    ).not.toBe("FAILED");
    if (current.status === "COMPLETED") break;
    for (const n of current.nodes) {
      const ref = n.outputRef as any;
      for (const id of ref?.jobIds ?? []) {
        const j = await env.prisma.job.findUniqueOrThrow({ where: { id } });
        if (j.status === "QUEUED") {
          await processAgentJob(env.prisma, config(), id);
          const done = await env.prisma.job.findUniqueOrThrow({
            where: { id },
          });
          expect(
            done.status,
            JSON.stringify({ error: done.error, modelErrors, modelRequests }),
          ).toBe("SUCCEEDED");
        }
      }
      if (ref?.runId) {
        const run = await env.prisma.run.findUniqueOrThrow({
          where: { id: ref.runId },
        });
        if (run.lifecycle === "QUEUED")
          await processRun(env.prisma, config(), run.id);
      }
    }
    if (current.status === "WAITING_HUMAN") {
      gates.push(current.currentGate!);
      const node = current.nodes.find(
        (n) => n.nodeKey === current.currentGate,
      )!;
      if (node.nodeKey === "rule_approval_gate") {
        await childTickAndKill(w.workflowId);
        const rules = await env.prisma.ruleVersion.findMany({
          where: { rule: { projectId: p.id } },
        });
        for (const r of rules)
          await request("POST", `/api/rule-versions/${r.id}/approve`, {});
      }
      if (node.nodeKey === "case_approval_gate") {
        const cases = await env.prisma.testCaseVersion.findMany({
          where: { projectId: p.id },
        });
        for (const c of cases)
          await request("POST", `/api/case-versions/${c.id}/approve`, {});
      }
      if (node.nodeKey === "plan_proposal_gate") {
        for (const id of (node.outputRef as any).proposalIds)
          await request("POST", `/api/plan-proposals/${id}/approve`, {});
      }
      await request(
        "POST",
        `/api/workflows/${w.workflowId}/nodes/${node.nodeKey}/confirm`,
        { decision: "approve" },
      );
    }
  }
  const done = await tick(w.workflowId);
  expect(done.status, JSON.stringify(done.nodes)).toBe("COMPLETED");
  expect(gates).toEqual([
    "rule_approval_gate",
    "case_approval_gate",
    "plan_proposal_gate",
  ]);
  expect(modelRequests - before).toBe(3);
  expect(
    (done.nodes.find((n) => n.nodeKey === "evaluation")!.outputRef as any)
      .acceptanceStatus,
  ).toBe("PASS");
  const spans = await env.prisma.sourceSpan.findMany({
    where: { documentVersionId: v.id },
    select: { id: true },
  });
  const next = await workflow(
    {
      inputs: {
        environmentId: e.id,
        documentVersionIds: [v.id],
        observationPages: [{ role: "applicant", path: "/orders" }],
      },
    },
    p.id,
  );
  const reused = await tick(next.workflowId);
  expect(reused.nodes[0]?.status).toBe("skipped");
  expect(
    await env.prisma.sourceSpan.findMany({
      where: { documentVersionId: v.id },
      select: { id: true },
    }),
  ).toEqual(spans);
}, 60000);

it("写入已发生但响应前 SIGKILL：资源待核对，不重复创建，核对后可清理", async () => {
  const p = await plugin({
      definition: {
        prepare: { method: "POST", path: "/delayed-resources" },
        inspect: { method: "GET", path: "/resources/{resourceId}" },
        cleanup: {
          method: "DELETE",
          path: "/resources/{resourceId}",
          allow404: true,
        },
        timeoutMs: 10000,
      },
    }),
    key = randomUUID(),
    before = writes;
  const script = `import {PrismaClient} from '@prisma/client';import {ArtifactStore} from '@ai-qa/artifact-store';import {prepareData} from './src/data-plugin-job.ts';const p=new PrismaClient();await prepareData(p,new ArtifactStore(process.argv[1]),process.argv[2],{pluginId:process.argv[3],idempotencyKey:process.argv[4],params:{name:'pilot'}},AbortSignal.timeout(15000));await p.$disconnect();`;
  const child = spawn(
    "node",
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      script,
      env.artifactDir,
      project.id,
      p.id,
      key,
    ],
    {
      cwd: root + "apps/worker",
      env: { ...process.env, DATABASE_URL: env.databaseUrl },
      stdio: "ignore",
    },
  );
  let resource: any;
  try {
    resource = await until(async () => {
      const r = await env.prisma.dataResource.findFirst({
        where: { pluginId: p.id },
      });
      return r && resources.has(r.externalRef) ? r : undefined;
    });
  } finally {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
  expect(resource.status).toBe("pending");
  await env.prisma.dataResource.update({
    where: { id: resource.id },
    data: { updatedAt: new Date(0) },
  });
  await reconcileAgentJobs(env.prisma, queue);
  expect(
    (
      await env.prisma.dataResource.findUniqueOrThrow({
        where: { id: resource.id },
      })
    ).status,
  ).toBe("unknown");
  await expect(data(p, key)).rejects.toThrow("未重放");
  expect(writes - before).toBe(1);
  const cleaned = await operateData(
    env.prisma,
    env.store,
    project.id,
    p.id,
    [resource.id],
    "cleanup",
    AbortSignal.timeout(5000),
  );
  expect(cleaned[0]?.status).toBe("cleaned");
  expect(resources.has(resource.externalRef)).toBe(false);
}, 15000);
it.each([false, true])(
  "数据插件进入真实 Run 并清理，清理失败=%s 不会静默通过",
  async (broken) => {
    const a = await baseline(true);
    const w = await workflow(
      {
        inputs: {
          environmentId: a.environmentId,
          baselineId: a.baselineId,
          buildId: "v1",
        },
      },
      a.projectId,
    );
    for (let i = 0; i < 9; i++) await tick(w.workflowId);
    const node = await env.prisma.workflowNode.findFirstOrThrow({
      where: { workflowId: w.workflowId, nodeKey: "execution" },
    });
    const runId = (node.outputRef as any).runId;
    expect(runId).toBeTruthy();
    failDelete = broken;
    try {
      await processRun(env.prisma, config(), runId);
    } finally {
      failDelete = false;
    }
    const report = await buildRunReport(env.prisma, env.store, runId);
    const rows = await env.prisma.dataResource.findMany({ where: { runId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attemptId).toBeTruthy();
    expect(rows[0]?.status).toBe(broken ? "cleanup_failed" : "cleaned");
    expect(report.run.acceptanceStatus).toBe(broken ? "INCOMPLETE" : "PASS");
    expect(report.cases[0]?.verdict).toBe(broken ? "BLOCKED" : "PASS");
  },
  20000,
);

it("启动真实 worker 后无需页面轮询：数据库调度→BullMQ→执行→完成", async () => {
  const a = await baseline();
  const w = await workflow(
    {
      inputs: {
        environmentId: a.environmentId,
        baselineId: a.baselineId,
        buildId: "v1",
      },
    },
    a.projectId,
  );
  const worker = spawn("node", ["--import", "tsx", "src/server.ts"], {
    cwd: root + "apps/worker",
    env: {
      ...process.env,
      DATABASE_URL: env.databaseUrl,
      REDIS_URL: redisUrl,
      WORKER_PORT: "0",
      WORKER_HOST: "127.0.0.1",
      AIQA_ARTIFACT_DIR: env.artifactDir,
      AIQA_INTELLIGENCE_BACKEND: "python",
      AIQA_INTELLIGENCE_URL: intelligenceUrl,
      AIQA_INTELLIGENCE_TOKEN: "p0-internal-only",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  worker.stderr!.on("data", (b) => {
    log += String(b);
  });
  try {
    const result = await until(async () => {
      const wf = await env.prisma.workflowRun.findUniqueOrThrow({
        where: { id: w.workflowId },
      });
      if (wf.status === "FAILED") throw new Error("workflow failed " + log);
      return wf.status === "COMPLETED" ? wf : undefined;
    }, 55000);
    expect(result.status).toBe("COMPLETED");
    expect(
      await env.prisma.run.count({ where: { projectId: a.projectId } }),
    ).toBe(1);
  } finally {
    worker.kill("SIGKILL");
    await once(worker, "exit");
  }
}, 60000);
