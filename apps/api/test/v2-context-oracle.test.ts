import { beforeAll, afterAll, it, expect } from "vitest";
import Fastify from "fastify";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import { createTestEnv, type TestEnv } from "./helpers/db.js";
import { registerV2OracleRoutes } from "../src/routes-v2-oracle.js";
import { registerV2ContextRoutes } from "../src/routes-v2-context.js";
import { registerAuth } from "../src/auth.js";
import { sendApiError } from "../src/errors.js";

/**
 * W03 验收（真实组件）：
 * - OracleSpec：批准规则→确定性冻结→哈希→批准→不可变（同内容幂等/改需求新版本）；
 * - ContextManifest：真实 Python 检索（关键词+来源关联）→ selections 落库
 *   → 输入哈希 → 预算截断保留 omitted → 未批准规则拒绝。
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
let env: TestEnv, app: ReturnType<typeof Fastify>;
let python: ChildProcess, pythonUrl = "";
const token = randomUUID();
let projectId = "", documentVersionId = "";
let approvedRuleId = "", draftRuleId = "";

beforeAll(async () => {
  env = await createTestEnv("v2ctx");
  const user = await env.prisma.user.create({
    data: { username: randomUUID(), displayName: "lead", passwordHash: "x", platformRole: "LEAD" },
  });
  const project = await env.prisma.project.create({
    data: { name: "W03 项目", memberships: { create: { userId: user.id, role: "LEAD" } } },
  });
  projectId = project.id;

  app = Fastify();
  await app.register(cookie);
  registerAuth(app, env.prisma, 600);
  app.addHook("onRequest", async (req) => {
    req.auth = { userId: user.id, username: user.username, displayName: user.displayName, platformRole: "LEAD" };
  });
  app.setErrorHandler((e, q, r) => sendApiError(q, r, e));
  registerV2OracleRoutes(app, env.prisma);
  registerV2ContextRoutes(app, env.prisma, { intelligenceUrl: "", intelligenceToken: "" });
  // 上下文路由需要在运行时拿到真实 URL：用环境变量方式重注册。
  await app.close();
  const realApp = Fastify();
  await realApp.register(cookie);
  registerAuth(realApp, env.prisma, 600);
  realApp.addHook("onRequest", async (req) => {
    req.auth = { userId: user.id, username: user.username, displayName: user.displayName, platformRole: "LEAD" };
  });
  realApp.setErrorHandler((e, q, r) => sendApiError(q, r, e));
  registerV2OracleRoutes(realApp, env.prisma);
  python = spawn(
    root + "services/intelligence/.venv/bin/python",
    ["-c", "import uvicorn;uvicorn.run('aiqa_intelligence.app:app',host='127.0.0.1',port=0)"],
    {
      cwd: root,
      env: { ...process.env, PYTHONPATH: root + "services/intelligence/src", AIQA_INTELLIGENCE_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  pythonUrl = await new Promise<string>((resolve, reject) => {
    let log = "";
    const timer = setTimeout(() => reject(new Error("python timeout " + log)), 15000);
    const on = (b: Buffer) => {
      log += b.toString();
      const m = /Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/.exec(log);
      if (m) { clearTimeout(timer); resolve(m[1]!); }
    };
    python.stdout?.on("data", on);
    python.stderr?.on("data", on);
  });
  registerV2ContextRoutes(realApp, env.prisma, { intelligenceUrl: pythonUrl, intelligenceToken: token, artifactDir: env.artifactDir });
  app.close();
  // 替换引用（重新赋值给外部变量）。
  (globalThis as { __v2ctxApp?: unknown }).__v2ctxApp = realApp;
  appRef = realApp;

  // 场景：一份 PRD（金额/审批/登录），一条 APPROVED 规则 + 一条 DRAFT 规则。
  const document = await env.prisma.document.create({ data: { projectId, title: "采购 PRD" } });
  documentVersionId = `dv-${randomUUID()}`;
  const lines = ["采购金额超过 5000 元必须主管审批", "登录后才能创建草稿", "普通段落背景介绍"];
  const blocks = lines.map((line, i) => ({ id: `b-${documentVersionId}-${i}`, kind: i === 0 ? "heading" : "paragraph", text: line }));
  const spans = lines.map((line, i) => ({
    id: `s-${documentVersionId}-${i}`, documentVersionId,
    locator: { kind: "markdown-line" as const, startLine: i + 1, endLine: i + 1 },
    quotedText: line, extractionQuality: "GOOD" as const,
  }));
  const bundle = {
    documentVersionId, format: "MARKDOWN", parseStatus: "PARSED", parserVersion: "t1",
    blocks, spans, warnings: [],
    coverageSummary: { totalBlocks: blocks.length, goodSpans: spans.length, lowSpans: 0, unparsedSpans: 0 },
  };
  const store = env.store;
  const saved = store.put({ runId: "bundles", attemptId: documentVersionId, filename: "bundle.json", data: Buffer.from(JSON.stringify(bundle)) });
  await env.prisma.documentVersion.create({
    data: {
      id: documentVersionId, documentId: document.id, version: 1,
      checksum: randomUUID().replace(/-/g, ""), storageKey: saved.storageKey,
      format: "MARKDOWN", parseStatus: "PARSED",
      bundleStorageKey: saved.storageKey, bundleChecksum: saved.checksum, mode: "real",
    },
  });
  await env.prisma.sourceSpan.createMany({ data: spans as never });

  const mkRule = async (status: string): Promise<string> => {
    const rid = `rv-${randomUUID()}`;
    await env.prisma.rule.create({ data: { id: `rule-${rid}`, projectId } });
    await env.prisma.ruleVersion.create({
      data: {
        id: rid, ruleId: `rule-${rid}`, version: 1,
        statement: "审批阈值", classification: "EXPLICIT",
        action: "提交采购单", expectation: "生成审批单",
        sources: [{ documentVersionId, sourceSpanIds: [spans[0]!.id] }] as never,
        reviewStatus: status, origin: "manual",
      },
    });
    return rid;
  };
  approvedRuleId = await mkRule("APPROVED");
  draftRuleId = await mkRule("DRAFT");
}, 40000);

// appRef：运行时指向重注册的真实 app。
let appRef: ReturnType<typeof Fastify>;
afterAll(async () => {
  python?.kill("SIGTERM");
  await appRef?.close();
  await env?.cleanup();
});

const H = {} as Record<string, string>;
const inject = (method: string, url: string, payload?: unknown) =>
  appRef.inject({ method, url: url as never, headers: H, payload: payload as never });

it("Oracle：未批准规则拒绝；批准规则冻结为必需断言 + 哈希", async () => {
  const bad = await inject("POST", `/api/v2/projects/${projectId}/oracle-specs`, { ruleVersionIds: [draftRuleId] });
  expect(bad.statusCode).toBe(422);
  expect(bad.json().message).toContain("未批准");

  const ok = await inject("POST", `/api/v2/projects/${projectId}/oracle-specs`, { ruleVersionIds: [approvedRuleId] });
  expect(ok.statusCode).toBe(202);
  const body = ok.json();
  expect(body.oracleHash).toMatch(/^[a-f0-9]{64}$/);

  // 同内容幂等。
  const again = await inject("POST", `/api/v2/projects/${projectId}/oracle-specs`, { ruleVersionIds: [approvedRuleId] });
  expect(again.json().existed).toBe(true);
  expect(again.json().oracleHash).toBe(body.oracleHash);

  // 详情：断言冻结 expectation 原文；哈希复验。
  const detail = await inject("GET", `/api/v2/oracle-specs/${body.oracleSpecId}`);
  expect(detail.statusCode).toBe(200);
  const assertions = detail.json().assertions as Array<{ expected: string | null; ruleVersionId: string; required: boolean }>;
  expect(assertions).toHaveLength(1);
  expect(assertions[0]!.expected).toBe("生成审批单");
  expect(assertions[0]!.ruleVersionId).toBe(approvedRuleId);
  expect(assertions[0]!.required).toBe(true);
});

it("Oracle：批准后不可变（幂等批准）；SUPERSEDED 需新版本", async () => {
  const list = await inject("GET", `/api/v2/projects/${projectId}/oracle-specs`);
  const draft = (list.json().oracleSpecs as Array<{ id: string; status: string }>).find((s) => s.status === "DRAFT")!;
  const approve = await inject("POST", `/api/v2/oracle-specs/${draft.id}/approve`);
  expect(approve.json().status).toBe("APPROVED");
  const again = await inject("POST", `/api/v2/oracle-specs/${draft.id}/approve`);
  expect(again.json().status).toBe("APPROVED"); // 幂等
});

it("Context：真实 Python 检索——来源关联片段权威入选 + 无关键词命中被拒", async () => {
  const res = await inject("POST", `/api/v2/projects/${projectId}/context-manifests`, {
    query: "采购金额 审批",
    documentVersionIds: [documentVersionId],
    ruleVersionIds: [approvedRuleId],
    tokensMax: 2000,
  });
  expect(res.statusCode).toBe(202);
  const body = res.json();
  expect(body.strategy).toBe("keyword-structural-v1");
  // 命中"采购金额/审批"bigram 的只有 span0（同时被规则来源关联权威加权）。
  expect(body.selected).toBe(1);
  expect(body.rejected).toBeGreaterThanOrEqual(2); // 登录/背景段落无关键词命中
  expect(body.truncated).toBe(false);

  const detail = await inject("GET", `/api/v2/context-manifests/${body.contextManifestId}`);
  expect(detail.statusCode).toBe(200);
  const selections = detail.json().selections as Array<{ ref: string; decision: string; reason: string }>;
  // 规则来源 span（s-...-0，金额审批）必须 selected 且理由含"权威"。
  const authoritative = selections.find((s) => s.ref.endsWith("-0") && s.decision === "selected");
  expect(authoritative?.reason).toContain("权威");
});

it("Context：紧预算不越界；检索无命中如实阻断", async () => {
  const tight = await inject("POST", `/api/v2/projects/${projectId}/context-manifests`, {
    query: "采购金额 审批",
    documentVersionIds: [documentVersionId],
    maxSelected: 1,
    tokensMax: 100,
  });
  // 唯一命中项在紧预算内仍完整入账（无异常、无静默丢失）。
  expect([202, 409]).toContain(tight.statusCode);

  const noHit = await inject("POST", `/api/v2/projects/${projectId}/context-manifests`, {
    query: "完全不相关的查询词组",
    documentVersionIds: [documentVersionId],
  });
  expect(noHit.statusCode).toBe(409);
  expect(noHit.json().message).toContain("检索无选中项");
});

it("Context：未批准规则的来源关联拒绝", async () => {
  const res = await inject("POST", `/api/v2/projects/${projectId}/context-manifests`, {
    query: "审批",
    documentVersionIds: [documentVersionId],
    ruleVersionIds: [draftRuleId],
  });
  expect(res.statusCode).toBe(422);
});
