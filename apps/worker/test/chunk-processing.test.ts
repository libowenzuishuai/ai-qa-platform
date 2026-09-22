import { beforeAll, afterAll, it, expect } from "vitest";
import Fastify from "fastify";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createTestEnv, type TestEnv } from "../../api/test/helpers/db.js";
import { registerChunkRoutes } from "../../api/src/routes-chunks.js";
import { registerJobRoutes } from "../../api/src/routes-jobs.js";
import { sendApiError } from "../../api/src/errors.js";
import { processAgentJob } from "../src/agent-job-processor.js";
import { WorkerConfig } from "../src/config.js";

/**
 * R03 持久化块处理全链路（真实 PostgreSQL + HTTP + Python + worker）：
 * 确定性分块落库 → 覆盖对账（部分完成只可审阅）→ 租约 CAS 提取 →
 * 完成块不重复调用 → 租约过期显式恢复 → 完成门后合并。
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const app = Fastify();
let env: TestEnv, actor: any, python: ChildProcess, pythonUrl = "";
let redisUrl = "", redisStarted = false;
const redisName = "aiqa-chunk-" + randomUUID().slice(0, 8);
const token = randomUUID();
const queue = { add: async (_n: string, _d: any) => ({}) as any };
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
    const timer = setTimeout(() => reject(new Error("startup timeout " + log)), 15000);
    const on = (b: Buffer) => {
      log += b.toString();
      const m = pattern.exec(log);
      if (m) { clearTimeout(timer); resolve(m[1]!); }
    };
    child.stdout?.on("data", on);
    child.stderr?.on("data", on);
    child.once("exit", () => { clearTimeout(timer); reject(new Error("exited " + log)); });
  });
}

let projectId = "", documentVersionId = "";

beforeAll(async () => {
  env = await createTestEnv("chunk");
  execFileSync("docker", ["run", "--rm", "-d", "--name", redisName, "-p", "127.0.0.1::6379", "redis:7-alpine"]);
  redisStarted = true;
  redisUrl = "redis://127.0.0.1:" + execFileSync("docker", ["port", redisName, "6379/tcp"], { encoding: "utf8" }).trim().split(":").at(-1);
  actor = await env.prisma.user.create({
    data: { username: randomUUID(), displayName: "验收负责人", passwordHash: "test-only", platformRole: "LEAD" },
  });
  app.addHook("onRequest", async (req) => {
    req.auth = { userId: actor.id, username: actor.username, displayName: actor.displayName, platformRole: "LEAD" };
  });
  app.setErrorHandler((e, q, r) => sendApiError(q, r, e));
  registerChunkRoutes(app, env.prisma, queue);
  registerJobRoutes(app, env.prisma, queue);

  // 夹具 Python：分块走真实确定性管线；规则提取用固定 agent（按块 span 生成草稿）。
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const fixture = join(tmpdir(), `chunk-fixture-${randomUUID().slice(0, 8)}.py`);
  writeFileSync(fixture, `
import os, uvicorn
from aiqa_intelligence.app import create_app
from aiqa_intelligence.contracts.generated import RuleExtractionOutput
from aiqa_intelligence.errors import ServiceError

class FakeAgents:
    ready = True
    async def extract_rules(self, input, context):
        data = input.model_dump(mode="json", exclude_unset=True)
        bundle = data["documentVersions"][0]
        if not any("chunk" in w for w in bundle.get("warnings", [])):
            raise ServiceError("MODEL_OUTPUT_INVALID", "expected chunk bundle")
        drafts = []
        for i, span in enumerate(bundle["spans"]):
            drafts.append({
                "key": f"rule-draft-{i+1:02d}",
                "statement": span["quotedText"] or "未解析内容",
                "classification": "EXPLICIT" if span["extractionQuality"] == "GOOD" else "INFERRED",
                "action": "处理", "expectation": "符合预期",
                "sources": [{"documentVersionId": bundle["documentVersionId"], "sourceSpanIds": [span["id"]]}],
            })
        return RuleExtractionOutput.model_validate({"ruleDrafts": drafts, "clarifications": [], "unparsedRanges": []})
    async def generate_cases(self, input, context):
        raise ServiceError("MODEL_OUTPUT_INVALID", "not used")

application = create_app(token=os.environ["AIQA_INTELLIGENCE_TOKEN"], agents=FakeAgents())
uvicorn.run(application, host="127.0.0.1", port=0)
`);
  python = spawn(root + "services/intelligence/.venv/bin/python", [fixture], {
    cwd: root,
    env: {
      ...process.env,
      PYTHONPATH: root + "services/intelligence/src",
      AIQA_INTELLIGENCE_TOKEN: token,
      AIQA_ARTIFACT_DIR: env.artifactDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  pythonUrl = await ready(python, /Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/);

  // 场景：多章节长文档（≥3 块）。
  const project = await env.prisma.project.create({
    data: { name: "块处理项目", memberships: { create: { userId: actor.id, role: "LEAD" } } },
  });
  projectId = project.id;
  const document = await env.prisma.document.create({ data: { projectId, title: "长 PRD" } });
  documentVersionId = `dv-${randomUUID()}`;
  const sections = Array.from({ length: 6 }, (_, i) =>
    `# 第${i + 1}章 功能${i + 1}\n用户必须能在功能${i + 1}页面完成操作，响应时间不超过 ${i + 1} 秒。\n`,
  );
  const text = sections.join("");
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const blocks = lines.map((line, i) => ({
    id: `b-${documentVersionId}-${i}`,
    kind: line.startsWith("#") ? "heading" : "paragraph",
    text: line,
  }));
  const spans = lines.map((line, i) => ({
    id: `s-${documentVersionId}-${i}`,
    documentVersionId,
    locator: { kind: "markdown-line" as const, startLine: i + 1, endLine: i + 1 },
    quotedText: line,
    extractionQuality: "GOOD" as const,
  }));
  const bundle = {
    documentVersionId, format: "MARKDOWN", parseStatus: "PARSED", parserVersion: "test-chunk-1",
    blocks, spans, warnings: [],
    coverageSummary: { totalBlocks: blocks.length, goodSpans: spans.length, lowSpans: 0, unparsedSpans: 0 },
  };
  const { createHash } = await import("node:crypto");
  const saved = env.store.put({
    runId: "bundles", attemptId: documentVersionId, filename: "bundle.json",
    data: Buffer.from(JSON.stringify(bundle)),
  });
  await env.prisma.documentVersion.create({
    data: {
      id: documentVersionId, documentId: document.id, version: 1,
      checksum: createHash("sha256").update(Buffer.from(text)).digest("hex"),
      storageKey: saved.storageKey, format: "MARKDOWN", parseStatus: "PARSED",
      bundleStorageKey: saved.storageKey, bundleChecksum: saved.checksum, mode: "real",
    },
  });
  await env.prisma.sourceSpan.createMany({ data: spans as never });
}, 40000);

afterAll(async () => {
  python?.kill("SIGTERM");
  await app.close();
  if (redisStarted) execFileSync("docker", ["rm", "-f", redisName]);
  await env?.cleanup();
});

const H = {} as Record<string, string>;
const PARAMS = { maxCharsPerChunk: 500, contextOverlapChars: 50, modelBudgetChars: 40000 };

it("分块作业：真实 Python 确定性分块，清单与块行幂等落库", async () => {
  const res = await app.inject({
    method: "POST", url: `/api/projects/${projectId}/documents/${documentVersionId}/chunks`, headers: H,
    payload: { strategyParams: PARAMS, mode: "mock", idempotencyKey: "chunk-key-0001" },
  });
  expect(res.statusCode).toBe(202);
  await processAgentJob(env.prisma, config(), res.json().jobId);
  const job = await env.prisma.job.findUniqueOrThrow({ where: { id: res.json().jobId } });
  expect(job.status).toBe("SUCCEEDED");
  expect((job.result as { chunkCount: number }).chunkCount).toBeGreaterThanOrEqual(3);

  // 幂等：同参数重复提交返回原作业。
  const again = await app.inject({
    method: "POST", url: `/api/projects/${projectId}/documents/${documentVersionId}/chunks`, headers: H,
    payload: { strategyParams: PARAMS, mode: "mock", idempotencyKey: "chunk-key-0002" },
  });
  expect(again.json().existed).toBe(true);
  expect(await env.prisma.job.count({ where: { kind: "DOCUMENT_CHUNK" } })).toBe(1);
});

it("覆盖对账：部分完成只可审阅，合并被完成门拒绝", async () => {
  const status = await app.inject({ method: "GET", url: `/api/projects/${projectId}/documents/${documentVersionId}/chunks`, headers: H });
  expect(status.statusCode).toBe(200);
  const body = status.json();
  expect(body.coverage.complete).toBe(false);
  expect(body.coverage.pending.length).toBe(body.manifest.chunkCount);
  expect(body.coverage.note).toContain("仅可审阅");

  const merged = await app.inject({ method: "POST", url: `/api/projects/${projectId}/documents/${documentVersionId}/chunks/merge`, headers: H, payload: {} });
  expect(merged.statusCode).toBe(409);
  expect(merged.json().message).toContain("覆盖对账未通过");
});

it("块提取：租约 CAS、span 引用保持原 ID、完成块不重复调用", async () => {
  const status = (await app.inject({ method: "GET", url: `/api/projects/${projectId}/documents/${documentVersionId}/chunks`, headers: H })).json();
  const first = status.chunks[0] as { chunkId: string };
  const res = await app.inject({
    method: "POST", url: `/api/projects/${projectId}/documents/${documentVersionId}/chunks/${first.chunkId}/extract`, headers: H,
    payload: { mode: "mock", idempotencyKey: "extract-key-0001" },
  });
  expect(res.statusCode).toBe(202);
  await processAgentJob(env.prisma, config(), res.json().jobId);
  const row = await env.prisma.documentChunk.findFirstOrThrow({ where: { chunkId: first.chunkId } });
  expect(row.status).toBe("completed");
  expect(row.attempts).toBe(1);
  // 输出引用原始 span ID（联合校验通过即证明）。
  const output = row.output as { ruleDrafts: Array<{ sources: Array<{ sourceSpanIds: string[] }> }> };
  expect(output.ruleDrafts.length).toBeGreaterThan(0);
  expect(output.ruleDrafts[0]!.sources[0]!.sourceSpanIds[0]).toMatch(/^s-/);

  // 完成块不可再提取。
  const again = await app.inject({
    method: "POST", url: `/api/projects/${projectId}/documents/${documentVersionId}/chunks/${first.chunkId}/extract`, headers: H,
    payload: { mode: "mock", idempotencyKey: "extract-key-0002" },
  });
  expect(again.statusCode).toBe(409);
});

it("租约过期显式恢复：in_progress 过期块重新可提取", async () => {
  const status = (await app.inject({ method: "GET", url: `/api/projects/${projectId}/documents/${documentVersionId}/chunks`, headers: H })).json();
  const second = status.chunks[1] as { chunkId: string };
  // 模拟失联：租约已过期仍挂 in_progress。
  await env.prisma.documentChunk.updateMany({
    where: { chunkId: second.chunkId },
    data: { status: "in_progress", leaseExpiresAt: new Date(Date.now() - 1000) },
  });
  const res = await app.inject({
    method: "POST", url: `/api/projects/${projectId}/documents/${documentVersionId}/chunks/${second.chunkId}/extract`, headers: H,
    payload: { mode: "mock", idempotencyKey: "extract-key-0003" },
  });
  expect(res.statusCode).toBe(202);
  await processAgentJob(env.prisma, config(), res.json().jobId);
  const row = await env.prisma.documentChunk.findFirstOrThrow({ where: { chunkId: second.chunkId } });
  expect(row.status).toBe("completed");
});

it("全部完成后合并：确定性合并结果 + 作业信封可查询", async () => {
  const status = (await app.inject({ method: "GET", url: `/api/projects/${projectId}/documents/${documentVersionId}/chunks`, headers: H })).json();
  for (const chunk of status.chunks.slice(2) as Array<{ chunkId: string }>) {
    const res = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/documents/${documentVersionId}/chunks/${chunk.chunkId}/extract`, headers: H,
      payload: { mode: "mock", idempotencyKey: `extract-${chunk.chunkId}` },
    });
    await processAgentJob(env.prisma, config(), res.json().jobId);
  }
  const merged = await app.inject({ method: "POST", url: `/api/projects/${projectId}/documents/${documentVersionId}/chunks/merge`, headers: H, payload: {} });
  expect(merged.statusCode).toBe(200);
  const body = merged.json();
  expect(body.counts.ruleDrafts).toBeGreaterThan(0);
  // 每个原始 span 恰好贡献一条草稿（无丢失：drafts 数 = span 数）。
  expect(body.merged.ruleDrafts.length).toBe(12);
  expect(body.merged.ruleDrafts.every((d: { key: string }) => /^rule-draft-\d{2,}$/.test(d.key))).toBe(true);

  // 块作业信封可查询。
  const job = await env.prisma.job.findFirstOrThrow({ where: { kind: "DOCUMENT_CHUNK", status: "SUCCEEDED" } });
  const envelope = await app.inject({ method: "GET", url: `/api/jobs/${job.id}`, headers: H });
  expect(envelope.statusCode).toBe(200);
  expect(envelope.json().kind).toBe("DOCUMENT_CHUNK");
});

it('完整块结果进入正式 DRAFT 规则且重复点击不产生重复资产',async()=>{
 const url=`/api/projects/${projectId}/documents/${documentVersionId}/chunks/drafts`;
 const a=await app.inject({method:'POST',url,payload:{}}),b=await app.inject({method:'POST',url,payload:{}});
 expect(a.statusCode,a.body).toBe(202);expect(a.json().jobId).toBe(b.json().jobId);
 await processAgentJob(env.prisma,config(),a.json().jobId);
 const job=await env.prisma.job.findUniqueOrThrow({where:{id:a.json().jobId}});
 expect(job.status,JSON.stringify(job.error)).toBe('SUCCEEDED');
 const rules=await env.prisma.ruleVersion.findMany({where:{rule:{projectId}}});
 expect(rules).toHaveLength(12);expect(rules.every(r=>r.reviewStatus==='DRAFT'&&r.generationMode==='mock')).toBe(true);
 await processAgentJob(env.prisma,config(),a.json().jobId);
 expect(await env.prisma.ruleVersion.count({where:{rule:{projectId}}})).toBe(12);
});

it('块输出校验和损坏时合并拒绝',async()=>{
 const row=await env.prisma.documentChunk.findFirstOrThrow({where:{documentVersionId,status:'completed'}});
 await env.prisma.documentChunk.update({where:{id:row.id},data:{outputHash:'0'.repeat(64)}});
 const res=await app.inject({method:'POST',url:`/api/projects/${projectId}/documents/${documentVersionId}/chunks/merge`,payload:{}});
 expect(res.statusCode).toBe(409);
 await env.prisma.documentChunk.update({where:{id:row.id},data:{outputHash:row.outputHash}});
});
it('已取消作业不得提交块结果，另一执行持有块时不得假成功',async()=>{
 const row=await env.prisma.documentChunk.findFirstOrThrow({where:{documentVersionId},orderBy:{seq:'asc'}});
 await env.prisma.documentChunk.update({where:{id:row.id},data:{status:'pending',output:null,outputHash:null}});
 const created=await app.inject({method:'POST',url:`/api/projects/${projectId}/documents/${documentVersionId}/chunks/${row.chunkId}/extract`,payload:{mode:'mock',idempotencyKey:'race-owner-0001'}});
 const jobId=created.json().jobId;
 await env.prisma.documentChunk.update({where:{id:row.id},data:{status:'in_progress',leaseOwnerJobId:'other-job',leaseExpiresAt:new Date(Date.now()+60000)}});
 await processAgentJob(env.prisma,config(),jobId);
 expect((await env.prisma.job.findUniqueOrThrow({where:{id:jobId}})).status).toBe('FAILED');
 expect((await env.prisma.documentChunk.findUniqueOrThrow({where:{id:row.id}})).leaseOwnerJobId).toBe('other-job');
 const cancelled=await env.prisma.job.create({data:{projectId,kind:'CHUNK_EXTRACT',fingerprint:randomUUID(),request:{chunkRowId:row.id,mode:'mock'}}});
 expect((await app.inject({method:'POST',url:`/api/jobs/${cancelled.id}/cancel`})).statusCode).toBe(200);
 await processAgentJob(env.prisma,config(),cancelled.id);
 expect((await env.prisma.job.findUniqueOrThrow({where:{id:cancelled.id}})).status).toBe('CANCELLED');
});
