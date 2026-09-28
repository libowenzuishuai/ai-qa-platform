import {ArtifactStore} from '@ai-qa/artifact-store';
import {investigateEvidence} from './v2-investigate.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {PrismaClient} from '@prisma/client';
import {createHash} from 'node:crypto';
import {canonicalStringify} from '@ai-qa/contracts';
import {z} from 'zod';
import {requireAuth,requireProjectAccess} from './auth.js';
import {ApiError} from './errors.js';
import {requireV2Evidence} from './v2-evidence.js';
const hash=(v:unknown)=>createHash('sha256').update(canonicalStringify(v)).digest('hex');
export function registerV2InvestigationRoutes(app:FastifyInstance,prisma:PrismaClient,artifactDir?:string){
 const id=(req:FastifyRequest)=>(req.params as {id:string}).id;

 app.post('/api/v2/findings/:id/investigate',async req=>{
  const finding=await prisma.v2Finding.findUnique({where:{id:id(req)}});if(!finding)throw new ApiError('NOT_FOUND','问题不存在');
  await requireProjectAccess(prisma,req,finding.projectId,'LEAD');
  if(!artifactDir)throw new ApiError('DEPENDENCY_UNAVAILABLE','证据目录未配置');
  const first=finding.firstFailure as {sessionId?:string;evidenceIds:string[]};
  if(!first.sessionId)throw new ApiError('CONFLICT','缺少原始运行，不能自动调查');
  const session=await prisma.v2ExecutionSession.findFirst({where:{id:first.sessionId,projectId:finding.projectId,status:{in:['COMPLETED','FAILED']}}});
  if(!session)throw new ApiError('CONFLICT','原始运行不存在或尚未结束');
  const observations=await prisma.v2Observation.findMany({where:{sessionId:session.id},orderBy:{observedAt:'asc'},take:500});
  const ids=[...new Set([...first.evidenceIds,...observations.flatMap(o=>o.evidenceArtifactIds)])];
  await requireV2Evidence(prisma,finding.projectId,ids,artifactDir);
  const store=new ArtifactStore(artifactDir),records=[];
  for(const observation of observations)for(const id of observation.evidenceArtifactIds){
    const artifact=await prisma.artifact.findUniqueOrThrow({where:{id}});if(artifact.type==='SCREENSHOT')continue;
    const bytes=store.read(artifact.storageKey);if(bytes.length>4*1024*1024)continue;
    try{records.push({id,source:observation.source,body:JSON.parse(bytes.toString())});}catch{/* Non-JSON evidence is retained but cannot support structured diagnosis. */}
  }
  const report=investigateEvidence(records);
  await prisma.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM "V2Finding" WHERE id=${finding.id} FOR UPDATE`;
    const fresh=await tx.v2Finding.findUniqueOrThrow({where:{id:finding.id}});
    if(['rejected','fix_verified'].includes(fresh.status))throw new ApiError('CONFLICT','已关闭问题不能被调查覆盖');
    await tx.v2Finding.update({where:{id:finding.id},data:{status:'investigating',hypotheses:report.hypotheses}});
    await tx.auditEvent.create({data:{actorId:requireAuth(req).userId,action:'v2.finding.investigate',entityType:'V2Finding',entityId:finding.id,metadata:{...report,sessionId:session.id,evidenceIds:ids} as never}});
  });return report;
 });
 app.post('/api/v2/findings/:id/verify-session',async req=>{
  const finding=await prisma.v2Finding.findUnique({where:{id:id(req)}});if(!finding)throw new ApiError('NOT_FOUND','问题不存在');
  await requireProjectAccess(prisma,req,finding.projectId,'LEAD');
  const body=z.object({sessionId:z.string(),purpose:z.enum(['reproduce','verify_fix'])}).strict().parse(req.body);
  const first=finding.firstFailure as {sessionId:string;evidenceIds:string[]};
  if(body.sessionId===first.sessionId)throw new ApiError('CONFLICT','首败不能冒充独立复现');
  const [original,current]=await Promise.all([prisma.v2ExecutionSession.findFirst({where:{id:first.sessionId,projectId:finding.projectId}}),prisma.v2ExecutionSession.findFirst({where:{id:body.sessionId,projectId:finding.projectId}})]);
  if(!original||!current||original.oracleHash!==current.oracleHash||!['COMPLETED','FAILED'].includes(current.status))throw new ApiError('CONFLICT','需要本项目、相同业务标准且已结束的独立运行');
  if(original.profileHash!==current.profileHash||original.definitionId!==current.definitionId||original.definitionVersion!==current.definitionVersion||original.environmentId!==current.environmentId)throw new ApiError('CONFLICT','对照运行的组合、配置和环境必须相同');
  const checks=(original.result as {checks?:Array<{assertionId:string}>}|null)?.checks??[];
  const assertion=checks.find(c=>hash({oracleHash:original.oracleHash,assertionId:c.assertionId,buildId:original.buildId})===finding.dedupeKey);
  if(!assertion)throw new ApiError('CONFLICT','问题没有可核验的原始标准映射');
  const result=current.result as {verdict:string;checks?:Array<{assertionId:string;verdict:string}>};
  const matched=result.checks?.find(c=>c.assertionId===assertion.assertionId);
  if((current.result as {buildVerification?:{verified:boolean}}|null)?.buildVerification?.verified!==true||(original.result as {buildVerification?:{verified:boolean}}|null)?.buildVerification?.verified!==true)throw new ApiError('CONFLICT','复现和修复核验需要两个运行都具备真实构建身份');
  if(body.purpose==='verify_fix'&&(current.buildId===original.buildId||result.verdict!=='pass'||matched?.verdict!=='pass'))throw new ApiError('CONFLICT','修复核验需要不同构建、相同标准且完整通过');
  if(body.purpose==='reproduce'&&(matched?.verdict!=='fail'||current.buildId!==original.buildId))throw new ApiError('CONFLICT','复现需要同构建的同一断言再次失败');
  const observations=await prisma.v2Observation.findMany({where:{sessionId:current.id}});
  const evidenceIds=observations.flatMap(o=>o.evidenceArtifactIds);
  await requireV2Evidence(prisma,finding.projectId,[...first.evidenceIds,...evidenceIds],artifactDir);
  const status=body.purpose==='reproduce'?'reproduced':'fix_verified';
  return prisma.$transaction(async tx=>{
   await tx.$queryRaw`SELECT id FROM "V2Finding" WHERE id=${finding.id} FOR UPDATE`;
   const fresh=await tx.v2Finding.findUniqueOrThrow({where:{id:finding.id}});
   if(fresh.status==='rejected')throw new ApiError('CONFLICT','已驳回的问题需先重新调查');
   const updated=await tx.v2Finding.update({where:{id:finding.id},data:{status,minimalReproduction:{steps:[{action:"运行相同冻结组合并检查原始断言",target:current.definitionId}],resourceKeys:[],verifiedAt:current.updatedAt.toISOString()}}});
   await tx.auditEvent.create({data:{actorId:requireAuth(req).userId,action:`v2.finding.${body.purpose}`,entityType:'V2Finding',entityId:finding.id,metadata:{sessionId:current.id,assertionId:assertion.assertionId,evidenceIds,from:fresh.status,to:status}}});
   return updated;
  });
 });
}
