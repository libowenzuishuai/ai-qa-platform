import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { ArtifactStore } from '@ai-qa/artifact-store';
import type { Queue } from 'bullmq';
import { z } from 'zod';
import { requireProjectAccess, requireAuth } from './auth.js';
import { ApiError } from './errors.js';
import { createRun } from './runs-service.js';
import { buildRunReport, syncRunDefects } from '@ai-qa/reporting';

export function registerDefectRoutes(app: FastifyInstance, prisma: PrismaClient, store: ArtifactStore, runs: Pick<Queue,'add'>) {
  app.get('/api/projects/:id/defects', async req => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireProjectAccess(prisma,req,id);
    return { defects: await prisma.defect.findMany({ where:{projectId:id},include:{occurrences:{orderBy:{createdAt:'desc'}}},orderBy:{updatedAt:'desc'},take:100 }) };
  });
  app.post('/api/runs/:id/findings',async req=>{
    const {id}=z.object({id:z.string()}).parse(req.params);
    const run=await prisma.run.findUnique({where:{id}});if(!run)throw new ApiError('NOT_FOUND','运行不存在');
    await requireProjectAccess(prisma,req,run.projectId,'LEAD');await syncRunDefects(prisma,store,id);return {ok:true};
  });
  app.post('/api/defects/:id/update', async req=>{
    const {id}=z.object({id:z.string()}).parse(req.params);
    const defect=await prisma.defect.findUnique({where:{id}});if(!defect)throw new ApiError('NOT_FOUND','缺陷不存在');
    await requireProjectAccess(prisma,req,defect.projectId,'LEAD');
    const body=z.object({status:z.enum(['CONFIRMED','FIX_PENDING','READY_FOR_RETEST','REJECTED']),assignedTo:z.string().optional(),reason:z.string().min(1).max(2000)}).strict().parse(req.body);
    if(body.assignedTo&&!await prisma.projectMembership.findUnique({where:{projectId_userId:{projectId:defect.projectId,userId:body.assignedTo}}}))throw new ApiError('VALIDATION_ERROR','负责人必须是项目成员');
    return prisma.$transaction(async tx=>{
      const saved=await tx.defect.update({where:{id},data:{status:body.status,assignedTo:body.assignedTo}});
      await tx.auditEvent.create({data:{actorId:requireAuth(req).userId,action:'defect.update',entityType:'Defect',entityId:id,metadata:{reason:body.reason,before:defect.status,after:body.status}}});return saved;
    });
  });
  app.post('/api/runs/:id/retest',async req=>{
    const {id}=z.object({id:z.string()}).parse(req.params);
    const original=await prisma.run.findUnique({where:{id}});if(!original)throw new ApiError('NOT_FOUND','原运行不存在');
    await requireProjectAccess(prisma,req,original.projectId,'LEAD');
    if(!['FINISHED','ERROR','CANCELLED'].includes(original.lifecycle))throw new ApiError('CONFLICT','原运行尚未结束');
    const body=z.object({buildId:z.string().min(1).max(200),idempotencyKey:z.string().min(1).max(200)}).strict().parse(req.body);
    if(body.buildId===original.buildId)throw new ApiError('VALIDATION_ERROR','修复复测需要新的构建版本');
    const pins=original.casePlanPins as Array<{caseVersionId:string;planVersionId:string;acceptanceHash:string}>;
    const created=await createRun(prisma,store,{...body,projectId:original.projectId,baselineId:original.baselineId,environmentId:original.environmentId,caseVersionIds:original.selectedCaseVersionIds,mode:'real',pinnedPlans:pins});
    const existing=await prisma.missionRun.findUnique({where:{runId:created.runId}});
    if(existing&&existing.retestOf!==id)throw new ApiError('IDEMPOTENCY_CONFLICT','该幂等键已用于其他运行');
    const prior=await prisma.missionRun.findUnique({where:{runId:id}});
    const missionId=prior?.missionId ?? (await prisma.mission.create({data:{projectId:original.projectId,title:'原运行修复复测',goal:'沿用原始验收标准检查新构建',template:'RETEST',baselineId:original.baselineId,environmentId:original.environmentId,createdBy:requireAuth(req).userId}})).id;
    await prisma.missionRun.upsert({where:{runId:created.runId},create:{runId:created.runId,missionId,retestOf:id},update:{}});
    try{await runs.add('execute',{runId:created.runId},{jobId:`run-${created.runId}`,removeOnComplete:true});}catch{}
    return created;
  });
  app.post('/api/defects/:id/verify',async req=>{
    const {id}=z.object({id:z.string()}).parse(req.params);
    const defect=await prisma.defect.findUnique({where:{id},include:{occurrences:true}});if(!defect)throw new ApiError('NOT_FOUND','缺陷不存在');
    await requireProjectAccess(prisma,req,defect.projectId,'LEAD');
    const {runId}=z.object({runId:z.string()}).strict().parse(req.body);
    const link=await prisma.missionRun.findUnique({where:{runId}});
    if(!link?.retestOf||!defect.occurrences.some(o=>o.runId===link.retestOf))throw new ApiError('VALIDATION_ERROR','复测必须关联此缺陷的原始失败运行');
    const report=await buildRunReport(prisma,store,runId);
    if(report.run.lifecycle!=='FINISHED'||!report.run.buildVerified)throw new ApiError('VALIDATION_ERROR','复测未完成或实际版本未核验');
    const originals=await prisma.caseAttempt.findMany({where:{id:{in:defect.occurrences.filter(o=>o.runId===link.retestOf).flatMap(o=>o.attemptId?[o.attemptId]:[])}}});
    if(!originals.length||originals.some(a=>!report.cases.some(c=>c.caseVersionId===a.caseVersionId&&c.verdict==='PASS')))throw new ApiError('VALIDATION_ERROR','原失败用例未在新版本通过');
    return prisma.$transaction(async tx=>{
      const saved=await tx.defect.update({where:{id},data:{status:'VERIFIED'}});
      await tx.auditEvent.create({data:{actorId:requireAuth(req).userId,action:'defect.verify',entityType:'Defect',entityId:id,metadata:{runId,originalRunId:link.retestOf}}});return saved;
    });
  });
}
