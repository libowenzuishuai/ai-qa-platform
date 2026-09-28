import { beforeAll, afterAll, it, expect } from "vitest";
import Fastify from "fastify";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import { createTestEnv, type TestEnv } from "../../api/test/helpers/db.js";
import { registerV2CapabilityRoutes } from "../../api/src/routes-v2-capabilities.js";
import { registerV2SessionRoutes } from "../../api/src/routes-v2-sessions.js";
import { registerAuth } from "../../api/src/auth.js";
import { sendApiError } from "../../api/src/errors.js";
import { processAgentJob } from "../src/agent-job-processor.js";
import { WorkerConfig } from "../src/config.js";
import { registerBuiltinSamples } from "../src/v2/samples.js";
import { DraftOpsManifest } from "@ai-qa/adapter-sdk/samples/draft-ops";
import { computeOracleHash } from "@ai-qa/contracts";

/**
 * R3 最小旅程（API 层，真实 DB + 真实合成系统 + worker 作业）：
 * 创建会话（固定 Oracle/环境白名单校验）→ V2_SESSION_LOOP 作业驱动循环 →
 * 会话终态 + 详情含全阶段留痕 → 取消终态拒绝 → 幂等创建。
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
let env: TestEnv, app: ReturnType<typeof Fastify>;
let projectId = "", environmentId = "", oracleSpecId = "";
let draftPort = 0, draftBaseUrl = "";
let draftServer: ReturnType<typeof spawn>;
const H = {} as Record<string, string>;
let jobCounter = 0;
const queuedJobs: string[] = [];
const queue = { add: async (_n: string, d: { jobId: string }) => { queuedJobs.push(d.jobId); return {} as never; } };

function config() {
  return WorkerConfig.parse({
    databaseUrl: env.databaseUrl,
    redisUrl: "redis://127.0.0.1:6380/0",
    artifactDir: env.artifactDir,
    intelligenceBackend: "python",
    intelligenceUrl: "http://127.0.0.1:1",
    intelligenceToken: "unused",
    intelligenceTimeoutMs: 5000,
  });
}

beforeAll(async () => {
  env = await createTestEnv("v2api");
  const user = await env.prisma.user.create({
    data: { username: randomUUID(), displayName: "lead", passwordHash: "x", platformRole: "LEAD" },
  });
  const project = await env.prisma.project.create({
    data: { name: "会话项目", memberships: { create: { userId: user.id, role: "ADMIN" } } },
  });
  projectId = project.id;

  // 合成草稿系统。
  draftPort = 20000 + Math.floor(Math.random() * 20000);
  draftBaseUrl = `http://127.0.0.1:${draftPort}`;
  draftServer = spawn("node", [join(root, "examples/synthetic/draft-app/server.mjs"), "--port", String(draftPort)], {
    env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("draft server timeout")), 8000);
    const on = (b: Buffer) => { if (b.toString().includes("ready")) { clearTimeout(timer); resolve(); } };
    draftServer.stdout?.on("data", on);
    draftServer.stderr?.on("data", on);
  });

  const environment = await env.prisma.environment.create({
    data: { projectId, name: "synthetic", baseUrl: draftBaseUrl, allowedOrigins: [draftBaseUrl] },
  });
  environmentId = environment.id;

  // Oracle（六维声明 + 结构化映射）。
  const dims = ["normal", "boundary", "permission", "multi_role", "state", "persistence"] as const;
  const ruleVersionId = `rv-api-${randomUUID().slice(0, 8)}`;
  const assertions = [{
    id: "a-title", ruleVersionId, kind: "deterministic",
    fact: "草稿标题", observationType: "api_field", observationRef: "draft.title",
    operator: "equals", expected: "验收目标名称", precondition: null, unit: null, tolerance: null,
    allowedRoles: [], required: true,
  }];
  const coverageDeclarations = dims.map((dimension) => ({ ruleVersionId, dimension, status: "planned", reason: "api 测试" }));
  const oracleHash = computeOracleHash({ projectId, ruleVersionIds: [ruleVersionId], assertions: assertions as never, semanticCandidates: [], coverageDeclarations });
  const oracle = await env.prisma.v2OracleSpec.create({
    data: {
      projectId, version: 1, status: "APPROVED", ruleVersionIds: [ruleVersionId],
      assertions: assertions as never, semanticCandidates: [], coverageDeclarations,
      oracleHash, createdBy: "t", approvedBy: "t", approvedAt: new Date(),
    },
  });
  oracleSpecId = oracle.id;

  app = Fastify();
  await app.register(cookie);
  registerAuth(app, env.prisma, 600);
  app.addHook("onRequest", async (req) => {
    req.auth = { userId: user.id, username: user.username, displayName: user.displayName, platformRole: "LEAD" };
  });
  app.setErrorHandler((e, q, r) => sendApiError(q, r, e));
  registerV2CapabilityRoutes(app, env.prisma);
  registerV2SessionRoutes(app, env.prisma, queue,{artifactDir:env.artifactDir});
  registerBuiltinSamples();

  // 安装+授权合成能力。
  const install = await app.inject({
    method: "POST", url: `/api/v2/projects/${projectId}/capabilities/install`, headers: H,
    payload: { manifest: JSON.parse(JSON.stringify(DraftOpsManifest)) },
  });
  await app.inject({
    method: "POST", url: `/api/v2/installations/${install.json().installationId}/authorize`, headers: H,
    payload: { scope: ["draft:ops"] },
  });
}, 40000);

afterAll(async () => {
  draftServer?.kill("SIGTERM");
  await app?.close();
  await env?.cleanup();
});

async function processQueued() {
  while (queuedJobs.length) {
    jobCounter += 1;
    const jobId = queuedJobs.shift()!;
    await processAgentJob(env.prisma, config(), jobId);
  }
}

it("创建会话：白名单外目标拒绝；合法创建入队，作业驱动循环到 COMPLETED，详情全留痕", async () => {
  const bad = await app.inject({
    method: "POST", url: `/api/v2/projects/${projectId}/sessions`, headers: H,
    payload: { goal: "闭环", oracleSpecId, environmentId, targetBaseUrl: "http://10.255.255.1:9", idempotencyKey: "idem-bad-0001" },
  });
  expect(bad.statusCode).toBe(422);
  expect(bad.json().message).toContain("白名单");

  const created = await app.inject({
    method: "POST", url: `/api/v2/projects/${projectId}/sessions`, headers: H,
    payload: { goal: "创建草稿→改名→刷新仍保留名称", oracleSpecId, environmentId, targetBaseUrl: draftBaseUrl, idempotencyKey: "idem-ok-0001" },
  });
  expect(created.statusCode).toBe(202);
  const { sessionId, jobId } = created.json();
  expect(queuedJobs).toContain(jobId);

  await processQueued();
  const job = await env.prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  expect(job.status).toBe("SUCCEEDED");
  const result = job.result as { status: string; verdict: string };
  expect(result.status).toBe("COMPLETED");
  expect(result.verdict).toBe("pass");

  const session = await env.prisma.v2ExecutionSession.findUniqueOrThrow({ where: { id: sessionId } });
  expect(session.status).toBe("COMPLETED");

  const detail = await app.inject({ method: "GET", url: `/api/v2/sessions/${sessionId}`, headers: H });
  expect(detail.statusCode).toBe(200);
  const body = detail.json();
  expect(body.attempts.length).toBeGreaterThanOrEqual(3);
  expect(body.intents.length).toBeGreaterThanOrEqual(2);
  expect(body.invocations.length).toBeGreaterThanOrEqual(2);
  expect(body.observations.length).toBeGreaterThanOrEqual(2);
  const verify = body.attempts.find((a: { phase: string }) => a.phase === "verify");
  expect(verify?.rationale).toContain("验收目标名称");

  // 资源恰好 1 个（真实合成系统计数）。
  const stats = await (await fetch(`${draftBaseUrl}/api/__danger_stats`)).json();
  expect(stats.drafts).toBe(1);
});

it("幂等创建：同参返回原会话；终态取消拒绝", async () => {
  const again = await app.inject({
    method: "POST", url: `/api/v2/projects/${projectId}/sessions`, headers: H,
    payload: { goal: "创建草稿→改名→刷新仍保留名称", oracleSpecId, environmentId, targetBaseUrl: draftBaseUrl, idempotencyKey: "idem-ok-0001" },
  });
  // 同一幂等键与完整请求一致才返回已有会话。
  expect(again.json().existed).toBe(true);

  const sessions = await app.inject({ method: "GET", url: `/api/v2/projects/${projectId}/sessions`, headers: H });
  const list = sessions.json().sessions as Array<{ id: string; status: string }>;
  const completed = list.find((s) => s.status === "COMPLETED")!;
  const cancel = await app.inject({ method: "POST", url: `/api/v2/sessions/${completed.id}/cancel`, headers: H, payload: {} });
  expect(cancel.statusCode).toBe(409);
});

it("幂等键区分新验收；相同键参数变化返回 409，不能串旧任务", async () => {
  const request = { goal:"幂等矩阵",oracleSpecId,environmentId,targetBaseUrl:draftBaseUrl,idempotencyKey:"idem-matrix-0001" };
  const post = (payload:unknown) => app.inject({method:"POST",url:`/api/v2/projects/${projectId}/sessions`,headers:H,payload:payload as never});
  const first = await post(request);
  expect(first.statusCode).toBe(202);
  const duplicate = await post(request);
  expect(duplicate.json().sessionId).toBe(first.json().sessionId);
  expect((await post({...request,buildId:"other-build"})).statusCode).toBe(409);
  const next = await post({...request,idempotencyKey:"idem-matrix-0002"});
  expect(next.statusCode).toBe(202);
  expect(next.json().sessionId).not.toBe(first.json().sessionId);
});

it("暂停/继续保留身份，持久事件按 cursor 续传，终态不能复活", async () => {
  const created = await app.inject({method:"POST",url:`/api/v2/projects/${projectId}/sessions`,headers:H,payload:{goal:"控制台",oracleSpecId,environmentId,targetBaseUrl:draftBaseUrl,idempotencyKey:"idem-controls-001"}});
  const id=created.json().sessionId;
  const control=(action:string)=>app.inject({method:"POST",url:`/api/v2/sessions/${id}/${action}`,headers:H,payload:{}});
  expect((await control("pause")).json().status).toBe("PAUSED");
  expect((await control("resume")).json().status).toBe("QUEUED");
  expect((await control("cancel")).json().status).toBe("CANCELLED");
  expect((await control("resume")).statusCode).toBe(409);
  const all=await app.inject({method:"GET",url:`/api/v2/sessions/${id}/events?format=json`,headers:H});
  const events=all.json().events;
  expect(events.map((e:any)=>e.payload.status)).toEqual(["QUEUED","PAUSED","QUEUED","CANCELLED"]);
  const tail=await app.inject({method:"GET",url:`/api/v2/sessions/${id}/events?format=json&after=${events[1].seq}`,headers:H});
  expect(tail.json().events.map((e:any)=>e.seq)).toEqual(events.slice(2).map((e:any)=>e.seq));
});

it("SSE 真实 HTTP 断开重连按 Last-Event-ID 继续，不重复旧事件",async()=>{
 const created=await app.inject({method:'POST',url:`/api/v2/projects/${projectId}/sessions`,headers:H,payload:{goal:'SSE reconnect',oracleSpecId,environmentId,targetBaseUrl:draftBaseUrl,idempotencyKey:'sse-reconnect-001'}});
 const id=created.json().sessionId;
 const base=await app.listen({host:'127.0.0.1',port:0});
 async function next(after?:number){
  const abort=new AbortController();
  const response=await fetch(`${base}/api/v2/sessions/${id}/events`,{signal:abort.signal,headers:after?{'Last-Event-ID':String(after)}:{}});
  expect(response.status).toBe(200);
  const reader=response.body!.getReader();let text='';const timer=setTimeout(()=>abort.abort(),5000);
  try{while(!/id: (\d+)/.test(text)){const part=await reader.read();if(part.done)break;text+=new TextDecoder().decode(part.value);}return {seq:Number(/id: (\d+)/.exec(text)?.[1]),text};}
  finally{clearTimeout(timer);abort.abort();await reader.cancel().catch(()=>undefined);}
 }
 const first=await next();expect(first.text).toContain('QUEUED');
 await app.inject({method:'POST',url:`/api/v2/sessions/${id}/cancel`,headers:H,payload:{}});
 const second=await next(first.seq);expect(second.seq).toBeGreaterThan(first.seq);expect(second.text).toContain('CANCELLED');expect(second.text).not.toContain('QUEUED');
});

it("结果证据丢失后报告降为 review，历史执行结果保持不变",async()=>{
 const session=await env.prisma.v2ExecutionSession.findFirstOrThrow({where:{projectId,status:'COMPLETED'}});
 const get=()=>app.inject({method:'GET',url:`/api/v2/sessions/${session.id}`,headers:H});
 expect((await get()).json().reportVerdict).toBe('pass');
 const observation=await env.prisma.v2Observation.findFirstOrThrow({where:{sessionId:session.id}});
 const artifact=await env.prisma.artifact.findUniqueOrThrow({where:{id:observation.evidenceArtifactIds[0]}});
 env.store.remove(artifact.storageKey);
 const detail=(await get()).json();expect(detail.reportVerdict).toBe('review');expect(detail.evidenceComplete).toBe(false);expect(detail.missingEvidenceIds).toContain(artifact.id);expect(detail.session.result.verdict).toBe('pass');
});
