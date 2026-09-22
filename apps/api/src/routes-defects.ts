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
    const q=z.object({page:z.coerce.number().int().min(1).max(100000).default(1),status:z.enum(['CANDIDATE','CONFIRMED','FIX_PENDING','READY_FOR_RETEST','VERIFIED','REJECTED','REOPENED']).optional(),severity:z.enum(['P0','P1','P2','P3']).optional(),assignedTo:z.string().optional()}).strict().parse(req.query);
    const where={projectId:id,status:q.status,severity:q.severity,assignedTo:q.assignedTo};
    const [defects,total,members]=await Promise.all([prisma.defect.findMany({where,include:{occurrences:{orderBy:{createdAt:'desc'},take:3},_count:{select:{occurrences:true}}},orderBy:[{updatedAt:'desc'},{id:'asc'}],skip:(q.page-1)*30,take:30}),prisma.defect.count({where}),prisma.projectMembership.findMany({where:{projectId:id},select:{userId:true,user:{select:{displayName:true}}}})]);
    return {defects,total,page:q.page,pageSize:30,members};
  });
  app.get('/api/defects/:id',async req=>{
    const {id}=z.object({id:z.string()}).parse(req.params),defect=await prisma.defect.findUnique({where:{id}});if(!defect)throw new ApiError('NOT_FOUND','缺陷不存在');
    await requireProjectAccess(prisma,req,defect.projectId);
    const {page}=z.object({page:z.coerce.number().int().min(1).max(100000).default(1)}).strict().parse(req.query);
    const [occurrences,total,members,runs]=await Promise.all([prisma.defectOccurrence.findMany({where:{defectId:id},orderBy:[{createdAt:'desc'},{id:'asc'}],skip:(page-1)*30,take:30}),prisma.defectOccurrence.count({where:{defectId:id}}),prisma.projectMembership.findMany({where:{projectId:defect.projectId},select:{userId:true,user:{select:{displayName:true}}}}),prisma.run.findMany({where:{projectId:defect.projectId,lifecycle:'FINISHED'},orderBy:{createdAt:'desc'},take:100,select:{id:true,buildId:true,createdAt:true,acceptanceStatus:true}})]);
    return {...defect,occurrences,total,page,pageSize:30,members,runs};
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
    const body=z.object({status:z.enum(['CONFIRMED','FIX_PENDING','READY_FOR_RETEST','REJECTED']),assignedTo:z.string().nullable().optional(),severity:z.enum(['P0','P1','P2','P3']).optional(),severityBasis:z.string().min(5).max(2000).optional(),expectedUpdatedAt:z.string().datetime().optional(),reason:z.string().min(1).max(2000)}).strict().parse(req.body);
    if(body.severity&&!body.severityBasis)throw new ApiError('VALIDATION_ERROR','修改严重度必须说明业务影响依据');
    if(body.assignedTo&&!await prisma.projectMembership.findUnique({where:{projectId_userId:{projectId:defect.projectId,userId:body.assignedTo}}}))throw new ApiError('VALIDATION_ERROR','负责人必须是项目成员');
    return prisma.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM "Defect" WHERE id=${id} FOR UPDATE`;
      const current=await tx.defect.findUniqueOrThrow({where:{id}});
      if(body.expectedUpdatedAt&&current.updatedAt.toISOString()!==body.expectedUpdatedAt)throw new ApiError('CONFLICT','缺陷已被其他人更新，请刷新后核对');
      const saved=await tx.defect.update({where:{id},data:{status:body.status,assignedTo:body.assignedTo,severity:body.severity,severityBasis:body.severityBasis}});
      await tx.auditEvent.create({data:{actorId:requireAuth(req).userId,action:'defect.update',entityType:'Defect',entityId:id,metadata:{reason:body.reason,before:{status:current.status,severity:current.severity,assignedTo:current.assignedTo},after:{status:saved.status,severity:saved.severity,assignedTo:saved.assignedTo,severityBasis:saved.severityBasis}}}});return saved;
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
