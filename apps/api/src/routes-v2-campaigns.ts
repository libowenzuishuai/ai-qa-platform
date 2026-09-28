import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {PrismaClient,Prisma} from '@prisma/client';
import {z} from 'zod';
import {randomUUID,createHash} from 'node:crypto';
import {canonicalStringify} from '@ai-qa/contracts';
import {requireAuth,requireProjectAccess} from './auth.js';
import {ApiError} from './errors.js';
import {requireV2Evidence} from './v2-evidence.js';
const flowSchema=z.object({id:z.string().min(1).max(100),buildId:z.string().min(1).max(200),oracleHash:z.string().regex(/^[a-f0-9]{64}$/),profileHash:z.string().regex(/^[a-f0-9]{64}$/),expected:z.enum(['pass','fail']),assertionId:z.string().min(1),defectId:z.string().min(1).nullable(),sourceEvidenceIds:z.array(z.string()).min(1).max(20),manualBaselineMinutes:z.number().positive().nullable()}).strict();
const campaignSchema=z.object({name:z.string().min(1).max(200),sampleKind:z.enum(['synthetic','authorized_real']),authorizationEvidenceIds:z.array(z.string()).min(1).max(20),flows:z.array(flowSchema).min(1).max(500)}).strict();
type Campaign=z.infer<typeof campaignSchema>&{projectId:string;hash:string};
function proportion(n:number,d:number){if(!d)return {numerator:n,denominator:d,value:null,wilson95:null};const p=n/d,z=1.96,den=1+z*z/d,mid=(p+z*z/(2*d))/den,r=z*Math.sqrt(p*(1-p)/d+z*z/(4*d*d))/den;return {numerator:n,denominator:d,value:p,wilson95:[Math.max(0,mid-r),Math.min(1,mid+r)]};}
/** Truth lives in ADMIN-only frozen audit manifests, never in execution tasks or planner context. */
/** Must run inside the same transaction as session creation, before queue delivery. */
export async function enrollEvaluationSession(tx:Prisma.TransactionClient,args:{projectId:string;campaignId:string;flowId:string;sessionId:string;actorId:string},artifactDir?:string){
 const row=await tx.auditEvent.findFirst({where:{entityType:'V2EvaluationCampaign',entityId:args.campaignId,action:'v2.campaign.freeze'}});
 const c=row?.metadata as unknown as Campaign|undefined;
 if(!c||c.projectId!==args.projectId)throw new ApiError('NOT_FOUND','评测批次不属于当前项目');
 const body=campaignSchema.parse({name:c.name,sampleKind:c.sampleKind,authorizationEvidenceIds:c.authorizationEvidenceIds,flows:c.flows});
 if(createHash('sha256').update(canonicalStringify(body)).digest('hex')!==c.hash)throw new ApiError('CONFLICT','冻结评测内容哈希不符');
 const flow=c.flows.find(f=>f.id===args.flowId);if(!flow)throw new ApiError('VALIDATION_ERROR','流程不在冻结集合');
 await requireV2Evidence(tx as PrismaClient,args.projectId,[...c.authorizationEvidenceIds,...flow.sourceEvidenceIds],artifactDir);
 // Worker lease acquisition updates this row too: start and enrollment cannot cross.
 await tx.$queryRaw`SELECT id FROM "V2ExecutionSession" WHERE id=${args.sessionId} FOR UPDATE`;
 const entries=await tx.auditEvent.findMany({where:{entityType:'V2EvaluationCampaign',entityId:args.campaignId,action:'v2.campaign.enroll'}});
 const old=entries.find(e=>(e.metadata as {sessionId:string}).sessionId===args.sessionId);
 if(old){if((old.metadata as {flowId:string}).flowId!==args.flowId)throw new ApiError('CONFLICT','同一次运行不能充当多条独立样本');return {enrolled:true,existed:true};}
 const session=await tx.v2ExecutionSession.findFirst({where:{id:args.sessionId,projectId:args.projectId}});
 if(!session||session.startedAt||session.status!=='QUEUED'||session.createdAt<row!.createdAt)throw new ApiError('CONFLICT','只能登记冻结之后创建且未开始的运行，禁止挑选已知结果');
 if(session.oracleHash!==flow.oracleHash||session.profileHash!==flow.profileHash||session.buildId!==flow.buildId)throw new ApiError('CONFLICT','运行与冻结标准、配置或构建不一致');
 await tx.auditEvent.create({data:{actorId:args.actorId,entityType:'V2EvaluationCampaign',entityId:args.campaignId,action:'v2.campaign.enroll',metadata:{flowId:args.flowId,sessionId:args.sessionId,sequence:entries.length+1}}});return {enrolled:true,existed:false};
}
export function registerV2CampaignRoutes(app:FastifyInstance,prisma:PrismaClient,artifactDir?:string){
 const id=(req:FastifyRequest)=>(req.params as {id:string}).id;
 async function campaign(req:FastifyRequest){const row=await prisma.auditEvent.findFirst({where:{entityType:'V2EvaluationCampaign',entityId:id(req),action:'v2.campaign.freeze'}});if(!row)throw new ApiError('NOT_FOUND','评测批次不存在');const c=row.metadata as unknown as Campaign;await requireProjectAccess(prisma,req,c.projectId,'ADMIN');const body=campaignSchema.parse({name:c.name,sampleKind:c.sampleKind,authorizationEvidenceIds:c.authorizationEvidenceIds,flows:c.flows});if(createHash('sha256').update(canonicalStringify(body)).digest('hex')!==c.hash)throw new ApiError('CONFLICT','冻结评测内容哈希不符');return {row,c};}
 app.get('/api/v2/projects/:id/campaigns',async req=>{
  const projectId=id(req);await requireProjectAccess(prisma,req,projectId,'ADMIN');
  const rows=await prisma.auditEvent.findMany({where:{entityType:'V2EvaluationCampaign',action:'v2.campaign.freeze',metadata:{path:['projectId'],equals:projectId}},orderBy:{createdAt:'desc'},take:100});
  return {campaigns:rows.map(row=>{const c=row.metadata as unknown as Campaign;return {id:row.entityId,name:c.name,sampleKind:c.sampleKind,hash:c.hash,flows:c.flows.length,createdAt:row.createdAt};})};
 });
 app.post('/api/v2/projects/:id/campaigns',async(req,reply)=>{
  const projectId=id(req);await requireProjectAccess(prisma,req,projectId,'ADMIN');const body=campaignSchema.parse(req.body);
  if(new Set(body.flows.map(f=>f.id)).size!==body.flows.length||body.flows.some(f=>f.expected==='fail'&&!f.defectId||f.expected==='pass'&&f.defectId))throw new ApiError('VALIDATION_ERROR','样本 ID 重复或缺陷真值不一致');
  await requireV2Evidence(prisma,projectId,[...body.authorizationEvidenceIds,...body.flows.flatMap(f=>f.sourceEvidenceIds)],artifactDir);
  const hash=createHash('sha256').update(canonicalStringify(body)).digest('hex'),campaignId=randomUUID();
  await prisma.auditEvent.create({data:{actorId:requireAuth(req).userId,entityType:'V2EvaluationCampaign',entityId:campaignId,action:'v2.campaign.freeze',metadata:{...body,projectId,hash} as never}});
  return reply.code(201).send({campaignId,hash,sampleKind:body.sampleKind,total:body.flows.length});
 });
 app.post('/api/v2/campaigns/:id/enroll',async req=>{
  const {c,row}=await campaign(req),body=z.object({flowId:z.string(),sessionId:z.string()}).strict().parse(req.body),flow=c.flows.find(f=>f.id===body.flowId);
  if(!flow)throw new ApiError('VALIDATION_ERROR','流程不在冻结集合');
  return prisma.$transaction(async tx=>{
   await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${c.projectId} FOR UPDATE`;
   return enrollEvaluationSession(tx,{projectId:c.projectId,campaignId:id(req),flowId:body.flowId,sessionId:body.sessionId,actorId:requireAuth(req).userId},artifactDir);
  });
 });
 app.post('/api/v2/campaigns/:id/record',async req=>{
  const {c}=await campaign(req),body=z.object({sessionId:z.string(),humanInterventionMinutes:z.number().min(0).nullable()}).strict().parse(req.body);
  const entries=await prisma.auditEvent.findMany({where:{entityType:'V2EvaluationCampaign',entityId:id(req),action:'v2.campaign.enroll'},orderBy:[{createdAt:'asc'},{id:'asc'}]});
  const entry=entries.find(e=>(e.metadata as {sessionId:string}).sessionId===body.sessionId);if(!entry)throw new ApiError('CONFLICT','运行未在执行前登记');
  const flow=c.flows.find(f=>f.id===(entry.metadata as {flowId:string}).flowId)!;
  const session=await prisma.v2ExecutionSession.findFirst({where:{id:body.sessionId,projectId:c.projectId,status:{in:['COMPLETED','FAILED','CANCELLED']}}});if(!session)throw new ApiError('CONFLICT','运行尚未结束');
  const result=session.result as {verdict?:string;checks?:Array<{assertionId:string;verdict:string}>;buildVerification?:{verified:boolean}}|null;
  const observations=await prisma.v2Observation.findMany({where:{sessionId:session.id}});const evidenceIds=observations.flatMap(o=>o.evidenceArtifactIds);
  let evidenceValid=true;try{await requireV2Evidence(prisma,c.projectId,evidenceIds,artifactDir);}catch{evidenceValid=false;}
  const check=result?.checks?.find(x=>x.assertionId===flow.assertionId);
  const scored=evidenceValid&&result?.buildVerification?.verified===true;
  const verdict=!scored?'unknown':result?.verdict==='blocked'?'blocked':result?.verdict==='pass'&&check?.verdict==='pass'?(flow.expected==='pass'?'pass_correct':'false_negative'):result?.verdict==='fail'?(flow.expected==='fail'&&check?.verdict==='fail'?'fail_correct':flow.expected==='pass'?'false_positive':'false_negative'):'unknown';
  return prisma.$transaction(async tx=>{
   await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${c.projectId} FOR UPDATE`;
   const old=await tx.v2EvaluationTrial.findFirst({where:{campaignId:id(req),sessionId:session.id}});if(old){if(old.humanInterventionMinutes!==body.humanInterventionMinutes)throw new ApiError('CONFLICT','已记录试验不可改写人工时间');return old;}
   const trial=await tx.v2EvaluationTrial.create({data:{campaignId:id(req),projectId:c.projectId,flowId:flow.id,sessionId:session.id,firstResult:verdict,finalResult:verdict,humanInterventionMinutes:body.humanInterventionMinutes,costMicros:null,latencyMs:session.startedAt?Math.max(0,+session.updatedAt-+session.startedAt):0}});
   await tx.auditEvent.create({data:{actorId:requireAuth(req).userId,entityType:'V2EvaluationCampaign',entityId:id(req),action:'v2.campaign.record',metadata:{trialId:trial.id,sessionId:session.id,evidenceIds,evidenceValid,humanTimeSource:'operator_declared',costSource:'unknown'}}});return trial;
  });
 });
 app.get('/api/v2/campaigns/:id',async req=>{
  const {c}=await campaign(req);const entries=await prisma.auditEvent.findMany({where:{entityType:'V2EvaluationCampaign',entityId:id(req),action:'v2.campaign.enroll'},orderBy:[{createdAt:'asc'},{id:'asc'}]});
  entries.sort((a,b)=>((a.metadata as {sequence:number}).sequence??0)-((b.metadata as {sequence:number}).sequence??0));
  const trials=await prisma.v2EvaluationTrial.findMany({where:{campaignId:id(req)},orderBy:{ranAt:'asc'}});
  const invalidSessions=new Set<string>();
  for(const trial of trials){const observations=trial.sessionId?await prisma.v2Observation.findMany({where:{sessionId:trial.sessionId}}):[];try{await requireV2Evidence(prisma,c.projectId,observations.flatMap(o=>o.evidenceArtifactIds),artifactDir);}catch{if(trial.sessionId)invalidSessions.add(trial.sessionId);}}
  let truthValid=true;try{await requireV2Evidence(prisma,c.projectId,[...c.authorizationEvidenceIds,...c.flows.flatMap(f=>f.sourceEvidenceIds)],artifactDir);}catch{truthValid=false;}
  const first=c.flows.map(f=>{const enrollment=entries.find(e=>(e.metadata as {flowId:string}).flowId===f.id),sessionId=(enrollment?.metadata as {sessionId?:string}|undefined)?.sessionId;const trial=trials.find(t=>t.sessionId===sessionId);return {flowId:f.id,result:!truthValid||sessionId&&invalidSessions.has(sessionId)?'unknown':trial?.firstResult??'unknown',sessionId:sessionId??null,attempts:trials.filter(t=>t.flowId===f.id).length,humanInterventionMinutes:trial?.humanInterventionMinutes??null,costMicros:trial?.costMicros??null};});
  const correct=first.filter(x=>['pass_correct','fail_correct'].includes(x.result)).length;
  const defects=[...new Set(c.flows.map(f=>f.defectId).filter(Boolean))],hit=defects.filter(d=>c.flows.some(f=>f.defectId===d&&first.find(x=>x.flowId===f.id)?.result==='fail_correct')).length;
  const healthy=c.flows.filter(f=>f.expected==='pass'),fp=healthy.filter(f=>first.find(x=>x.flowId===f.id)?.result==='false_positive').length;
  return {campaignId:id(req),projectId:c.projectId,flows:c.flows,name:c.name,hash:c.hash,sampleKind:c.sampleKind,truthEvidenceValid:truthValid,firstAttempts:first,allTrials:trials,metrics:{completion:proportion(correct,c.flows.length),knownDefectRecall:proportion(hit,defects.length),healthyFalsePositive:proportion(fp,healthy.length),unknownCostTrials:trials.filter(t=>t.costMicros===null).length},releaseEligible:false,releaseBlockers:['单项目批次不能满足三项目总体验收','候选精确率仍需独立人工归并确认','两周试点与跨项目留出集需另行提供证据'],notes:['未运行、阻塞、错误、缺证据保留在分母','以预登记第一次为主结果；补跑不得替换','真实性标签由管理员凭授权与来源证据声明，系统不把合成样例升级为真实试点']};
 });
}
