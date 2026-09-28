import {executeGraph} from '@ai-qa/adapter-sdk/graph-kernel';
import {enrollEvaluationSession} from './routes-v2-campaigns.js';
import {BrowserAgentTask} from '@ai-qa/contracts';
import {BrowserAgentManifest,BrowserReadManifest} from '@ai-qa/adapter-sdk/samples/browser-agent';
import type {FastifyInstance, FastifyRequest} from 'fastify';
import type {PrismaClient} from '@prisma/client';
import type {Queue} from 'bullmq';
import {z} from 'zod';
import {createHash} from 'node:crypto';
import {EnvironmentRuntime, HarnessProfileContent, WorkflowDefinitionContent, CapabilityManifest, SessionBudget, computeProfileHash, computeAstHash, computeManifestHash, canonicalStringify, validateGraph} from '@ai-qa/contracts';
import {requireAuth, requireProjectAccess} from './auth.js';
import {ApiError} from './errors.js';

const hash=(v:unknown)=>createHash('sha256').update(canonicalStringify(v)).digest('hex');
export function registerV2ProfileRoutes(app:FastifyInstance, prisma:PrismaClient, queue:Pick<Queue,'add'>,artifactDir?:string){
  const param=(req:FastifyRequest,k='id')=>(req.params as Record<string,string>)[k]!;

  function supported(content:HarnessProfileContent){
    if(content.verifierPolicy!=="oracle-graph-v1"||!["none","approved-memory-v1"].includes(content.memoryPolicy)||content.modelRoutes.generator!=="disabled"||!["disabled","browser-vision-v1"].includes(content.modelRoutes.vision)||!["deterministic-v1","browser-model-v1"].includes(content.modelRoutes.decision))throw new ApiError('VALIDATION_ERROR','配置包含未接入的规划、视觉、判定或记忆策略');
    if(content.modelRoutes.decision==='deterministic-v1'&&(content.memoryPolicy!=='none'||content.modelRoutes.vision!=='disabled'))throw new ApiError('VALIDATION_ERROR','视觉和项目经验只在模型规划中消费，确定性配置不能声明启用');
  }
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

  app.get('/api/v2/projects/:id/browser-presets',async req=>{
    await requireProjectAccess(prisma,req,param(req),'VIEWER');
    return {manifests:[BrowserAgentManifest,BrowserReadManifest],strategies:[{id:'semantic-v1',name:'唯一元素匹配 · 不调用模型'},{id:'model-v1',name:'模型规划 · 需要明确调用预算'}],memoryPolicies:['none','approved-memory-v1'],verifierPolicies:['oracle-graph-v1']};
  });
  app.post('/api/v2/projects/:id/browser-blueprints',async(req,reply)=>{
    const projectId=param(req);await requireProjectAccess(prisma,req,projectId,'LEAD');
    const body=z.object({name:z.string().min(1).max(200),task:BrowserAgentTask,checks:z.array(z.object({nodeId:z.string().regex(/^[a-z][a-z0-9_-]{0,60}$/),role:z.string(),target:z.string().min(1).max(200),locatorKind:z.enum(['testId','label','text','role']).default('testId'),elementRole:z.enum(['heading','status','alert','textbox','button','link','cell','row']).default('status')}).strict()).min(1).max(30),memoryPolicy:z.enum(['none','approved-memory-v1']).default('none')}).strict().parse(req.body);
    if(body.checks.some(c=>!body.task.roles.some(r=>r.id===c.role))||new Set(body.checks.map(x=>x.nodeId)).size!==body.checks.length||body.checks.some(c=>c.nodeId==='agent'))throw new ApiError('VALIDATION_ERROR','复核节点标识或角色无效');
    const installations=[];for(const manifest of [BrowserAgentManifest,BrowserReadManifest]){
      const row=await prisma.v2AdapterInstallation.findFirst({where:{projectId,capabilityId:manifest.id,capabilityVersion:manifest.version,status:'AUTHORIZED'},orderBy:{installedAt:'desc'}});if(!row)throw new ApiError('CONFLICT','请管理员先启用并授权网站测试能力');installations.push({capabilityId:manifest.id,version:manifest.version,installationId:row.id});
    }
    const content=WorkflowDefinitionContent.parse({name:body.name,description:body.task.goal,maxSubflowDepth:4,nodes:[{nodeId:'agent',capabilityId:BrowserAgentManifest.id,capabilityVersion:BrowserAgentManifest.version,dependsOn:[],onFailure:'fail',bindings:{taskJson:{source:'constant',type:'string',value:JSON.stringify(body.task)}}},...body.checks.map(c=>({nodeId:c.nodeId,capabilityId:BrowserReadManifest.id,capabilityVersion:BrowserReadManifest.version,dependsOn:['agent'],onFailure:'fail',bindings:{locatorKind:{source:'constant',type:'string',value:c.locatorKind},elementRole:{source:'constant',type:'string',value:c.elementRole},browserRef:{source:'node',nodeId:'agent',path:'browserRef',type:'string'},role:{source:'constant',type:'string',value:c.role},target:{source:'constant',type:'string',value:c.target}}}))]});
    if(body.task.strategy==='semantic-v1'&&body.memoryPolicy!=='none')throw new ApiError('VALIDATION_ERROR','确定性规划不消费项目经验');
    const profile=HarnessProfileContent.parse({capabilities:installations,modelRoutes:{generator:'disabled',vision:body.task.strategy==='model-v1'&&body.task.operations.some(o=>o.visual)?'browser-vision-v1':'disabled',decision:body.task.strategy==='model-v1'?'browser-model-v1':'deterministic-v1'},memoryPolicy:body.memoryPolicy,verifierPolicy:'oracle-graph-v1'});
    await pins(projectId,profile);
    const definitionHash=computeAstHash(content),profileHash=computeProfileHash(profile);
    const saved=await prisma.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${projectId} FOR UPDATE`;
      const old=await tx.v2WorkflowDefinition.findFirst({where:{projectId,name:body.name,astHash:definitionHash,status:'PUBLISHED'}});
      const definition=old??await tx.v2WorkflowDefinition.create({data:{projectId,name:body.name,version:(await tx.v2WorkflowDefinition.count({where:{projectId,name:body.name}}))+1,status:'PUBLISHED',content:content as never,astHash:definitionHash,createdBy:requireAuth(req).userId,publishedAt:new Date()}});
      const prior=await tx.v2HarnessProfile.findFirst({where:{projectId,key:'browser',contentHash:profileHash,status:'PUBLISHED'}});
      const configuration=prior??await tx.v2HarnessProfile.create({data:{projectId,key:'browser',version:(await tx.v2HarnessProfile.count({where:{projectId,key:'browser'}}))+1,content:profile as never,contentHash:profileHash,status:'PUBLISHED',createdBy:requireAuth(req).userId,publishedAt:new Date()}});
      await tx.auditEvent.create({data:{actorId:requireAuth(req).userId,action:'v2.browser.blueprint',entityType:'V2WorkflowDefinition',entityId:definition.id,metadata:{astHash:definitionHash,profileId:configuration.id,roles:body.task.roles.map(r=>r.id),operations:body.task.operations.length}}});
      return {definitionId:definition.id,profileId:configuration.id};
    });return reply.code(201).send(saved);
  });
  app.get('/api/v2/projects/:id/profiles',async req=>{
    const projectId=param(req); await requireProjectAccess(prisma,req,projectId,'VIEWER');
    return {profiles:await prisma.v2HarnessProfile.findMany({where:{projectId},orderBy:[{key:'asc'},{version:'desc'}],take:100})};
  });
  app.post('/api/v2/projects/:id/profiles',async(req,reply)=>{
    const projectId=param(req); await requireProjectAccess(prisma,req,projectId,'LEAD');
    const body=z.object({key:z.string().regex(/^[a-z][a-z0-9-]*$/),content:HarnessProfileContent}).strict().parse(req.body);
    supported(body.content);
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
    const content=HarnessProfileContent.parse(row.content);supported(content);
    if(computeProfileHash(content)!==row.contentHash)throw new ApiError('CONFLICT','组合配置哈希不符');
    await pins(row.projectId,content);
    if(row.status==='PUBLISHED')return row;
    const changed=await prisma.v2HarnessProfile.updateMany({where:{id:row.id,status:'DRAFT',contentHash:row.contentHash},data:{status:'PUBLISHED',publishedAt:new Date()}});
    if(!changed.count)throw new ApiError('CONFLICT','当前状态不可发布');
    await prisma.auditEvent.create({data:{actorId:requireAuth(req).userId,action:'v2.profile.publish',entityType:'V2HarnessProfile',entityId:row.id,metadata:{contentHash:row.contentHash}}});
    return prisma.v2HarnessProfile.findUniqueOrThrow({where:{id:row.id}});
  });
  for(const mode of ['execute','preflight'] as const)app.post(mode==='execute'?'/api/v2/projects/:id/graph-sessions':'/api/v2/projects/:id/graph-preflight',async(req,reply)=>{
    const projectId=param(req); await requireProjectAccess(prisma,req,projectId,'LEAD');
    const body=z.object({evaluation:z.object({campaignId:z.string(),flowId:z.string()}).strict().optional(),goal:z.string().min(1).max(4000),definitionId:z.string(),profileId:z.string(),oracleSpecId:z.string(),environmentId:z.string(),buildId:z.string().min(1).max(200),taskInput:z.record(z.unknown()),assertionBindings:z.record(z.object({nodeId:z.string(),path:z.string().regex(/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/)}).strict()),budget:SessionBudget,idempotencyKey:z.string().min(8).max(200)}).strict().parse(req.body);
    if(body.evaluation)await requireProjectAccess(prisma,req,projectId,'ADMIN');
    // This host dispatches deterministic capabilities. Model roles require their own metered host.
    // Browser model routing is explicitly selected by the frozen profile; no automatic paid fallback.
    const [definition,profile,oracle,environment]=await Promise.all([
      prisma.v2WorkflowDefinition.findFirst({where:{id:body.definitionId,projectId,status:'PUBLISHED'}}),
      prisma.v2HarnessProfile.findFirst({where:{id:body.profileId,projectId,status:'PUBLISHED'}}),
      prisma.v2OracleSpec.findFirst({where:{id:body.oracleSpecId,projectId,status:'APPROVED'}}),
      prisma.environment.findFirst({where:{id:body.environmentId,projectId,isProduction:false}}),
    ]);
    if(!definition||!profile||!oracle||!environment)throw new ApiError('VALIDATION_ERROR','需要本项目已发布组合、配置、批准标准和测试环境');
    const content=WorkflowDefinitionContent.parse(definition.content), pc=HarnessProfileContent.parse(profile.content);
    supported(pc);
    if(computeAstHash(content)!==definition.astHash||computeProfileHash(pc)!==profile.contentHash)throw new ApiError('CONFLICT','已发布内容哈希不符');
    if(pc.modelRoutes.decision==='deterministic-v1'&&(body.budget.maxModelCalls||body.budget.maxTokens))throw new ApiError('VALIDATION_ERROR','确定性配置不消费模型预算');
    if(pc.modelRoutes.decision==='browser-model-v1'&&(!body.budget.maxModelCalls||!body.budget.maxTokens||body.budget.maxCostMicros!==null))throw new ApiError('VALIDATION_ERROR','模型配置需要调用和 token 预算；未配置可信价格不能使用金额预算');
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
    const browserPreparations=Object.fromEntries((await prisma.loginPreparation.findMany({where:{projectId,environmentId:environment.id}})).filter(p=>p.configuration).map(p=>[p.role,{id:p.id,configHash:p.configHash,configuration:p.configuration}]));
    const snapshot={browserPreparations,environmentRevision:environment.revision,buildProbe:EnvironmentRuntime.parse(environment.runtime??{}).buildProbe??null,definition:content,subflows,installations,allowedOrigins:environment.allowedOrigins,taskInput:body.taskInput,assertionBindings:body.assertionBindings};
    if(mode==='preflight'){
      const graph=await executeGraph({projectId,definition:content,subflows,taskInput:body.taskInput,deadline:Date.now()+10000,signal:AbortSignal.timeout(10000),allowedOrigins:[],executionKey:'preflight',mode:'dry-run',invoke:async()=>{throw new Error('Preflight must never dispatch a capability');}});
      return {mode:'dry-run',externalCalls:0,createsSession:false,definitionHash:definition.astHash,profileHash:profile.contentHash,graph,notes:['仅演练图结构、参数和条件，不访问目标或模型','依赖真实工具输出的字段和条件可能无法解析；不能据此判定业务通过','实际运行仍会重新核验授权、构建与预算']};
    }
    const requestHash=hash(body),fingerprint=hash({projectId,key:body.idempotencyKey,kind:'V2_GRAPH_SESSION'});
    const saved=await prisma.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${projectId} FOR UPDATE`;
      const old=await tx.job.findUnique({where:{projectId_kind_fingerprint:{projectId,kind:'V2_GRAPH_SESSION',fingerprint}}});
      if(old){const r=old.request as {requestHash:string;sessionId:string};if(r.requestHash!==requestHash)throw new ApiError('CONFLICT','幂等键内容不同');return {sessionId:r.sessionId,jobId:old.id,existed:true};}
      const session=await tx.v2ExecutionSession.create({data:{projectId,goal:body.goal,oracleSpecId:oracle.id,oracleHash:oracle.oracleHash,profileId:profile.id,profileHash:profile.contentHash,definitionId:definition.id,definitionVersion:definition.version,environmentId:environment.id,targetBaseUrl:environment.baseUrl,buildId:body.buildId,budget:body.budget,checkpoint:{kind:'graph',snapshotHash:hash(snapshot)}}});
      if(body.evaluation)await enrollEvaluationSession(tx,{...body.evaluation,sessionId:session.id,projectId,actorId:requireAuth(req).userId},artifactDir);
      const job=await tx.job.create({data:{projectId,kind:'V2_GRAPH_SESSION',fingerprint,request:{requestHash,sessionId:session.id,snapshot} as never}});
      await tx.v2SessionEvent.create({data:{sessionId:session.id,type:'state',payload:{status:'QUEUED',definitionHash:definition.astHash,profileHash:profile.contentHash}}});
      await tx.auditEvent.create({data:{actorId:requireAuth(req).userId,action:'v2.graph-session.create',entityType:'V2ExecutionSession',entityId:session.id}});
      return {sessionId:session.id,jobId:job.id,existed:false};
    });
    if(!saved.existed)try{await queue.add('run',{jobId:saved.jobId},{removeOnComplete:true,removeOnFail:200});}catch{/* durable outbox */}
    return reply.code(saved.existed?200:202).send(saved);
  });
}
