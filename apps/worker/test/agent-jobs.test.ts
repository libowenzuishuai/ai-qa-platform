import { execFileSync } from "node:child_process";
import { Queue, Worker } from "bullmq";
import type { PrismaClient } from "@prisma/client";
import { reconcileAgentJobs } from "../src/agent-job-recovery.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RuleExtractionInput,
  RuleExtractionOutput,
  CaseGenerationInput,
  CaseGenerationOutput,
  TestCaseVersion,
} from "@ai-qa/contracts";
import { inputHash, registerMockResponse } from "@ai-qa/model-adapters";
import { processAgentJob, buildCaseGenerationJobInput } from "../src/agent-job-processor.js";
import {
  buildRuleExtractionMessages,
  buildCaseGenerationMessages,
  REFERENCE_PROMPT_VERSION,
} from "../src/pipelines.js";
// 复用 apps/api 的隔离库基础设施（跨包测试相对导入，避免重复维护）。
import { createTestEnv, type TestEnv } from "../../api/test/helpers/db.js";

/**
 * 阶段 2 纵向链路（真实临时库 + mock 确定性适配器）：
 * 上传 bundle（DB+artifact-store）→ 规则提取作业 → DRAFT 规则 + 澄清项 +
 * ModelInvocation → 批准 → 用例生成作业 → DRAFT 用例 → 作业信封。
 * 无网络、无真实密钥；mock 响应用 fixture golden 注册。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT_FIXTURES = join(HERE, "../../../packages/contracts/fixtures");

const MOCK_TABLE = join(HERE, "../../../packages/model-adapters/mock-table/entries.json");
const originalMockTable = readFileSync(MOCK_TABLE);
let env: TestEnv;
let queue: Queue;
const redisName = `aiqa-stage2-review-${process.pid}`;
let redisStarted = false;
let connection: { host: string; port: number };


beforeAll(async () => {
  env = await createTestEnv("agentjobs");
  execFileSync("docker", ["run", "--rm", "-d", "--name", redisName, "-p", "127.0.0.1::6379", "redis:7-alpine"]);
  redisStarted = true;
  const port = Number(execFileSync("docker", ["port", redisName, "6379/tcp"], { encoding: "utf8" }).trim().split(":").at(-1));
  connection = { host: "127.0.0.1", port };
  queue = new Queue("agent-jobs-test", { connection });
  await queue.waitUntilReady();
});
afterAll(async () => {
  writeFileSync(MOCK_TABLE, originalMockTable);
  try { await queue?.close(); } finally {
    try { if (redisStarted) execFileSync("docker", ["rm", "-f", redisName]); }
    finally { await env?.cleanup(); }
  }
});

  /** golden 的 sources.documentVersionId 随 bundle 重定基（联合校验要求一致）。 */
  function rebaseGolden(golden: unknown, newDocumentVersionId: string): unknown {
    const clone = JSON.parse(JSON.stringify(golden)) as {
      ruleDrafts: Array<{ sources: Array<{ documentVersionId: string; sourceSpanIds: string[] }> }>;
      unparsedRanges: Array<{ spanId: string }>;
    };
    const spanMap = rebaseMaps.get(newDocumentVersionId);
    if (!spanMap) throw new Error(`rebaseMaps 缺少 ${newDocumentVersionId}`);
    for (const draft of clone.ruleDrafts) {
      for (const source of draft.sources) {
        source.documentVersionId = newDocumentVersionId;
        source.sourceSpanIds = source.sourceSpanIds.map((id) => spanMap.get(id) ?? id);
      }
    }
    for (const range of clone.unparsedRanges ?? []) {
      range.spanId = spanMap.get(range.spanId) ?? range.spanId;
    }
    return clone;
  }

function loadFixture(dir: string, file: string): unknown {
  return JSON.parse(readFileSync(join(CONTRACT_FIXTURES, dir, file), "utf8"));
}

async function seedDocumentVersion(
  fixtureDir: string,
  title: string,
  projectIdArg: string,
): Promise<{ documentVersionId: string; storedBundle: Record<string, unknown> }> {
  const bundleJson = loadFixture(fixtureDir, "parsed-bundle.json") as {
    documentVersionId: string;
    format: string;
    parseStatus: string;
    spans: Array<{
      id: string;
      locator: unknown;
      quotedText: string | null;
      extractionQuality: string;
    }>;
  };
  const documentVersionId = `docv-${Math.random().toString(36).slice(2, 10)}`;
  const suffix = `-${Math.random().toString(36).slice(2, 6)}`;
  const rebaseSpanId = (id: string) => `${id}${suffix}`;
  const document = await env.prisma.document.create({
    data: { projectId: projectIdArg, title },
  });
  await env.prisma.documentVersion.create({
    data: {
      id: documentVersionId,
      documentId: document.id,
      version: 1,
      checksum: "fixture",
      storageKey: `bundles/${documentVersionId}/bundle.json`,
      format: bundleJson.format,
      parseStatus: bundleJson.parseStatus,
      parserVersion: "fixture-1",
    },
  });
  for (const span of bundleJson.spans) {
    await env.prisma.sourceSpan.create({
      data: {
        id: rebaseSpanId(span.id),
        documentVersionId,
        locator: span.locator as never,
        quotedText: span.quotedText,
        extractionQuality: span.extractionQuality,
      },
    });
  }
  // bundle 写入 artifact-store（重写 documentVersionId 与 span id 保持引用一致）。
  const rebased = JSON.parse(JSON.stringify(bundleJson));
  const spanIdMap = new Map<string, string>();
  rebased.documentVersionId = documentVersionId;
  for (const span of rebased.spans) {
    spanIdMap.set(span.id, rebaseSpanId(span.id));
    span.id = rebaseSpanId(span.id);
    span.documentVersionId = documentVersionId;
  }
  env.store.put({
    runId: "bundles",
    attemptId: documentVersionId,
    filename: "bundle.json",
    data: Buffer.from(JSON.stringify(rebased)),
  });
  (rebaseMaps as Map<string, Map<string, string>>).set(documentVersionId, spanIdMap);
  return { documentVersionId, storedBundle: rebased };
}

/** 每次 seed 的 span id 重定基映射（golden 重写用）。 */
const rebaseMaps = new Map<string, Map<string, string>>();

// 测试项目（共享）。
let projectId: string;
let baselinelessAdminNote: string | undefined;

describe("阶段 2 纵向链路（mock 全链路）", () => {
  it("环境：创建测试项目", async () => {
    const project = await env.prisma.project.create({ data: { name: `agent-jobs-${Date.now()}` } });
    projectId = project.id;
    (env as { projectId?: string }).projectId = projectId;
    expect(projectId).toBeTruthy();
  });

  it("RULE_EXTRACTION：golden 注册 → 作业 SUCCEEDED → DRAFT 规则/澄清/调用记录", async () => {
    const { documentVersionId, storedBundle } = await seedDocumentVersion("01-explicit-prd", "采购审批 PRD", projectId);

    // 注册 mock 响应：与处理器读回的同一 bundle 构造 → hash 必然一致。
    const input = RuleExtractionInput.parse({
      projectGlossary: [],
      documentVersions: [storedBundle],
      images: [],
      promptVersion: REFERENCE_PROMPT_VERSION,
    });
    const { system, user } = buildRuleExtractionMessages(input);
    const golden = rebaseGolden(loadFixture("01-explicit-prd", "expected-rule-drafts.json"), documentVersionId);
    registerMockResponse(inputHash("RULE_EXTRACTION", system, user), golden);

    const job = await env.prisma.job.create({
      data: {
        projectId,
        kind: "RULE_EXTRACTION",
        request: { documentVersionIds: [documentVersionId], glossaryUpdates: [], mode: "mock" } as never,
        fingerprint: `fp-extract-${Date.now()}`,
      },
    });
    await processAgentJob(env.prisma, { ...emptyWorkerConfig, artifactDir: env.artifactDir }, job.id);

    const done = await env.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    if (done.status !== "SUCCEEDED") {
      throw new Error(`作业失败：${JSON.stringify(done.error).slice(0, 400)}`);
    }
    const result = done.result as { ruleVersionIds: string[]; clarificationIds: string[] };
    expect(result.ruleVersionIds).toHaveLength(3);

    // 规则草稿：DRAFT、origin=model、来源指向真实 span。
    const drafts = await env.prisma.ruleVersion.findMany({
      where: { id: { in: result.ruleVersionIds } },
    });
    expect(drafts.every((d) => d.reviewStatus === "DRAFT" && d.origin === "model")).toBe(true);
    const withSources = drafts.find((d) => d.classification === "EXPLICIT" && (d.sources as unknown[]).length > 0);
    expect(withSources).toBeTruthy();

    // ModelInvocation 已记录（mock 通道）。
    const invocation = await env.prisma.modelInvocation.findFirst({
      where: { projectId },
    });
    expect(invocation?.provider).toBe("mock");
    expect(invocation?.promptVersion).toBe(REFERENCE_PROMPT_VERSION);
    baselinelessAdminNote = result.ruleVersionIds[0];
  });

  it("RULE_EXTRACTION（冲突 fixture）：澄清项 kind=CONFLICT 落库", async () => {
    const { documentVersionId, storedBundle } = await seedDocumentVersion("02-conflict-prd", "差旅报销 PRD", projectId);
    const input = RuleExtractionInput.parse({
      projectGlossary: [],
      documentVersions: [storedBundle],
      images: [],
      promptVersion: REFERENCE_PROMPT_VERSION,
    });
    const { system, user } = buildRuleExtractionMessages(input);
    const golden = rebaseGolden(loadFixture("02-conflict-prd", "expected-rule-drafts.json"), documentVersionId);
    registerMockResponse(inputHash("RULE_EXTRACTION", system, user), golden);

    const job = await env.prisma.job.create({
      data: {
        projectId,
        kind: "RULE_EXTRACTION",
        request: { documentVersionIds: [documentVersionId], mode: "mock" } as never,
        fingerprint: `fp-conflict-${Date.now()}`,
      },
    });
    await processAgentJob(env.prisma, { ...emptyWorkerConfig, artifactDir: env.artifactDir }, job.id);
    const done = await env.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    if (done.status !== "SUCCEEDED") {
      throw new Error(`作业失败：${JSON.stringify(done.error).slice(0, 400)}`);
    }
    const result = done.result as { clarificationIds: string[] };
    expect(result.clarificationIds).toHaveLength(1);
    const clarification = await env.prisma.clarification.findUniqueOrThrow({
      where: { id: result.clarificationIds[0]! },
    });
    expect(clarification.kind).toBe("CONFLICT");
    expect(clarification.ruleVersionIds).toHaveLength(2);
    const conflicts = await env.prisma.ruleVersion.findMany({ where: { id: { in: clarification.ruleVersionIds } } });
    for (const conflict of conflicts) {
      expect(conflict.conflictsWith).toEqual(conflicts.filter((r) => r.id !== conflict.id).map((r) => r.id));
    }
  });

  it("RULE_EXTRACTION：编造引用的输出 → 作业 FAILED/MODEL_OUTPUT_INVALID", async () => {
    const { documentVersionId, storedBundle } = await seedDocumentVersion("01-explicit-prd", "编造引用测试", projectId);
    const input = RuleExtractionInput.parse({
      projectGlossary: [],
      documentVersions: [storedBundle],
      images: [],
      promptVersion: REFERENCE_PROMPT_VERSION,
    });
    const { system, user } = buildRuleExtractionMessages(input);
    // 篡改 golden：spanId 换成不存在的（documentVersionId 已重定基，
    // 保证失败原因是"span 不存在"而非"文档不一致"）。
    const poisoned = rebaseGolden(loadFixture("01-explicit-prd", "expected-rule-drafts.json"), documentVersionId) as {
      ruleDrafts: Array<{ sources: Array<{ sourceSpanIds: string[] }> }>;
    };
    poisoned.ruleDrafts[0]!.sources[0]!.sourceSpanIds = ["span-fabricated"];
    registerMockResponse(inputHash("RULE_EXTRACTION", system, user), poisoned);

    const job = await env.prisma.job.create({
      data: {
        projectId,
        kind: "RULE_EXTRACTION",
        request: { documentVersionIds: [documentVersionId], mode: "mock" } as never,
        fingerprint: `fp-poison-${Date.now()}`,
      },
    });
    await processAgentJob(env.prisma, { ...emptyWorkerConfig, artifactDir: env.artifactDir }, job.id);
    const done = await env.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(done.status).toBe("FAILED");
    const error = done.error as { code: string; details?: { problems?: string[] } };
    expect(error.code).toBe("MODEL_OUTPUT_INVALID");
    expect(error.details?.problems?.join()).toContain("span-fabricated");
  });

  it("CASE_GENERATION：批准后生成 → DRAFT 用例（联合校验通过）", async () => {
    // 独立项目（无澄清项 → hash 与处理器一致）。
    const caseProject = await env.prisma.project.create({ data: { name: `case-gen-${Date.now()}` } });
    const caseProjectId = caseProject.id;
    const { documentVersionId, storedBundle } = await seedDocumentVersion("01-explicit-prd", "用例生成 PRD", caseProjectId);

    // 1. 先跑一次提取（同项目内）。
    const extractInput = RuleExtractionInput.parse({
      projectGlossary: [], documentVersions: [storedBundle], images: [], promptVersion: REFERENCE_PROMPT_VERSION,
    });
    const { system: eSys, user: eUser } = buildRuleExtractionMessages(extractInput);
    const eGolden = rebaseGolden(loadFixture("01-explicit-prd", "expected-rule-drafts.json"), documentVersionId);
    registerMockResponse(inputHash("RULE_EXTRACTION", eSys, eUser), eGolden);
    const extractJob = await env.prisma.job.create({
      data: {
        projectId: caseProjectId, kind: "RULE_EXTRACTION",
        request: { documentVersionIds: [documentVersionId], mode: "mock" } as never,
        fingerprint: `fp-extract-case-${Date.now()}`,
      },
    });
    await processAgentJob(env.prisma, { ...emptyWorkerConfig, artifactDir: env.artifactDir }, extractJob.id);
    const extractDone = await env.prisma.job.findUniqueOrThrow({ where: { id: extractJob.id } });
    if (extractDone.status !== "SUCCEEDED") {
      throw new Error(`提取失败：${JSON.stringify(extractDone.error).slice(0, 300)}`);
    }

    // 2. 批准全部规则。
    const drafts = await env.prisma.ruleVersion.findMany({
      where: { reviewStatus: "DRAFT", rule: { projectId: caseProjectId } },
    });
    expect(drafts.length).toBeGreaterThanOrEqual(3);
    const approvedIds: string[] = [];
    for (const rule of drafts) {
      await env.prisma.ruleVersion.updateMany({
        where: { id: rule.id, reviewStatus: "DRAFT" },
        data: { reviewStatus: "APPROVED", reviewedBy: "test", reviewedAt: new Date() },
      });
      approvedIds.push(rule.id);
    }

    // 3. 用例生成：与处理器同构构造 input。
    const caseInput = await buildCaseGenerationJobInput(env.prisma, caseProjectId, approvedIds);
    const { system, user } = buildCaseGenerationMessages(caseInput);
    const golden = CaseGenerationOutput.parse({
      caseDrafts: [
        {
          title: "审批边界用例",
          ruleVersionIds: [approvedIds[0]!],
          roles: caseInput.roles,
          dataSpec: { strategy: "create", note: "页面创建" },
          steps: caseInput.roles.map((role) => ({ role, action: `以 ${role} 身份执行流程` })),
          assertions: [
            {
              id: "a1", description: "状态符合预期", kind: "ui.text", required: true,
              ruleVersionId: approvedIds[0]!, operator: "equals", expected: "待审批",
            },
          ],
          cleanup: { strategy: "namespace" }, dimensions: ["BOUNDARY"],
        },
      ],
      coverageMap: caseInput.approvedRuleVersions.map((r) => ({
        ruleVersionId: r.id, caseCount: r.id === approvedIds[0] ? 1 : 0, dimensionsCovered: r.id === approvedIds[0] ? ["BOUNDARY"] : [],
      })),
      blockedRequirements: caseInput.approvedRuleVersions.filter(r => r.id !== approvedIds[0]).map(r => ({
        ruleVersionId: r.id, reason: "INSUFFICIENT_INFO", detail: "该测试仅注册第一条规则的用例，其余保留缺口",
      })),
    });
    registerMockResponse(inputHash("CASE_GENERATION", system, user), golden);

    const job = await env.prisma.job.create({
      data: {
        projectId: caseProjectId, kind: "CASE_GENERATION",
        request: { ruleVersionIds: approvedIds, mode: "mock" } as never,
        fingerprint: `fp-cases-${Date.now()}`,
      },
    });
    await processAgentJob(env.prisma, { ...emptyWorkerConfig, artifactDir: env.artifactDir }, job.id);
    const done = await env.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    if (done.status !== "SUCCEEDED") {
      throw new Error(`作业失败：${JSON.stringify(done.error).slice(0, 400)}`);
    }
    const result = done.result as { caseVersionIds: string[] };
    expect(result.caseVersionIds).toHaveLength(1);
    const caseVersion = await env.prisma.testCaseVersion.findUniqueOrThrow({
      where: { id: result.caseVersionIds[0]! },
    });
    expect(caseVersion.approvalStatus).toBe("DRAFT");
    expect(caseVersion.origin).toBe("model");
    expect(caseVersion.projectId).toBe(caseProjectId);
    const normalized = TestCaseVersion.parse({ ...caseVersion, description: caseVersion.description ?? undefined,
      approvalHash: caseVersion.approvalHash ?? undefined, createdAt: caseVersion.createdAt.toISOString() });
    expect(new Set(normalized.steps.map((s) => s.id)).size).toBe(normalized.steps.length);
  });

  it("重复投递：已终态作业不重复执行（CAS 认领）", async () => {
    const jobs = await env.prisma.job.findMany({ where: { projectId, status: "SUCCEEDED" } });
    const target = jobs[0]!;
    const ruleCountBefore = await env.prisma.ruleVersion.count({ where: { rule: { projectId } } });
    await processAgentJob(env.prisma, { ...emptyWorkerConfig, artifactDir: env.artifactDir }, target.id);
    const ruleCountAfter = await env.prisma.ruleVersion.count({ where: { rule: { projectId } } });
    expect(ruleCountAfter).toBe(ruleCountBefore);
  });
});

const emptyWorkerConfig = {
  port: 0,
  host: "127.0.0.1",
  databaseUrl: "unused-in-processor",
  redisUrl: "redis://unused",
  artifactDir: "",
  demoFixtureToken: "unused",
  logLevel: "warn",
};

async function extractionJob() {
  const project = await env.prisma.project.create({ data: { name: "recovery-test" } });
  const { documentVersionId, storedBundle } = await seedDocumentVersion("01-explicit-prd", "recovery", project.id);
  const input = RuleExtractionInput.parse({projectGlossary: [], documentVersions: [storedBundle], images: [], promptVersion: REFERENCE_PROMPT_VERSION});
  const {system,user} = buildRuleExtractionMessages(input);
  registerMockResponse(inputHash("RULE_EXTRACTION",system,user), rebaseGolden(loadFixture("01-explicit-prd","expected-rule-drafts.json"),documentVersionId));
  return env.prisma.job.create({data:{projectId:project.id,kind:"RULE_EXTRACTION",request:{documentVersionIds:[documentVersionId],mode:"mock"},fingerprint:documentVersionId}});
}
const cfg = () => ({...emptyWorkerConfig,artifactDir:env.artifactDir});
function latch() { let release!:()=>void; const promise=new Promise<void>(r=>release=r); return {promise,release}; }

it("真实队列：漏投的 QUEUED 作业经对账补投，重复投递仅一套资产", async()=>{
 const job=await extractionJob();
 await env.prisma.job.update({where:{id:job.id},data:{updatedAt:new Date(Date.now()-20000)}});
 await reconcileAgentJobs(env.prisma,queue);
 await queue.add("run",{jobId:job.id});
 const finished=latch();let count=0;
 const worker=new Worker(queue.name,async task=>{await processAgentJob(env.prisma,cfg(),String(task.data.jobId));},{connection,concurrency:2});
 worker.on("completed",()=>{if(++count===2)finished.release();});
 try {
  await Promise.race([finished.promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error("queue timeout")),5000).unref())]);
  expect((await env.prisma.job.findUniqueOrThrow({where:{id:job.id}})).status).toBe("SUCCEEDED");
  expect(await env.prisma.rule.count({where:{projectId:job.projectId}})).toBe(3);
 } finally {await worker.close();}
});

it("失联作业明确 FAILED，活跃心跳不误判；旧执行不能覆盖重试",async()=>{
 const job=await extractionJob();const entered=latch(),resume=latch();
 const client=env.prisma.$extends({query:{modelInvocation:{async create({args,query}){
   entered.release();await resume.promise;return query(args);
 }}}}) as unknown as PrismaClient;
 const pending=processAgentJob(client,cfg(),job.id);
 await entered.promise;
 try {
  await reconcileAgentJobs(env.prisma,queue);
  expect((await env.prisma.job.findUniqueOrThrow({where:{id:job.id}})).status).toBe("RUNNING");
  await env.prisma.job.update({where:{id:job.id},data:{updatedAt:new Date(Date.now()-100000)}});
  await reconcileAgentJobs(env.prisma,queue);
  expect((await env.prisma.job.findUniqueOrThrow({where:{id:job.id}})).status).toBe("FAILED");
  // 显式重试的新执行拥有不同 startedAt；旧执行稍后回来必须被拒绝。
  await env.prisma.job.update({where:{id:job.id},data:{status:"QUEUED",startedAt:null,finishedAt:null}});
  await processAgentJob(env.prisma,cfg(),job.id);
 } finally {resume.release();await pending;}
 expect((await env.prisma.job.findUniqueOrThrow({where:{id:job.id}})).status).toBe("SUCCEEDED");
 expect(await env.prisma.rule.count({where:{projectId:job.projectId}})).toBe(3);
});

it("中途写入失败回滚所有资产，重试不会留下半套规则",async()=>{
 const job=await extractionJob();let creates=0;
 const client=env.prisma.$extends({query:{ruleVersion:{async create({args,query}){
   if(++creates===2)throw new Error("injected second insert failure");return query(args);
 }}}}) as unknown as PrismaClient;
 await processAgentJob(client,cfg(),job.id);
 expect((await env.prisma.job.findUniqueOrThrow({where:{id:job.id}})).status).toBe("FAILED");
 expect(await env.prisma.rule.count({where:{projectId:job.projectId}})).toBe(0);
 expect(await env.prisma.ruleVersion.count({where:{rule:{projectId:job.projectId}}})).toBe(0);
 await env.prisma.job.update({where:{id:job.id},data:{status:"QUEUED",startedAt:null,finishedAt:null}});
 await processAgentJob(env.prisma,cfg(),job.id);
 expect((await env.prisma.job.findUniqueOrThrow({where:{id:job.id}})).status).toBe("SUCCEEDED");
 expect(await env.prisma.rule.count({where:{projectId:job.projectId}})).toBe(3);
});

it("运行超过一个心跳周期时续租，保持同一执行所有权", async()=>{
 const job=await extractionJob();const entered=latch(),resume=latch();
 const client=env.prisma.$extends({query:{modelInvocation:{async create({args,query}){
   entered.release();await resume.promise;return query(args);
 }}}}) as unknown as PrismaClient;
 const pending=processAgentJob(client,cfg(),job.id);
 await entered.promise;
 const before=await env.prisma.job.findUniqueOrThrow({where:{id:job.id}});
 try {
   const deadline=Date.now()+13000;
   let updated=before;
   while(updated.updatedAt.getTime()===before.updatedAt.getTime() && Date.now()<deadline){
     await new Promise(r=>setTimeout(r,200));
     updated=await env.prisma.job.findUniqueOrThrow({where:{id:job.id}});
   }
   expect(updated.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
   expect(updated.startedAt).toEqual(before.startedAt);
   expect(updated.status).toBe("RUNNING");
 } finally {resume.release();await pending;}
 expect((await env.prisma.job.findUniqueOrThrow({where:{id:job.id}})).status).toBe("SUCCEEDED");
},20000);

it("Python 输出经平台联合校验后落库，调用记录保留实际提示词版本", async()=>{
 const job=await extractionJob();
 const docId=(job.request as {documentVersionIds:string[]}).documentVersionIds[0]!;
 const output=rebaseGolden(loadFixture("01-explicit-prd","expected-rule-drafts.json"),docId);
 const fetch=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(JSON.stringify({
  schemaVersion:"1.0",requestId:job.id,mode:"mock",output,invocations:[{purpose:"RULE_EXTRACTION",promptVersion:"agents-v2",response:{
   parsedJson:output,rawText:JSON.stringify(output),repairsApplied:[],provider:"mock",model:"mock",requestId:"py-model-1",
   usage:{inputTokens:1,outputTokens:2},latencyMs:1,outcome:"SUCCESS",
  }}],
 }),{status:200}));
 try {await processAgentJob(env.prisma,{...cfg(),intelligenceBackend:"python",intelligenceUrl:"http://python.invalid",intelligenceToken:"fake-test"},job.id);}
 finally {fetch.mockRestore();}
 const done=await env.prisma.job.findUniqueOrThrow({where:{id:job.id}});
 expect(done.status).toBe("SUCCEEDED");
 expect(await env.prisma.ruleVersion.count({where:{rule:{projectId:job.projectId},promptVersion:"agents-v2"}})).toBe(3);
 expect(await env.prisma.modelInvocation.count({where:{projectId:job.projectId,promptVersion:"agents-v2",requestId:"py-model-1"}})).toBe(1);
});
it("Python 传回伪造来源也被平台阻断，不能写入草稿", async()=>{
 const job=await extractionJob();
 const docId=(job.request as {documentVersionIds:string[]}).documentVersionIds[0]!;
 const output=rebaseGolden(loadFixture("01-explicit-prd","expected-rule-drafts.json"),docId) as any;
 output.ruleDrafts[0].sources[0].sourceSpanIds=["fabricated-python-span"];
 const fetch=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(JSON.stringify({
  schemaVersion:"1.0",requestId:job.id,mode:"mock",output,invocations:[],
 }),{status:200}));
 try {await processAgentJob(env.prisma,{...cfg(),intelligenceBackend:"python",intelligenceUrl:"http://python.invalid",intelligenceToken:"fake-test"},job.id);}
 finally {fetch.mockRestore();}
 const done=await env.prisma.job.findUniqueOrThrow({where:{id:job.id}});
 expect(done.status).toBe("FAILED");expect((done.error as any).code).toBe("MODEL_OUTPUT_INVALID");
 expect(await env.prisma.rule.count({where:{projectId:job.projectId}})).toBe(0);
});
