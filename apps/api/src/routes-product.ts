import { missionReadiness } from './mission-readiness.js';
import { projectSecretPrefix, validateSecretNamespace } from './environment-secrets.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient, Prisma } from '@prisma/client';
import type { Queue } from 'bullmq';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { ApiRequestTemplate, computePlanAcceptanceHash, TestCaseVersion, EnvironmentRuntime, ObservationRequest, GitConnectionRequest, MissionRequest, canonicalStringify, TestPlanV1, verifyStoredPlan } from '@ai-qa/contracts';
import type { ArtifactStore } from '@ai-qa/artifact-store';
import { requireAuth, requireProjectAccess } from './auth.js';
import { ApiError } from './errors.js';
import { createRun } from './runs-service.js';
import { buildRunReport } from '@ai-qa/reporting';

const ids = z.array(z.string().min(1)).min(1).max(200).refine(v => new Set(v).size === v.length);
const json = (x: unknown) => x as Prisma.InputJsonValue;
const hash = (x: unknown) => createHash('sha256').update(canonicalStringify(x)).digest('hex');
function parseCase(row: any) { return TestCaseVersion.parse({ ...row, description: row.description ?? undefined, approvalHash: row.approvalHash ?? undefined, createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt }); }

export function registerProductRoutes(app: FastifyInstance, prisma: PrismaClient, store: ArtifactStore, jobs: Pick<Queue,'add'>, runs: Pick<Queue,'add'>) {
  const param = (req: FastifyRequest, key = 'id') => z.record(z.string()).parse(req.params)[key]!;
  async function enqueue(projectId: string, kind: string, request: unknown, actorId: string) {
    const job = await prisma.job.create({ data: { projectId, kind, request: json(request), fingerprint: randomUUID() } });
    await prisma.auditEvent.create({ data: { actorId, action: kind.toLowerCase(), entityType: 'Job', entityId: job.id } });
    try { await jobs.add('run', { jobId: job.id }, { jobId: `job-${job.id}`, removeOnComplete: true }); } catch { /* Durable job reconciliation retries enqueue. */ }
    return { jobId: job.id };
  }
  async function caseFor(req: FastifyRequest, write = true) {
    const row = await prisma.testCaseVersion.findUnique({ where: { id: param(req) } });
    if (!row) throw new ApiError('NOT_FOUND','用例不存在');
    await requireProjectAccess(prisma, req, row.projectId, write ? 'LEAD' : 'VIEWER'); return row;
  }
  app.get('/api/projects/:id/workspace', async req => {
    const projectId = param(req); await requireProjectAccess(prisma, req, projectId);
    const [project, environments, cases, baselines, observations, proposals, missions, snapshots, defects, executions] = await Promise.all([
      prisma.project.findUniqueOrThrow({where:{id:projectId}}),
      prisma.environment.findMany({where:{projectId}}),
      prisma.testCaseVersion.findMany({where:{projectId},orderBy:{createdAt:'desc'},take:200,include:{plans:{select:{id:true,environmentId:true,environmentRevision:true,version:true}}}}),
      prisma.baseline.findMany({where:{projectId},orderBy:{createdAt:'desc'}}),
      prisma.artifact.findMany({where:{projectId,type:'OBSERVATION_BUNDLE'},orderBy:{createdAt:'desc'},take:30}),
      prisma.planProposal.findMany({where:{projectId},orderBy:{createdAt:'desc'},take:50}),
      prisma.mission.findMany({where:{projectId},orderBy:{createdAt:'desc'},take:100}),
      prisma.contextSnapshot.findMany({where:{projectId},orderBy:{createdAt:'desc'},take:20}),
      prisma.defect.findMany({where:{projectId},include:{occurrences:true},orderBy:{updatedAt:'desc'},take:100}),
      prisma.run.findMany({where:{projectId},orderBy:{createdAt:'desc'},take:100}),
    ]);
    const [documents,parsed]=await Promise.all([prisma.document.count({where:{projectId}}),prisma.document.count({where:{projectId,versions:{some:{parseStatus:"PARSED"}}}})]);
    return {sourceCounts:{documents,parsed},secretPrefix:projectSecretPrefix(projectId),project,environments,cases,baselines,observations,proposals,missions,snapshots,defects,executions};
  });
  app.post('/api/projects/:id/api-templates',async req=>{
    const projectId=param(req);await requireProjectAccess(prisma,req,projectId,'ADMIN');
    const body=z.object({environmentId:z.string(),request:ApiRequestTemplate}).strict().parse(req.body);
    if(!await prisma.environment.findFirst({where:{id:body.environmentId,projectId,isProduction:false}}))throw new ApiError('VALIDATION_ERROR','环境不可用');
    return prisma.apiTemplate.create({data:{projectId,environmentId:body.environmentId,request:json(body.request),createdBy:requireAuth(req).userId}});
  });
  app.post('/api/case-versions/:id/api-plan',async req=>{
    const row=await caseFor(req);const tc=parseCase(row);
    const body=z.object({templateId:z.string()}).strict().parse(req.body);
    if(tc.approvalStatus!=='APPROVED'||tc.assertions.length!==1||tc.assertions[0]!.kind!=='api.response')throw new ApiError('VALIDATION_ERROR','API 计划要求已批准、含一个接口断言的用例');
    const template=await prisma.apiTemplate.findFirst({where:{id:body.templateId,projectId:row.projectId}});if(!template)throw new ApiError('NOT_FOUND','模板不存在');
    const env=await prisma.environment.findUniqueOrThrow({where:{id:template.environmentId}});
    const request=ApiRequestTemplate.parse(template.request);
    const plan=TestPlanV1.parse({schemaVersion:'1.0',caseVersionId:tc.id,ruleVersionIds:tc.ruleVersionIds,roles:tc.roles,bindings:[],acceptanceHash:'0'.repeat(64),actions:[{id:'check',type:'apiCheck',effect:request.method==='GET'?'READ':'WRITE',assertionId:tc.assertions[0]!.id,templateId:template.id}],assertions:[{...tc.assertions[0],stepId:'check'}]});
    plan.acceptanceHash=computePlanAcceptanceHash({testCase:tc,plan});
    return prisma.planProposal.create({data:{projectId:row.projectId,caseVersionId:row.id,environmentId:env.id,environmentRevision:env.revision,plan:json(plan),mode:'real'}});
  });
  app.get('/api/case-versions/:id', async req => {
    const row = await caseFor(req, false);
    return { ...row, availableRules: await prisma.ruleVersion.findMany({where:{rule:{projectId:row.projectId},OR:[{reviewStatus:"APPROVED"},{id:{in:row.ruleVersionIds}}]},select:{id:true,statement:true,version:true,reviewStatus:true}}), plans: await prisma.testPlanVersion.findMany({ where: { caseVersionId: row.id }, orderBy: { version: 'desc' } }) };
  });
  app.post('/api/case-versions/:id/revise', async req => {
    const row = await caseFor(req);
    const body = z.object({ title: z.string().min(1), description: z.string().optional(), priority: z.enum(["P0","P1","P2"]).optional(), preconditions: z.array(z.string()), dataSpec: z.unknown(), steps: z.unknown(), assertions: z.unknown(), cleanup: z.unknown(), roles: z.array(z.string()), ruleVersionIds: ids }).strict().parse(req.body);
    return prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "TestCase" WHERE id = ${row.caseId} FOR UPDATE`;
      const last = await tx.testCaseVersion.findFirstOrThrow({ where: { caseId: row.caseId }, orderBy: { version: 'desc' } });
      const draft = parseCase({ ...row, ...body, id: randomUUID(), version: last.version+1, approvalStatus: 'DRAFT', approvalHash: undefined, supersedesId: row.id, origin: 'manual', createdAt: new Date() });
      const { createdAt, ...fields } = draft;
      const saved = await tx.testCaseVersion.create({ data: { ...fields, projectId: row.projectId } as never });
      await tx.testCase.update({ where: { id: row.caseId }, data: { currentVersionId: saved.id } });
      await tx.auditEvent.create({ data: { actorId: requireAuth(req).userId, action: 'case.revise', entityType: 'TestCaseVersion', entityId: saved.id, beforeRef: row.id } });
      return saved;
    });
  });
  app.post('/api/case-versions/:id/approve', async req => {
    const row = await caseFor(req);
    return prisma.$transaction(async tx => {
      const rules = await tx.ruleVersion.findMany({ where: { id: { in: row.ruleVersionIds }, rule: { projectId: row.projectId }, reviewStatus: 'APPROVED' } });
      if (rules.length !== row.ruleVersionIds.length || !rules.length) throw new ApiError('VALIDATION_ERROR','用例引用的规则必须全部已批准且属于当前项目');
      const tc = parseCase(row);
      if (tc.ruleVersionIds.some(id => !tc.assertions.some(a => a.ruleVersionId === id))) throw new ApiError('VALIDATION_ERROR','每个规则都需要对应的断言');
      if (row.approvalStatus === 'APPROVED') return row;
      const changed = await tx.testCaseVersion.updateMany({ where: { id: row.id, approvalStatus: 'DRAFT', semanticFrozen: false }, data: { approvalStatus: 'APPROVED', semanticFrozen: true, approvalHash: hash(tc) } });
      if (!changed.count) throw new ApiError('CONFLICT','用例状态变化，请刷新');
      await tx.auditEvent.create({ data: { actorId: requireAuth(req).userId, action: 'case.approve', entityType: 'TestCaseVersion', entityId: row.id } });
      return { id: row.id, approvalStatus: 'APPROVED' };
    });
  });
  app.post('/api/environments/:id/runtime', async req => {
    const env = await prisma.environment.findUnique({ where: { id: param(req) } });
    if (!env) throw new ApiError('NOT_FOUND','环境不存在');
    await requireProjectAccess(prisma, req, env.projectId, 'ADMIN');
    const body = EnvironmentRuntime.parse(req.body);
    validateSecretNamespace(env.projectId, body);
    const updated = await prisma.environment.update({ where: { id: env.id }, data: { runtime: json(body), secretRefs: json(body.secretRefs), revision: { increment: 1 } } });
    await prisma.auditEvent.create({ data: { actorId: requireAuth(req).userId, action: 'environment.runtime', entityType: 'Environment', entityId: env.id, metadata: { revision: updated.revision } } });
    return { environmentId: updated.id, revision: updated.revision };
  });
  app.post('/api/projects/:id/observations', async (req, reply) => {
    const projectId = param(req); await requireProjectAccess(prisma, req, projectId, 'LEAD');
    const body = ObservationRequest.parse(req.body);
    if (!await prisma.environment.findFirst({ where: { id: body.environmentId, projectId, isProduction: false } })) throw new ApiError('NOT_FOUND','环境不存在');
    reply.code(202); return enqueue(projectId, 'WEB_OBSERVATION', body, requireAuth(req).userId);
  });
  app.post('/api/case-versions/:id/propose-plan', async (req, reply) => {
    const row = await caseFor(req);
    if (row.approvalStatus !== 'APPROVED') throw new ApiError('VALIDATION_ERROR','请先批准用例');
    const body = z.object({ observationId: z.string(), mode: z.enum(['real','mock']).default('real') }).strict().parse(req.body);
    if (!await prisma.artifact.findFirst({ where: { id: body.observationId, projectId: row.projectId, type: 'OBSERVATION_BUNDLE' } })) throw new ApiError('NOT_FOUND','观察不存在');
    reply.code(202); return enqueue(row.projectId,'PLAN_PROPOSAL',{ ...body, caseVersionId: row.id }, requireAuth(req).userId);
  });
  app.get('/api/plan-proposals/:id', async req => {
    const row = await prisma.planProposal.findUnique({ where: { id: param(req) } });
    if (!row) throw new ApiError('NOT_FOUND','计划建议不存在');
    await requireProjectAccess(prisma, req, row.projectId); return row;
  });
  app.post('/api/plan-proposals/:id/approve', async req => {
    const proposal = await prisma.planProposal.findUnique({ where: { id: param(req) } });
    if (!proposal) throw new ApiError('NOT_FOUND','计划建议不存在');
    await requireProjectAccess(prisma, req, proposal.projectId,'LEAD');
    if (proposal.mode !== 'real') throw new ApiError('VALIDATION_ERROR','模拟计划不能批准为真实验收计划');
    return prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "TestCaseVersion" WHERE id = ${proposal.caseVersionId} FOR UPDATE`;
      const row = await tx.testCaseVersion.findUniqueOrThrow({ where: { id: proposal.caseVersionId } });
      const env = await tx.environment.findFirst({ where: { id: proposal.environmentId, projectId: proposal.projectId, revision: proposal.environmentRevision } });
      if (!env) throw new ApiError('CONFLICT','环境已变化，请重新观察');
      const check = verifyStoredPlan(proposal.plan, parseCase(row));
      if (!check.ok) throw new ApiError('VALIDATION_ERROR','计划不符合批准用例',check.problems);
      const plan = TestPlanV1.parse(proposal.plan);
      for (const binding of plan.bindings) {
        const artifact = await tx.artifact.findFirst({ where: { id: binding.evidenceId, projectId: proposal.projectId, type: 'OBSERVATION' } });
        if (!artifact || !store.verify(artifact.storageKey, artifact.checksum)) throw new ApiError('VALIDATION_ERROR','观察证据无效');
      }
      const prior = await tx.testPlanVersion.findFirst({ where: { caseVersionId: row.id }, orderBy: { version: 'desc' } });
      if (prior?.acceptanceHash === plan.acceptanceHash && prior.environmentRevision === env.revision && prior.environmentId === env.id) return prior;
      const saved = await tx.testPlanVersion.create({ data: { caseVersionId: row.id, version: (prior?.version ?? 0)+1, schemaVersion: '1.0', plan: json(plan), acceptanceHash: plan.acceptanceHash, bindingEvidenceIds: plan.bindings.map(b=>b.evidenceId), environmentId: env.id, environmentRevision: env.revision } });
      await tx.auditEvent.create({ data: { actorId: requireAuth(req).userId, action: 'plan.approve', entityType: 'TestPlanVersion', entityId: saved.id } }); return saved;
    });
  });
  app.post('/api/projects/:id/baselines', async req => {
    const projectId = param(req); await requireProjectAccess(prisma, req, projectId,'LEAD');
    const body = z.object({ name: z.string().min(1).max(200), caseVersionIds: ids }).strict().parse(req.body);
    const cases = await prisma.testCaseVersion.findMany({ where: { id: { in: body.caseVersionIds }, projectId, approvalStatus: 'APPROVED' }, include: { plans: true } });
    if (cases.length !== body.caseVersionIds.length || cases.some(c=>!c.plans.length)) throw new ApiError('VALIDATION_ERROR','请选择已批准且绑定计划的用例');
    return prisma.baseline.create({ data: { projectId, name: body.name, caseVersionIds: body.caseVersionIds, ruleVersionIds: [...new Set(cases.flatMap(c=>c.ruleVersionIds))] } });
  });
  app.post('/api/projects/:id/repositories', async (req, reply) => {
    const projectId = param(req); await requireProjectAccess(prisma, req, projectId,'LEAD');
    reply.code(202); return enqueue(projectId,'REPO_DISCOVERY',GitConnectionRequest.parse(req.body),requireAuth(req).userId);
  });
  app.get('/api/projects/:id/context', async req => {
    const projectId = param(req); await requireProjectAccess(prisma, req, projectId);
    const snapshots = await prisma.contextSnapshot.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 20 });
    return { snapshots, sources: await prisma.contextSource.findMany({ where: { snapshotId: { in: snapshots.map(s=>s.id) } } }) };
  });
  app.post('/api/context/:id/import', async (req, reply) => {
    const snapshot = await prisma.contextSnapshot.findUnique({ where: { id: param(req) } });
    if (!snapshot) throw new ApiError('NOT_FOUND','上下文不存在');
    await requireProjectAccess(prisma, req, snapshot.projectId,'LEAD');
    const body = z.object({ paths: ids }).strict().parse(req.body);
    const files = snapshot.files as Array<{ path: string; category: string; checksum: string; storageKey: string; format: string; size: number }>;
    const created = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "ContextSnapshot" WHERE id = ${snapshot.id} FOR UPDATE`;
      const results: { documentVersionId: string; jobId?: string }[] = [];
      for (const path of body.paths) {
        const file = files.find(f=>f.path === path);
        if (!file || file.category !== 'BUSINESS_CANDIDATE') throw new ApiError('VALIDATION_ERROR','只能将已发现的业务资料候选导入需求；运行说明和现有测试不是业务依据');
        if (!store.verify(file.storageKey,file.checksum)) throw new ApiError('VALIDATION_ERROR','仓库资料损坏');
        const existing = await tx.contextSource.findUnique({ where: { snapshotId_path: { snapshotId: snapshot.id, path } } });
        if (existing) { results.push({ documentVersionId: existing.documentVersionId }); continue; }
        const reusable = await tx.documentVersion.findFirst({ where: { checksum: file.checksum, document: { projectId: snapshot.projectId }, parseStatus: 'PARSED', mode: 'real' } });
        let versionId = reusable?.id, jobId: string | undefined;
        if (!versionId) {
          const doc = await tx.document.create({ data: { projectId: snapshot.projectId, title: file.path } });
          const version = await tx.documentVersion.create({ data: { documentId: doc.id, version: 1, checksum: file.checksum, storageKey: file.storageKey, format: file.format, parseStatus: 'PENDING', mode: 'real', fileSizeBytes: file.size } });
          versionId = version.id;
          const job = await tx.job.create({ data: { projectId: snapshot.projectId, kind: 'DOCUMENT_PARSE', fingerprint: hash({ versionId }), request: { documentId: doc.id, documentVersionId: version.id, mode: 'real' } } }); jobId = job.id;
        }
        await tx.contextSource.create({ data: { snapshotId: snapshot.id, path, documentVersionId: versionId, authority: 'BUSINESS_CANDIDATE', confirmedBy: requireAuth(req).userId } });
        results.push({ documentVersionId: versionId, jobId });
      } return results;
    });
    for (const result of created) if (result.jobId) { try { await jobs.add('run',{jobId:result.jobId},{jobId:`job-${result.jobId}`,removeOnComplete:true}); } catch {} }
    reply.code(202); return { documents: created };
  });
  app.post('/api/projects/:id/missions', async req => {
    const projectId = param(req); await requireProjectAccess(prisma, req, projectId,'LEAD');
    const body = MissionRequest.parse(req.body);
    if (!await prisma.baseline.findFirst({ where: { id: body.baselineId, projectId } }) || !await prisma.environment.findFirst({ where: { id: body.environmentId, projectId } })) throw new ApiError('VALIDATION_ERROR','基线或环境不属于本项目');
    if (body.contextSnapshotId && !await prisma.contextSnapshot.findFirst({ where: { id: body.contextSnapshotId, projectId } })) throw new ApiError('VALIDATION_ERROR','上下文不属于本项目');
    return prisma.mission.create({ data: { ...body, projectId, createdBy: requireAuth(req).userId } });
  });
  app.get('/api/projects/:id/missions', async req => {
    const projectId = param(req); await requireProjectAccess(prisma, req, projectId);
    const missions = await prisma.mission.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 100 });
    return { missions, runs: await prisma.missionRun.findMany({ where: { missionId: { in: missions.map(m=>m.id) } } }) };
  });
  app.get('/api/missions/:id/readiness', async req => {
    const mission=await prisma.mission.findUnique({where:{id:param(req)}});
    if(!mission)throw new ApiError('NOT_FOUND','任务不存在');
    await requireProjectAccess(prisma,req,mission.projectId);
    return {...await missionReadiness(prisma,mission),projectId:mission.projectId,title:mission.title};
  });
  app.post('/api/missions/:id/start', async req => {
    const mission = await prisma.mission.findUnique({ where: { id: param(req) } });
    if (!mission) throw new ApiError('NOT_FOUND','任务不存在');
    await requireProjectAccess(prisma, req, mission.projectId,'LEAD');
    const body = z.object({ buildId: z.string().min(1).max(200), idempotencyKey: z.string().min(1).max(200) }).strict().parse(req.body);
    const readiness=await missionReadiness(prisma,mission);
    if(!readiness.configurationReady)throw new ApiError('VALIDATION_ERROR',readiness.blockers.join('；'));
    const baseline = await prisma.baseline.findUniqueOrThrow({ where: { id: mission.baselineId } });
    const created = await createRun(prisma,store,{ ...body, projectId:mission.projectId, baselineId:baseline.id, environmentId:mission.environmentId, mode:'real', caseVersionIds:baseline.caseVersionIds });
    const existing = await prisma.missionRun.findUnique({ where: { runId: created.runId } });
    if (existing && existing.missionId !== mission.id) throw new ApiError('IDEMPOTENCY_CONFLICT','此幂等键属于另一任务');
    await prisma.missionRun.upsert({ where: { runId:created.runId }, create:{missionId:mission.id,runId:created.runId},update:{} });
    try { await runs.add('execute',{runId:created.runId},{jobId:`run-${created.runId}`,removeOnComplete:true}); } catch {}
    return created;
  });
  app.get('/api/runs/:id/export',async(req,reply)=>{
    const run=await prisma.run.findUnique({where:{id:param(req)}}); if(!run) throw new ApiError('NOT_FOUND','运行不存在');
    await requireProjectAccess(prisma,req,run.projectId);
    const report=await buildRunReport(prisma,store,run.id);
    reply.header('content-disposition',`attachment; filename="report-${run.id}.json"`); return report;
  });
}
