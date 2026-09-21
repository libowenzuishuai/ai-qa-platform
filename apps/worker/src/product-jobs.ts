import { SourceClassificationOutput, TestCaseVersion, ObservationBundle, PlanProposalOutput, TestPlanV1, computePlanAcceptanceHash, verifyStoredPlan, validatePlanForExecutor, PHASE1_EXECUTOR_ACTIONS } from '@ai-qa/contracts';
import type { PrismaClient, Prisma } from '@prisma/client';
import type { ArtifactStore } from '@ai-qa/artifact-store';
import type { WorkerConfig } from './config.js';
import { callIntelligence } from './intelligence-client.js';
import { observeProject } from './observation.js';
import { discoverRepository } from './repository.js';

type Job = { id: string; projectId: string; kind: string; request: unknown; startedAt: Date | null };
export async function processProductJob(prisma: PrismaClient, store: ArtifactStore, config: WorkerConfig, job: Job, commit: (db: PrismaClient, job: Job, persist: (tx: Prisma.TransactionClient) => Promise<void>) => Promise<void>) {
  const {workflowId,workflowBudget,...request} = job.request as Record<string, any>;
  let result: unknown;
  if (job.kind === 'WEB_OBSERVATION') result = await observeProject(prisma, store, job.projectId, request,{signal:config.executionSignal,deadline:config.executionBudget?.deadline});
  else if (job.kind === 'REPO_DISCOVERY') {
    const discovered = await discoverRepository(request, store, job.id);
    if (discovered.files.length) {
      const response = await callIntelligence(config, 'sources', job.id, 'real', {promptVersion:'sources-v1',files:discovered.files.map(file=>({path:file.path,format:file.format,excerpt:['MARKDOWN','TXT'].includes(file.format)?store.read(file.storageKey).toString('utf8').slice(0,2000):''}))});
      for (const r of response.invocations) await prisma.modelInvocation.create({data:{projectId:job.projectId,provider:r.response.provider,model:r.response.model,promptVersion:r.promptVersion,requestId:job.id,usage:r.response.usage as never,outcome:r.response.outcome,latencyMs:r.response.latencyMs}});
      const classification=SourceClassificationOutput.parse(response.output);
      if(classification.files.length!==discovered.files.length || new Set(classification.files.map(f=>f.path)).size!==discovered.files.length || classification.files.some(f=>!discovered.files.some(d=>d.path===f.path))) throw Object.assign(new Error('资料分类遗漏或伪造文件'),{code:'MODEL_OUTPUT_INVALID'});
      discovered.files=discovered.files.map(file=>({...file,...classification.files.find(f=>f.path===file.path)!}));
    }
    await commit(prisma, job, async tx => {
      const previous = await tx.contextSnapshot.findFirst({ where: { projectId: job.projectId, repositoryUrl: discovered.repositoryUrl, subdirectory: discovered.subdirectory }, orderBy: { createdAt: 'desc' } });
      const snapshot = await tx.contextSnapshot.create({ data: { ...discovered, projectId: job.projectId, previousId: previous?.id } as never });
      await tx.job.update({ where: { id: job.id }, data: { status: 'SUCCEEDED', finishedAt: new Date(), result: { snapshotId: snapshot.id, fileCount: discovered.files.length } } });
    }); return;
  } else if (job.kind === 'PLAN_PROPOSAL') {
    const row = await prisma.testCaseVersion.findFirstOrThrow({ where: { id: request.caseVersionId, projectId: job.projectId, approvalStatus: 'APPROVED' } });
    const testCase = TestCaseVersion.parse({ ...row, description: row.description ?? undefined, approvalHash: row.approvalHash ?? undefined, createdAt: row.createdAt.toISOString() });
    const artifact = await prisma.artifact.findFirstOrThrow({ where: { id: request.observationId, projectId: job.projectId, type: 'OBSERVATION_BUNDLE' } });
    if (!store.verify(artifact.storageKey, artifact.checksum)) throw new Error('观察文件缺失或损坏');
    const observation = ObservationBundle.parse(JSON.parse(store.read(artifact.storageKey).toString()));
    const response = await callIntelligence(config, 'plan', job.id, request.mode, { testCase, observation, promptVersion: 'planner-v3' });
    for (const r of response.invocations) await prisma.modelInvocation.create({ data: { projectId: job.projectId, provider: r.response.provider, model: r.response.model, promptVersion: r.promptVersion, requestId: job.id, usage: r.response.usage as never, outcome: r.response.outcome, latencyMs: r.response.latencyMs } });
    const proposal = PlanProposalOutput.parse(response.output);
    if (proposal.blockedReasons.length) throw Object.assign(new Error(proposal.blockedReasons.join('；')), { code: 'VALIDATION_ERROR' });
    const plan = TestPlanV1.parse({ schemaVersion: '1.0', caseVersionId: row.id, ruleVersionIds: row.ruleVersionIds, roles: row.roles, acceptanceHash: '0'.repeat(64), bindings: observation.bindings,
      actions: proposal.actions, assertions: testCase.assertions.map(a => {
        const target = proposal.targets.find(t => t.assertionId === a.id);
        if (!target) throw new Error('模型遗漏批准的断言');
        return { ...a, timeoutMs: 2500, targetRef: target.targetRef, stepId: proposal.actions.find(action => action.type === "assert" && action.assertionId === a.id)?.id };
      }) });
    plan.acceptanceHash = computePlanAcceptanceHash({ testCase, plan });
    const check = verifyStoredPlan(plan, testCase);
    const capability = validatePlanForExecutor(plan, PHASE1_EXECUTOR_ACTIONS);
    if (!check.ok || !capability.ok) throw Object.assign(new Error('生成的计划未通过平台执行校验'), { code: 'MODEL_OUTPUT_INVALID' });
    await commit(prisma, job, async tx => {
      const saved = await tx.planProposal.create({ data: { projectId: job.projectId, caseVersionId: row.id, environmentId: observation.environmentId, environmentRevision: observation.environmentRevision, plan: plan as never, mode: request.mode } });
      await tx.job.update({ where: { id: job.id }, data: { status: 'SUCCEEDED', finishedAt: new Date(), result: { proposalId: saved.id } } });
    }); return;
  } else throw new Error('未知产品作业');
  await commit(prisma, job, async tx => { await tx.job.update({ where: { id: job.id }, data: { status: 'SUCCEEDED', finishedAt: new Date(), result: result as never } }); });
}
