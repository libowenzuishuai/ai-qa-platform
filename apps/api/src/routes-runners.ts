import { reconcileCodeChecks } from '@ai-qa/run-events';
export { reconcileCodeChecks } from '@ai-qa/run-events';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { ArtifactStore } from '@ai-qa/artifact-store';
import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { CodeCheckRequest, RunnerResult } from '@ai-qa/contracts';
import { requireAuth, requireProjectAccess } from './auth.js';
import { ApiError } from './errors.js';
const digest=(x:string)=>createHash('sha256').update(x).digest('hex');
export function registerRunnerRoutes(app:FastifyInstance,prisma:PrismaClient,store:ArtifactStore){
  const id=(req:FastifyRequest)=>(req.params as {id:string}).id;
  async function runner(req:FastifyRequest){
    const token=req.headers.authorization?.match(/^Bearer (.{32,200})$/)?.[1];
    if(!token)throw new ApiError('UNAUTHENTICATED','缺少运行器凭据');
    const row=await prisma.executionRunner.findUnique({where:{tokenHash:digest(token)}});
    if(!row||row.revokedAt)throw new ApiError('UNAUTHENTICATED','运行器凭据无效');return row;
  }
  app.post('/api/projects/:id/runners',async req=>{
    const projectId=id(req);await requireProjectAccess(prisma,req,projectId,'ADMIN');
    const body=z.object({name:z.string().min(1).max(100),capabilities:z.array(z.enum(['NODE_TEST','PYTHON_TEST','NODE_BUILD'])).min(1)}).strict().parse(req.body);
    const token=randomBytes(32).toString('hex');const row=await prisma.executionRunner.create({data:{...body,projectId,tokenHash:digest(token)}});
    return {id:row.id,name:row.name,token,capabilities:row.capabilities};
  });
  app.post('/api/runners/:id/revoke',async req=>{
    const row=await prisma.executionRunner.findUnique({where:{id:id(req)}});if(!row)throw new ApiError('NOT_FOUND','运行器不存在');
    await requireProjectAccess(prisma,req,row.projectId,'ADMIN');
    return prisma.$transaction(async tx=>{
      await tx.executionRunner.update({where:{id:row.id},data:{revokedAt:new Date()}});
      await tx.codeCheck.updateMany({where:{runnerId:row.id,status:{in:['RUNNING','CANCEL_REQUESTED']}},data:{status:'ERROR',verdict:'INCOMPLETE',leaseToken:null,result:{reason:'运行器凭据已撤销'}}});return {ok:true};
    });
  });
  app.get('/api/projects/:id/code-checks',async req=>{
    const projectId=id(req);await requireProjectAccess(prisma,req,projectId);await reconcileCodeChecks(prisma);
    const checks=await prisma.codeCheck.findMany({where:{projectId},orderBy:{createdAt:'desc'},take:100});
    return {checks:checks.map(({leaseToken,result,...row})=>({...row,summary: result ? {caseCount: (result as any).cases?.length ?? 0, platformError: Boolean((result as any).platformError)} : null})),runners:await prisma.executionRunner.findMany({where:{projectId},select:{id:true,name:true,capabilities:true,revokedAt:true}})};
  });
  app.post('/api/projects/:id/code-checks',async req=>{
    const projectId=id(req);await requireProjectAccess(prisma,req,projectId,'LEAD');
    const body=CodeCheckRequest.parse(req.body);
    if(!await prisma.executionRunner.findFirst({where:{projectId,revokedAt:null,capabilities:{has:body.kind}}}))throw new ApiError('DEPENDENCY_UNAVAILABLE','请先注册支持此测试类型的运行器');
    return prisma.codeCheck.create({data:{projectId,request:body,createdBy:requireAuth(req).userId}});
  });
  app.post('/api/code-checks/:id/cancel',async req=>{
    const row=await prisma.codeCheck.findUnique({where:{id:id(req)}});if(!row)throw new ApiError('NOT_FOUND','检查不存在');
    await requireProjectAccess(prisma,req,row.projectId,'LEAD');
    await prisma.codeCheck.updateMany({where:{id:row.id,status:'QUEUED'},data:{status:'CANCELLED'}});
    await prisma.codeCheck.updateMany({where:{id:row.id,status:'RUNNING'},data:{status:'CANCEL_REQUESTED'}});return {ok:true};
  });
  app.post('/api/runner/claim',async req=>{
    const r=await runner(req);await reconcileCodeChecks(prisma);
    return prisma.$transaction(async tx=>{
      // The row lock ensures one runner owns a task even under concurrent polls.
      const rows=await tx.$queryRaw<Array<{id:string;request:unknown}>>`SELECT id, request FROM "CodeCheck" WHERE "projectId"=${r.projectId} AND status='QUEUED' AND request->>'kind'=ANY(${r.capabilities}::text[]) ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1`;
      const next=rows[0];if(!next)return {task:null};
      const spec=CodeCheckRequest.parse(next.request);const leaseToken=randomBytes(32).toString('hex');
      const saved=await tx.codeCheck.update({where:{id:next.id},data:{status:'RUNNING',runnerId:r.id,leaseToken,leaseExpiresAt:new Date(Date.now()+45000),deadlineAt:new Date(Date.now()+spec.timeoutSeconds*1000)}});
      return {task:{id:saved.id,request:spec,leaseToken,deadlineAt:saved.deadlineAt}};
    });
  });
  app.post('/api/runner/tasks/:id/heartbeat',async req=>{
    const r=await runner(req);const {leaseToken}=z.object({leaseToken:z.string()}).parse(req.body);const now=new Date();
    const changed=await prisma.codeCheck.updateMany({where:{id:id(req),runnerId:r.id,leaseToken,status:'RUNNING',leaseExpiresAt:{gt:now},deadlineAt:{gt:now}},data:{leaseExpiresAt:new Date(Date.now()+45000)}});
    return {continue:changed.count===1};
  });
  app.post('/api/runner/tasks/:id/result',{bodyLimit:2*1024*1024},async req=>{
    const r=await runner(req);const body=z.object({leaseToken:z.string(),result:RunnerResult}).strict().parse(req.body);
    return prisma.$transaction(async tx=>{
      const now=new Date();
      const claimed=await tx.codeCheck.updateMany({where:{id:id(req),projectId:r.projectId,runnerId:r.id,leaseToken:body.leaseToken,status:{in:['RUNNING','CANCEL_REQUESTED']},leaseExpiresAt:{gt:now},deadlineAt:{gt:now}},data:{updatedAt:now}});
      if(!claimed.count)throw new ApiError('CONFLICT','租约失效或任务已经结束');
      const task=await tx.codeCheck.findUniqueOrThrow({where:{id:id(req)}});const request=CodeCheckRequest.parse(task.request);
      if(body.result.commitSha!==request.commitSha)throw new ApiError('VALIDATION_ERROR','结果提交版本不匹配');
      const result=body.result;const cancelled=task.status==='CANCEL_REQUESTED';
      const verdict=cancelled||result.platformError?'INCOMPLETE':result.cases.some(c=>c.status==='FAIL')?'FAIL':result.exitCode===0&&result.cases.length>0&&result.cases.every(c=>c.status==='PASS')?'PASS':'INCOMPLETE';
      const stored=store.put({runId:`code-${task.id}`,attemptId:r.id,filename:'result.json',data:Buffer.from(JSON.stringify(result))});
      const artifact=await tx.artifact.create({data:{projectId:r.projectId,type:'CODE_TEST_RESULT',sensitivity:'RESTRICTED_RAW',storageKey:stored.storageKey,checksum:stored.checksum}});
      await tx.codeCheck.update({where:{id:task.id},data:{status:cancelled?'CANCELLED':result.platformError?'ERROR':'FINISHED',verdict,result:result as never,evidenceId:artifact.id,leaseToken:null}});return {ok:true,verdict};
    });
  });
}
