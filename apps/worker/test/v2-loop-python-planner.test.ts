import { beforeAll, afterAll, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createTestEnv, type TestEnv } from "../../api/test/helpers/db.js";
import { runDraftSessionLoop } from "../src/v2/session-loop.js";
import { registerBuiltinSamples } from "../src/v2/samples.js";
import { computeOracleHash } from "@ai-qa/contracts";

/**
 * W04 python-real 规划器（真实 HTTP 通道；mock 模型回放=内核验证，不冒充真实模型效果）。
 * 服务端 Python 起真实进程；TextModelRequest mock 网关按 purpose+输入哈希回放，
 * 缺失即 MODEL_OUTPUT_INVALID（确定性协议）。循环护栏：title≠标准拒绝。
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
let env: TestEnv;
let draftServer: ReturnType<typeof spawn>, draftPort = 0, draftBaseUrl = "";
let python: ReturnType<typeof spawn>, pythonUrl = "", pythonToken = randomUUID();
let projectId = "", environmentId = "";

// Python mock 网关回放：真实模型网关按 mode=real 才用真实凭据——这里显式 mock 模式请求由测试注入。
// wire mode 是 real（循环以 real 调用），因此用 http_fixture 式注入不可行；
// 改为环境变量控制：AIQA_LOOP_PLANNER_FIXTURE 指向回放文件（仅测试）。
const fixtureDir = mkdtempSync(join(tmpdir(), "loop-planner-fixtures-"));

beforeAll(async () => {
  env = await createTestEnv("v2pyplan");
  const user = await env.prisma.user.create({
    data: { username: randomUUID(), displayName: "lead", passwordHash: "x", platformRole: "LEAD" },
  });
  const project = await env.prisma.project.create({
    data: { name: "python 规划项目", memberships: { create: { userId: user.id, role: "ADMIN" } } },
  });
  projectId = project.id;

  draftPort = 20000 + Math.floor(Math.random() * 20000);
  draftBaseUrl = `http://127.0.0.1:${draftPort}`;
  draftServer = spawn("node", [join(root, "examples/synthetic/draft-app/server.mjs"), "--port", String(draftPort)], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("draft timeout")), 8000);
    const on = (b: Buffer) => { if (b.toString().includes("ready")) { clearTimeout(timer); resolve(); } };
    draftServer.stdout?.on("data", on);
    draftServer.stderr?.on("data", on);
  });

  const environment = await env.prisma.environment.create({
    data: { projectId, name: "synthetic", baseUrl: draftBaseUrl, allowedOrigins: [draftBaseUrl] },
  });
  environmentId = environment.id;

  // Python 智能服务（真实进程；文本通道指向 mock 回放网关——AIQA_TEXT_PROVIDER=mock）。
  python = spawn(
    root + "services/intelligence/.venv/bin/python",
    ["-c", "import uvicorn;uvicorn.run('aiqa_intelligence.app:app',host='127.0.0.1',port=0)"],
    {
      cwd: root,
      env: {
        ...process.env,
        PYTHONPATH: root + "services/intelligence/src",
        AIQA_INTELLIGENCE_TOKEN: pythonToken,
        AIQA_TEXT_PROVIDER: "mock",
        AIQA_TEXT_API_KEY: "",
      },
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

  registerBuiltinSamples();

  // 安装+授权合成能力（直接落库：哈希用真实清单计算）。
  const { DraftOpsManifest } = await import("@ai-qa/adapter-sdk/samples/draft-ops");
  const { computeManifestHash } = await import("@ai-qa/contracts");
  const manifestHash = computeManifestHash(DraftOpsManifest as never);
  await env.prisma.v2CapabilityManifest.create({
    data: {
      projectId, capabilityId: DraftOpsManifest.id, version: DraftOpsManifest.version,
      manifestHash, manifest: DraftOpsManifest as never, createdBy: "t",
    },
  });
  await env.prisma.v2AdapterInstallation.create({
    data: {
      projectId, capabilityId: DraftOpsManifest.id, capabilityVersion: DraftOpsManifest.version,
      manifestHash, installedBy: "t", status: "AUTHORIZED", endpoint: null,
      authorization: { grantedBy: "t", grantedAt: new Date().toISOString(), scope: ["draft:ops"], revokedBy: null, revokedAt: null } as never,
    },
  });
}, 40000);

afterAll(async () => {
  python?.kill("SIGTERM");
  draftServer?.kill("SIGTERM");
  await env?.cleanup();
});

const TARGET = "验收目标名称";

let oracleVersion = 0;
async function createSession(): Promise<string> {
  oracleVersion += 1;
  const dims = ["normal", "boundary", "permission", "multi_role", "state", "persistence"] as const;
  const ruleVersionId = `rv-py-${randomUUID().slice(0, 8)}`;
  const assertions = [{
    id: "a-title", ruleVersionId, kind: "deterministic",
    fact: "草稿标题", observationType: "api_field", observationRef: "draft.title",
    operator: "equals", expected: TARGET, precondition: null, unit: null, tolerance: null,
    allowedRoles: [], required: true,
  }];
  const coverageDeclarations = dims.map((dimension) => ({ ruleVersionId, dimension, status: "planned", reason: "python 规划测试" }));
  const oracleHash = computeOracleHash({ projectId, ruleVersionIds: [ruleVersionId], assertions: assertions as never, semanticCandidates: [], coverageDeclarations });
  const oracle = await env.prisma.v2OracleSpec.create({
    data: {
      projectId, version: oracleVersion, status: "APPROVED", ruleVersionIds: [ruleVersionId],
      assertions: assertions as never, semanticCandidates: [], coverageDeclarations,
      oracleHash, createdBy: "t", approvedBy: "t", approvedAt: new Date(),
    },
  });
  return (await env.prisma.v2ExecutionSession.create({
    data: {
      projectId, goal: "创建草稿→改名→刷新仍保留名称",
      oracleSpecId: oracle.id, oracleHash,
      profileId: "profile-py-real", profileHash: "0".repeat(64),
      definitionId: "def-draft-loop", definitionVersion: 1,
      environmentId, buildId: "synthetic",
      budget: { maxWallClockMs: 120000, maxActiveMs: 120000, maxModelCalls: 10, maxTokens: 100000, maxToolCalls: 100, maxResources: 5, maxCostMicros: null },
      usage: {},
    },
  })).id;
}

it("python-real 通道：缺智能服务配置显式拒绝（CONFIG_MISSING）", async () => {
  const sessionId = await createSession();
  await expect(runDraftSessionLoop({
    prisma: env.prisma, sessionId, baseUrl: draftBaseUrl, planner: "python-real",
  })).rejects.toMatchObject({ code: "CONFIG_MISSING" });
});

it("python-real 通道：真实 HTTP 到 Python；mock 文本网关无注册回放 → 受控失败（不冒充成功）", async () => {
  const sessionId = await createSession();
  const result = await runDraftSessionLoop({
    prisma: env.prisma, sessionId, baseUrl: draftBaseUrl, planner: "python-real",
    intelligence: { url: pythonUrl, token: pythonToken },
    maxRounds: 4,
  }).catch((e: unknown) => ({ status: "THREW", code: (e as { code?: string }).code, reason: String((e as Error).message) }));
  // mock 网关缺注册 → MODEL_OUTPUT_INVALID/VALIDATION 类受控错误；绝不能假 completed。
  expect(["FAILED", "THREW"]).toContain(result.status);
  expect(result.reason ?? "").toMatch(/规划|MODEL|VALIDATION|DEPENDENCY|mock/);
  // 循环没有产生业务副作用（服务端零资源）。
  const stats = await (await fetch(`${draftBaseUrl}/api/__danger_stats`)).json();
  expect(stats.drafts).toBe(0);
});
