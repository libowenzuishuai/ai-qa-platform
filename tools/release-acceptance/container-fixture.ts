/** Synthetic release fixture. Executed only in a disposable production-image container. */
import {PrismaClient} from '@prisma/client';
import {ArtifactStore} from '@ai-qa/artifact-store';
import {TestCaseVersion,computePlanAcceptanceHash} from '@ai-qa/contracts';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {writeFileSync} from 'node:fs';
import {createRun} from './dist/api/src/runs-service.js';
import {processRun} from './dist/worker/src/run-processor.js';
import {buildRunReport} from '@ai-qa/reporting';
const prisma=new PrismaClient(),store=new ArtifactStore('/data/artifacts');
const target=createServer((_q,r)=>{if(_q.url==='/build'){r.setHeader('content-type','application/json');r.end(JSON.stringify({buildId:'release-fixture-v1'}));return;}r.setHeader('content-type','text/html; charset=utf-8');r.end('<!doctype html><h1>Release fixture</h1><p data-testid="order-status">付款待办</p>');});
await new Promise<void>(resolve=>target.listen(7999,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true}),page=await browser.newPage();await page.goto('http://127.0.0.1:7999/orders');
try{
 const assets=await seedMinimalAssets(prisma,store);
 const admin=await prisma.user.findUniqueOrThrow({where:{username:process.env.SEED_ADMIN_USERNAME!}});
 await prisma.projectMembership.create({data:{projectId:assets.projectId,userId:admin.id,role:'ADMIN'}});
 const created=await createRun(prisma,store,{...assets,caseVersionIds:[assets.caseVersionId],mode:'real',idempotencyKey:'release-fixture',buildId:'release-fixture-v1'});
 await processRun(prisma,{databaseUrl:process.env.DATABASE_URL!,redisUrl:process.env.REDIS_URL!,artifactDir:'/data/artifacts',demoFixtureToken:'unused',logLevel:'warn',port:7200,host:'127.0.0.1'},created.runId);
 const report=await buildRunReport(prisma,store,created.runId);
 if(report.run.acceptanceStatus!=='PASS')throw new Error('Synthetic production browser did not pass: '+JSON.stringify(report));
 const record={runId:created.runId,projectId:assets.projectId,acceptanceStatus:report.run.acceptanceStatus};
 writeFileSync('/data/artifacts/release-record.json',JSON.stringify(record));console.log(JSON.stringify(record));
}finally{await browser.close();await prisma.$disconnect();target.close();}
export async function seedMinimalAssets(
  prisma: PrismaClient,
  store: ArtifactStore,
  overrides: {
    ruleStatus?: string;
    fakeEvidence?: boolean;
    crossProjectEvidence?: boolean;
  } = {},
): Promise<{
  projectId: string;
  baselineId: string;
  environmentId: string;
  caseVersionId: string;
  planVersionId: string;
  evidenceArtifactId: string;
}> {
  const projectId = (
    await prisma.project.create({ data: { name: `边界测试-${Date.now()}` } })
  ).id;
  const environmentId = (
    await prisma.environment.create({
      data: {
        projectId,
        name: "测试环境",
        baseUrl: "http://127.0.0.1:7999",
        allowedOrigins: ["http://127.0.0.1:7999"],
        runtime:{buildProbe:{path:"/build",field:"buildId"}},
      },
    })
  ).id;

  // 规则（可注入状态）。
  const ruleId = (await prisma.rule.create({ data: { projectId } })).id;
  const ruleVersionId = (
    await prisma.ruleVersion.create({
      data: {
        ruleId,
        version: 1,
        statement: "规则",
        classification: "INFERRED",
        action: "动作",
        expectation: "预期",
        sources: [],
        reviewStatus: overrides.ruleStatus ?? "APPROVED",
        origin: "manual",
      },
    })
  ).id;

  // 用例（APPROVED + 真实 acceptanceHash）。
  const caseId = (await prisma.testCase.create({ data: { projectId } })).id;
  const assertions = [
    { id: "a1", description: "状态", kind: "ui.text" as const, required: true, ruleVersionId, operator: "equals" as const, expected: "付款待办" },
  ];

  // 观察证据（真实文件）。
  let evidenceProjectId = projectId;
  let evidenceArtifactId: string;
  if (overrides.fakeEvidence) {
    evidenceArtifactId = "nonexistent-evidence-000";
  } else {
    if (overrides.crossProjectEvidence) {
      evidenceProjectId = (await prisma.project.create({ data: { name: "他项目" } })).id;
    }
    const stored = store.put({
      runId: "seed-test",
      attemptId: "observation",
      filename: `obs-${Date.now()}.png`,
      data: await page.screenshot(),
    });
    evidenceArtifactId = (
      await prisma.artifact.create({
        data: {
          projectId: evidenceProjectId,
          attemptId: null,
          storageKey: stored.storageKey,
          type: "OBSERVATION",
          sensitivity: "NORMAL",
          checksum: stored.checksum,
        },
      })
    ).id;
  }

  // 计划 v1（绑定证据；哈希在证据 id 确定后计算）。
  const planDraftBase = {
    schemaVersion: "1.0",
    caseVersionId: "placeholder-overridden-below",
    ruleVersionIds: [ruleVersionId],
    roles: ["applicant"],
    bindings: [
      { targetRef: "order-status", locator: { type: "testId", value: "order-status" }, observedUrl: "http://127.0.0.1:7999/orders", observedAt: "2026-09-17T00:00:00Z", evidenceId: evidenceArtifactId },
    ],
    actions: [
      { id: "s1", type: "switchRole", role: "applicant", effect: "READ" },
      { id: "s-nav", type: "goto", path: "/orders", effect: "READ" },
      { id: "s2", type: "assert", assertionId: "a1", effect: "READ" },
    ],
    assertions: [
      { id: "a1", stepId: "s2", required: true, ruleVersionId, kind: "ui.text", targetRef: "order-status", operator: "equals", expected: "付款待办" },
    ],
  };
  const finalCaseId = `case-v1-${Math.random().toString(36).slice(2, 10)}`;
  const caseDraftFinal = TestCaseVersion.safeParse({
    id: finalCaseId,
    caseId,
    version: 1,
    title: "边界用例",
    ruleVersionIds: [ruleVersionId],
    roles: ["applicant"],
    preconditions: [],
    dataSpec: { strategy: "create", note: "x" },
    steps: [{ id: "st1", role: "applicant", action: "a" }],
    assertions,
    cleanup: { strategy: "manual", note: "Read-only isolated synthetic page; no business resources created" },
    priority: "P1",
    approvalStatus: "DRAFT",
    supersedesId: null,
    origin: "manual",
    promptVersion: null,
    projectId,
    createdAt: new Date().toISOString(),
  });
  if (!caseDraftFinal.success) {
    throw new Error("测试资产用例解析失败: " + JSON.stringify(caseDraftFinal.error.issues.slice(0, 3)));
  }
  const planDraft = {
    ...planDraftBase,
    caseVersionId: finalCaseId,
  };
  const acceptanceHash = computePlanAcceptanceHash({
    testCase: caseDraftFinal.data,
    plan: planDraft as never,
  });
  // 存库的计划 JSON 本身必须含 acceptanceHash（verifyStoredPlan 重新解析）。
  const finalPlan = { ...planDraft, acceptanceHash };
  const caseVersionId = (
    await prisma.testCaseVersion.create({
      data: {
        id: finalCaseId,
        caseId,
        version: 1,
        title: "边界用例",
        ruleVersionIds: [ruleVersionId],
        roles: ["applicant"],
        preconditions: [],
        dataSpec: { strategy: "create", note: "x" },
        steps: [{ id: "st1", role: "applicant", action: "a" }],
        assertions: assertions as never,
        cleanup: { strategy: "manual", note: "Read-only isolated synthetic page; no business resources created" },
        origin: "manual",
        approvalStatus: "APPROVED",
        approvalHash: acceptanceHash,
        projectId,
      },
    })
  ).id;
  const planVersionId = (
    await prisma.testPlanVersion.create({
      data: {
        caseVersionId,
        version: 1,
        schemaVersion: "1.0",
        plan: finalPlan as never,
        bindingEvidenceIds: [evidenceArtifactId],
        acceptanceHash,
      },
    })
  ).id;

  const baselineId = (
    await prisma.baseline.create({
      data: {
        projectId,
        name: "边界基线",
        ruleVersionIds: [ruleVersionId],
        caseVersionIds: [caseVersionId],
      },
    })
  ).id;

  return { projectId, baselineId, environmentId, caseVersionId, planVersionId, evidenceArtifactId };
}
