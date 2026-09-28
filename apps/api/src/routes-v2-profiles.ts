import type {FastifyInstance, FastifyRequest} from 'fastify';
import type {PrismaClient} from '@prisma/client';
import type {Queue} from 'bullmq';
import {z} from 'zod';
import {createHash} from 'node:crypto';
import {EnvironmentRuntime, HarnessProfileContent, WorkflowDefinitionContent, CapabilityManifest, SessionBudget, computeProfileHash, computeAstHash, computeManifestHash, canonicalStringify, validateGraph} from '@ai-qa/contracts';
import {requireAuth, requireProjectAccess} from './auth.js';
import {ApiError} from './errors.js';

const hash=(v:unknown)=>createHash('sha256').update(canonicalStringify(v)).digest('hex');
export function registerV2ProfileRoutes(app:FastifyInstance, prisma:PrismaClient, queue:Pick<Queue,'add'>){
  const param=(req:FastifyRequest,k='id')=>(req.params as Record<string,string>)[k]!;
  async function pins(projectId:string,content:HarnessProfileContent){
    const result:Record<string,{installationId:string;actionScope:string[];manifestHash:string}>= {};
    for(const cap of content.capabilities){
      const key=`${cap.capabilityId}@${cap.version}`;
      if(result[key] || !cap.installationId) throw new ApiError('VALIDATION_ERROR','能力必须固定唯一安装 ID');
      const row=await prisma.v2AdapterInstallation.findFirst({where:{id:cap.installationId,projectId,capabilityId:cap.capabilityId,capabilityVersion:cap.version,status:'AUTHORIZED'}});
      const manifest=await prisma.v2CapabilityManifest.findUnique({where:{capabilityId_version:{capabilityId:cap.capabilityId,version:cap.version}}});
      const scope=(row?.authorization as {scope?:string[]}|null)?.scope;
      if(!row || !manifest || !scope?.length || row.manifestHash!==manifest.manifestHash || computeManifestHash(CapabilityManifest.parse(manifest.manifest))!==manifest.manifestHash) throw new ApiError('VALIDATION_ERROR','能力未授权或清单哈希不符');
      result[key]={installationId:row.id,actionScope:scope,manifestHash:manifest.manifestHash};
    }
    return result;
  }
  app.get('/api/v2/projects/:id/profiles',async req=>{
    const projectId=param(req); await requireProjectAccess(prisma,req,projectId,'VIEWER');
    return {profiles:await prisma.v2HarnessProfile.findMany({where:{projectId},orderBy:[{key:'asc'},{version:'desc'}],take:100})};
  });
  app.post('/api/v2/projects/:id/profiles',async(req,reply)=>{
    const projectId=param(req); await requireProjectAccess(prisma,req,projectId,'LEAD');
    const body=z.object({key:z.string().regex(/^[a-z][a-z0-9-]*$/),content:HarnessProfileContent}).strict().parse(req.body);
    if(body.content.verifierPolicy!=="oracle-graph-v1"||body.content.memoryPolicy!=="none"||body.content.modelRoutes.generator!=="disabled"||body.content.modelRoutes.vision!=="disabled"||body.content.modelRoutes.decision!=="deterministic-v1")throw new ApiError("VALIDATION_ERROR","此配置入口只支持 oracle-graph-v1、确定性工具图；未接入策略不能作为有效配置发布");
    await pins(projectId,body.content);
    const contentHash=computeProfileHash(body.content);
    const row=await prisma.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${projectId} FOR UPDATE`;
      const old=await tx.v2HarnessProfile.findFirst({where:{projectId,key:body.key,contentHash,status:{in:['DRAFT','PUBLISHED']}}});
      if(old)return old;
      const last=await tx.v2HarnessProfile.findFirst({where:{projectId,key:body.key},orderBy:{version:'desc'}});
      return tx.v2HarnessProfile.create({data:{projectId,key:body.key,version:(last?.version??0)+1,content:body.content as never,contentHash,createdBy:requireAuth(req).userId}});
    }); return reply.code(201).send(row);
  });
  app.post('/api/v2/profiles/:id/publish',async req=>{
    const row=await prisma.v2HarnessProfile.findUnique({where:{id:param(req)}});
    if(!row)throw new ApiError('NOT_FOUND','组合配置不存在');
    await requireProjectAccess(prisma,req,row.projectId,'LEAD');
    const content=HarnessProfileContent.parse(row.content);
    if(computeProfileHash(content)!==row.contentHash)throw new ApiError('CONFLICT','组合配置哈希不符');
    await pins(row.projectId,content);
    if(row.status==='PUBLISHED')return row;
    const changed=await prisma.v2HarnessProfile.updateMany({where:{id:row.id,status:'DRAFT',contentHash:row.contentHash},data:{status:'PUBLISHED',publishedAt:new Date()}});
    if(!changed.count)throw new ApiError('CONFLICT','当前状态不可发布');
    await prisma.auditEvent.create({data:{actorId:requireAuth(req).userId,action:'v2.profile.publish',entityType:'V2HarnessProfile',entityId:row.id,metadata:{contentHash:row.contentHash}}});
    return prisma.v2HarnessProfile.findUniqueOrThrow({where:{id:row.id}});
  });
  app.post('/api/v2/projects/:id/graph-sessions',async(req,reply)=>{
    const projectId=param(req); await requireProjectAccess(prisma,req,projectId,'LEAD');
    const body=z.object({goal:z.string().min(1).max(4000),definitionId:z.string(),profileId:z.string(),oracleSpecId:z.string(),environmentId:z.string(),buildId:z.string().min(1).max(200),taskInput:z.record(z.unknown()),assertionBindings:z.record(z.object({nodeId:z.string(),path:z.string().regex(/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/)}).strict()),budget:SessionBudget,idempotencyKey:z.string().min(8).max(200)}).strict().parse(req.body);
    // This host dispatches deterministic capabilities. Model roles require their own metered host.
    if(body.budget.maxModelCalls || body.budget.maxTokens)throw new ApiError('VALIDATION_ERROR','组合图工具运行暂不消费模型预算');
    const [definition,profile,oracle,environment]=await Promise.all([
      prisma.v2WorkflowDefinition.findFirst({where:{id:body.definitionId,projectId,status:'PUBLISHED'}}),
      prisma.v2HarnessProfile.findFirst({where:{id:body.profileId,projectId,status:'PUBLISHED'}}),
      prisma.v2OracleSpec.findFirst({where:{id:body.oracleSpecId,projectId,status:'APPROVED'}}),
      prisma.environment.findFirst({where:{id:body.environmentId,projectId,isProduction:false}}),
    ]);
    if(!definition||!profile||!oracle||!environment)throw new ApiError('VALIDATION_ERROR','需要本项目已发布组合、配置、批准标准和测试环境');
    const content=WorkflowDefinitionContent.parse(definition.content), pc=HarnessProfileContent.parse(profile.content);
    if(computeAstHash(content)!==definition.astHash||computeProfileHash(pc)!==profile.contentHash)throw new ApiError('CONFLICT','已发布内容哈希不符');
    const installations=await pins(projectId,pc);
    // Freeze the entire subflow closure; workers never resolve newer versions after queuing.
    const subflows:Record<string,WorkflowDefinitionContent>={};
    async function walk(graph:WorkflowDefinitionContent,ancestors:string[],depth:number):Promise<void>{
      if(depth>content.maxSubflowDepth||depth>8)throw new ApiError('VALIDATION_ERROR','子流程深度超限');
      if(!validateGraph(graph).ok)throw new ApiError('VALIDATION_ERROR','图校验失败');
      for(const node of graph.nodes){
        if(!node.subflow){if(!installations[`${node.capabilityId}@${node.capabilityVersion}`])throw new ApiError('VALIDATION_ERROR',`配置未授权能力 ${node.capabilityId}`);continue;}
        const key=`${node.subflow.definitionId}@${node.subflow.version}`;
        if(ancestors.includes(key))throw new ApiError('VALIDATION_ERROR','子流程循环');
        const row=await prisma.v2WorkflowDefinition.findFirst({where:{id:node.subflow.definitionId,version:node.subflow.version,projectId,status:'PUBLISHED'}});
        if(!row)throw new ApiError('VALIDATION_ERROR','子流程未发布或跨项目');
        const nested=WorkflowDefinitionContent.parse(row.content);
        if(computeAstHash(nested)!==row.astHash)throw new ApiError('CONFLICT','子流程哈希不符');
        subflows[key]=nested;await walk(nested,[...ancestors,key],depth+1);
      }
    }
    await walk(content,[`${definition.id}@${definition.version}`],0);
    const snapshot={buildProbe:EnvironmentRuntime.parse(environment.runtime??{}).buildProbe??null,definition:content,subflows,installations,allowedOrigins:environment.allowedOrigins,taskInput:body.taskInput,assertionBindings:body.assertionBindings};
    const requestHash=hash(body),fingerprint=hash({projectId,key:body.idempotencyKey,kind:'V2_GRAPH_SESSION'});
    const saved=await prisma.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${projectId} FOR UPDATE`;
      const old=await tx.job.findUnique({where:{projectId_kind_fingerprint:{projectId,kind:'V2_GRAPH_SESSION',fingerprint}}});
      if(old){const r=old.request as {requestHash:string;sessionId:string};if(r.requestHash!==requestHash)throw new ApiError('CONFLICT','幂等键内容不同');return {sessionId:r.sessionId,jobId:old.id,existed:true};}
      const session=await tx.v2ExecutionSession.create({data:{projectId,goal:body.goal,oracleSpecId:oracle.id,oracleHash:oracle.oracleHash,profileId:profile.id,profileHash:profile.contentHash,definitionId:definition.id,definitionVersion:definition.version,environmentId:environment.id,targetBaseUrl:environment.baseUrl,buildId:body.buildId,budget:body.budget,checkpoint:{kind:'graph',snapshotHash:hash(snapshot)}}});
      const job=await tx.job.create({data:{projectId,kind:'V2_GRAPH_SESSION',fingerprint,request:{requestHash,sessionId:session.id,snapshot} as never}});
      await tx.v2SessionEvent.create({data:{sessionId:session.id,type:'state',payload:{status:'QUEUED',definitionHash:definition.astHash,profileHash:profile.contentHash}}});
      await tx.auditEvent.create({data:{actorId:requireAuth(req).userId,action:'v2.graph-session.create',entityType:'V2ExecutionSession',entityId:session.id}});
      return {sessionId:session.id,jobId:job.id,existed:false};
    });
    if(!saved.existed)try{await queue.add('run',{jobId:saved.jobId},{removeOnComplete:true,removeOnFail:200});}catch{/* durable outbox */}
    return reply.code(saved.existed?200:202).send(saved);
  });
}
