import {selectSessionMemories} from './session-memory.js';
import {investigateEvidence} from '../../../api/src/v2-investigate.js';
import {BrowserHarness} from '@ai-qa/adapter-sdk/browser-harness';
import {BrowserAgentResponse} from '@ai-qa/contracts';
import {prepareBrowserRole} from './browser-preparation.js';
import {readFileSync,realpathSync,statSync} from 'node:fs';
import {sep} from 'node:path';
import {inspectBuild,type FrozenBuildProbe} from './build-probe.js';
import {randomUUID,createHash} from 'node:crypto';
import type {PrismaClient,Prisma} from '@prisma/client';
import {ArtifactStore} from '@ai-qa/artifact-store';
import {CapabilityManifest,OracleSpec,SessionBudget,HarnessProfileContent,computeProfileHash,computeManifestHash,computeOracleHash,canonicalStringify,type WorkflowDefinitionContent} from '@ai-qa/contracts';
import type {CapabilityResult} from '@ai-qa/adapter-sdk';
import {executeGraph,type GraphExecutionResult} from './graph-executor.js';
import {invokeCapability,type InvokeInput} from './capability-invoker.js';
import {verifyGraphAssertions} from './graph-verifier.js';

export interface GraphSnapshot {
  browserPreparations?:Record<string,{id:string;configHash:string;configuration:unknown}>;environmentRevision?:number;
  buildProbe?:FrozenBuildProbe|null; allowedOrigins:string[]; definition:WorkflowDefinitionContent; subflows:Record<string,WorkflowDefinitionContent>;
  installations:Record<string,{installationId:string;actionScope:string[];manifestHash:string}>;
  taskInput:Record<string,unknown>; assertionBindings:Record<string,{nodeId:string;path:string}>;
}
const digest=(v:unknown)=>createHash('sha256').update(canonicalStringify(v)).digest('hex');
const fault=(code:string,message:string)=>Object.assign(new Error(message),{code});
const LEASE_MS=10000;
/** A frozen graph host. Every physical attempt is durable; recovery never blindly repeats writes. */
export async function runGraphSession(args:{prisma:PrismaClient;sessionId:string;snapshot:GraphSnapshot;artifactDir:string;signal?:AbortSignal;intelligence?:{url:string;token:string}}){
  const {prisma,sessionId,snapshot}=args;
  let session=await prisma.v2ExecutionSession.findUniqueOrThrow({where:{id:sessionId}});
  if(['COMPLETED','FAILED','CANCELLED','PAUSED','WAITING_HUMAN'].includes(session.status))return session.result??{status:session.status};
  const budget=SessionBudget.parse(session.budget);
  const token=randomUUID(),now=new Date();
  const claimed=await prisma.v2ExecutionSession.updateMany({where:{id:sessionId,status:{in:['QUEUED','RUNNING','PREPARING']},OR:[{leaseToken:null},{leaseExpiresAt:{lte:now}}]},data:{status:'RUNNING',leaseToken:token,leaseExpiresAt:new Date(+now+LEASE_MS),startedAt:session.startedAt??now}});
  if(!claimed.count)throw fault('LEASE_BUSY','已有执行者');
  session=await prisma.v2ExecutionSession.findUniqueOrThrow({where:{id:sessionId}});
  const cp=session.checkpoint as {snapshotHash:string;activeMs?:number;toolCalls?:number;resources?:number;modelCalls?:number;tokens?:number;activeSince?:number};
  // Charge the previous uncheckpointed interval conservatively on recovery; budgets never reset.
  const activeBaseline=(cp.activeMs??0)+(cp.activeSince?Math.max(0,Date.now()-cp.activeSince):0);
  const started=Date.now(),deadline=Math.min(+session.startedAt!+budget.maxWallClockMs,started+budget.maxActiveMs-activeBaseline);
  const controller=new AbortController(),signal=AbortSignal.any([controller.signal,...(args.signal?[args.signal]:[])]);
  const own=()=>({id:sessionId,status:'RUNNING',leaseToken:token,leaseExpiresAt:{gt:new Date()}});
  const store=new ArtifactStore(args.artifactDir);
  const commit=<T>(fn:(tx:Prisma.TransactionClient)=>Promise<T>)=>prisma.$transaction(async tx=>{
    if(!(await tx.v2ExecutionSession.updateMany({where:own(),data:{updatedAt:new Date()}})).count)throw fault('LEASE_LOST','过期执行拒绝提交');
    return fn(tx);
  });
  const heartbeat=setInterval(()=>{void prisma.v2ExecutionSession.updateMany({where:own(),data:{leaseExpiresAt:new Date(Date.now()+LEASE_MS)}}).then(r=>{if(!r.count)controller.abort();}).catch(()=>controller.abort());},250);heartbeat.unref();
  const timer=setTimeout(()=>controller.abort(),Math.max(1,deadline-Date.now()));timer.unref();
  async function guard(){if(signal.aborted||Date.now()>=deadline)throw fault('BUDGET_EXCEEDED','执行停止或时间预算耗尽');if(!await prisma.v2ExecutionSession.findFirst({where:own()}))throw fault('LEASE_LOST','执行权已失效');}
  async function saveUsage(tx:Prisma.TransactionClient){
    const elapsed=activeBaseline+Date.now()-started;
    await tx.v2ExecutionSession.update({where:{id:sessionId},data:{checkpoint:{...cp,activeMs:elapsed,activeSince:Date.now()},usage:{wallClockMsUsed:Date.now()-+session.startedAt!,activeMsUsed:elapsed,toolCallsUsed:cp.toolCalls??0,resourcesCreated:cp.resources??0,modelCallsUsed:cp.modelCalls??0,tokensUsed:cp.tokens??0}}});
  }
  async function put(value:unknown,label:string,tx:Prisma.TransactionClient){
    const stored=store.put({runId:sessionId,attemptId:'graph',filename:`${label}-${randomUUID()}.json`,data:Buffer.from(canonicalStringify(value))});
    return tx.artifact.create({data:{projectId:session.projectId,storageKey:stored.storageKey,checksum:stored.checksum,type:'OBSERVATION',sensitivity:'RESTRICTED_RAW'}});
  }
  async function read(id:string){const row=await prisma.artifact.findFirst({where:{id,projectId:session.projectId}});if(!row||!row.storageKey.startsWith(`${sessionId}/`)||!store.verify(row.storageKey,row.checksum))throw fault('EVIDENCE_INVALID','恢复证据缺失或被篡改');return JSON.parse(store.read(row.storageKey).toString());}
  const manifests=new Map<string,CapabilityManifest>();
  const browsers=new Map<string,BrowserHarness>();let profileContent:HarnessProfileContent;
  let ordinal=0;
  const buildEvidence:string[]=[];let buildVerified=false;
  async function checkBuild(){
    if(!snapshot.buildProbe)return;
    await guard();
    const environment=await prisma.environment.findFirst({where:{id:session.environmentId,projectId:session.projectId,isProduction:false}});
    if(!environment||environment.baseUrl!==session.targetBaseUrl)throw fault('BUILD_DRIFT','环境入口已变化');
    const record=await inspectBuild({baseUrl:session.targetBaseUrl!,probe:snapshot.buildProbe,expected:session.buildId!,allowedOrigins:environment.allowedOrigins.filter(x=>snapshot.allowedOrigins.includes(x)),signal,deadline});
    await commit(async tx=>{const ref=await put(record,'build',tx);buildEvidence.push(ref.id);await tx.v2Observation.create({data:{sessionId,round:0,source:'build-probe',evidenceArtifactIds:[ref.id],summary:record as never}});});
    buildVerified=record.verified;
    if(!record.verified)throw fault('BUILD_DRIFT',record.reason);
  }
  async function invoke(request:InvokeInput):Promise<CapabilityResult>{
    await guard();
    await checkBuild();
    const manifest=manifests.get(`${request.capabilityId}@${request.capabilityVersion}`)!;
    const write=manifest.effectClass!=='READ';
    // One intent per physical retry; idempotencyKey remains stable across retries.
    const attemptKey=request.invocationId;
    let intent=await prisma.v2ActionIntent.findUnique({where:{sessionId_idempotencyKey:{sessionId,idempotencyKey:attemptKey}}});
    if(intent){
      if(intent.inputHash!==digest(request.input)||intent.capabilityId!==request.capabilityId||intent.capabilityVersion!==request.capabilityVersion)throw fault('CONFLICT','恢复输入漂移');
      if(!intent.inputArtifactId)throw fault('EVIDENCE_INVALID','原始调用输入缺失');
      if(digest(await read(intent.inputArtifactId))!==intent.inputHash)throw fault('EVIDENCE_INVALID','原始输入哈希不符');
      const last=await prisma.v2Invocation.findFirst({where:{intentId:intent.id},orderBy:{attemptNo:'desc'}});
      const receipt=last?.receipt as {artifactId?:string;evidenceIds?:string[]}|null;
      if(receipt?.artifactId){
        for(const id of receipt.evidenceIds??[]){const artifact=await prisma.artifact.findFirst({where:{id,projectId:session.projectId}});if(!artifact||!store.verify(artifact.storageKey,artifact.checksum))throw fault('EVIDENCE_INVALID','调用附带的截图证据缺失');}
        const result=await read(receipt.artifactId) as CapabilityResult;
        if(result.status!=='UNKNOWN'){if(request.capabilityId==='platform.browser-agent')throw fault('BROWSER_RECOVERY_REQUIRED','浏览器进程已丢失；已提交动作不重放，需要新建独立复核运行');return result;}
      }
      if(write){
        await commit(async tx=>{await tx.v2Invocation.updateMany({where:{intentId:intent!.id,status:'RUNNING'},data:{status:'UNKNOWN',error:{code:'WORKER_LOST',message:'调用结果不明，需要核对后建立新运行'}}});});
        return {status:'UNKNOWN',output:null,resourceKeys:[],retryable:false,error:{code:'RECOVERY_REQUIRED',message:'未确认写入禁止重放，请核对资源'}};
      }
    }
    ordinal++;
    const invocation=await commit(async tx=>{
      if((cp.toolCalls??0)>=budget.maxToolCalls)throw fault('BUDGET_EXCEEDED','工具预算耗尽');
      if(manifest.effectClass==='CREATE'&&(cp.resources??0)>=budget.maxResources)throw fault('BUDGET_EXCEEDED','资源预算耗尽');
      if(!intent){
        const inputRef=await put(request.input,'input',tx);
        const step=await tx.v2StepAttempt.create({data:{sessionId,round:await tx.v2StepAttempt.count({where:{sessionId}})+1,phase:'graph',status:'RUNNING',rationale:request.idempotencyKey,inputRefs:[inputRef.id]}});
        intent=await tx.v2ActionIntent.create({data:{sessionId,stepAttemptId:step.id,capabilityId:request.capabilityId,capabilityVersion:request.capabilityVersion,inputHash:digest(request.input),inputArtifactId:inputRef.id,idempotencyKey:attemptKey,fencingToken:token,deadline:new Date(request.deadline)}});
      }
      await tx.v2Invocation.updateMany({where:{intentId:intent.id,status:'RUNNING'},data:{status:write?'UNKNOWN':'FAILED',error:{code:'WORKER_LOST',message:'上次进程退出'}}});
      cp.toolCalls=(cp.toolCalls??0)+1;
      // Reserve creations before dispatch, including ambiguous writes.
      if(manifest.effectClass==='CREATE')cp.resources=(cp.resources??0)+1;
      await saveUsage(tx);
      const count=await tx.v2Invocation.count({where:{intentId:intent.id}});
      const row=await tx.v2Invocation.create({data:{intentId:intent.id,attemptNo:count+1,status:'RUNNING',startedAt:new Date()}});
      await tx.v2SessionEvent.create({data:{sessionId,type:'invocation',payload:{invocationId:row.id,capabilityId:request.capabilityId,status:'RUNNING'}}});return row;
    });
    let result:CapabilityResult;
    try{
      let browser:BrowserHarness|undefined;
      if(request.capabilityId==='platform.browser-agent'){
        if(browsers.has(request.idempotencyKey))throw fault('CONFLICT','重复浏览器实例');
        const browserRequest=request;
        const browserImages=new Map<string,{role:string;tab:number;imageStorageKey:string;checksum:string;size:number}>();
        browser=new BrowserHarness({artifactDir:args.artifactDir,allowedOrigins:(await prisma.environment.findFirstOrThrow({where:{id:session.environmentId!,projectId:session.projectId,isProduction:false}})).allowedOrigins.filter(origin=>snapshot.allowedOrigins.includes(origin)),deadline,signal,
          prepareRole:async(role,page)=>{
            const pin=snapshot.browserPreparations?.[role];if(!pin)throw fault('AUTH_REQUIRED','角色未配置登录');
            const env=await prisma.environment.findFirstOrThrow({where:{id:session.environmentId!,projectId:session.projectId,isProduction:false}});
            const config=await prisma.loginPreparation.findFirst({where:{id:pin.id,projectId:session.projectId,environmentId:env.id,role,configHash:pin.configHash}});
            if(!config||env.revision!==snapshot.environmentRevision||digest(config.configuration)!==digest(pin.configuration))throw fault('AUTH_CHANGED','角色配置发生变化');
            await prepareBrowserRole(page,pin.configuration,env.runtime,env.baseUrl,snapshot.allowedOrigins,deadline,async()=>{await guard();await checkBuild();await commit(async tx=>{if((cp.toolCalls??0)>=budget.maxToolCalls)throw fault('BUDGET_EXCEEDED','登录工具预算耗尽');cp.toolCalls=(cp.toolCalls??0)+1;const ref=await put({role,configurationHash:pin.configHash},'browser-auth-intent',tx);await tx.v2Observation.create({data:{sessionId,round:cp.toolCalls,source:'browser-auth-intent',evidenceArtifactIds:[ref.id],summary:{role}}});await saveUsage(tx);});});
          },
          event:async event=>{
            await guard();
            const currentEnvironment=await prisma.environment.findFirst({where:{id:session.environmentId!,projectId:session.projectId,isProduction:false}});
            if(!currentEnvironment||snapshot.allowedOrigins.some(origin=>!currentEnvironment.allowedOrigins.includes(origin)))throw fault('FORBIDDEN','浏览器环境权限已收窄');
            if(event.kind==='intent'){
              await checkBuild();
              const row=await prisma.v2AdapterInstallation.findFirst({where:{id:browserRequest!.installationId,status:'AUTHORIZED',projectId:session.projectId}});if(!row||browserRequest!.actionScope?.some(scope=>!((row.authorization as {scope?:string[]})?.scope??[]).includes(scope)))throw fault('FORBIDDEN','浏览器授权已撤销或范围已收窄');
            }
            await commit(async tx=>{
              if(['intent','observation'].includes(event.kind)){if((cp.toolCalls??0)>=budget.maxToolCalls)throw fault('BUDGET_EXCEEDED','浏览器工具预算耗尽');cp.toolCalls=(cp.toolCalls??0)+1;}
              if(event.kind==='intent'){if((cp.resources??0)>=budget.maxResources)throw fault('BUDGET_EXCEEDED','浏览器写入预算耗尽');cp.resources=(cp.resources??0)+1;}
              const evidence=await put(event.data,'browser-'+event.kind,tx);const ids=[evidence.id];
              if(event.screenshotPath){const bytes=readFileSync(event.screenshotPath);if(createHash('sha256').update(bytes).digest('hex')!==event.screenshotSha256)throw fault('EVIDENCE_INVALID','截图哈希不符');const shot=store.put({runId:sessionId,attemptId:'browser',filename:randomUUID()+'.png',data:bytes});const data=event.data as {role:string;tab:number};browserImages.set(data.role,{role:data.role,tab:data.tab,imageStorageKey:shot.storageKey,checksum:shot.checksum,size:bytes.length});ids.push((await tx.artifact.create({data:{projectId:session.projectId,storageKey:shot.storageKey,checksum:shot.checksum,type:'SCREENSHOT',sensitivity:'RESTRICTED_RAW'}})).id);}
              await tx.v2Observation.create({data:{sessionId,round:cp.toolCalls??0,source:'browser-'+event.kind,evidenceArtifactIds:ids,summary:{kind:event.kind}}});await saveUsage(tx);
            });
          },
          plan:async(input,strategy)=>{
            await guard();if(!args.intelligence)throw fault('CONFIG_MISSING','未配置 Python 规划服务');
            const memories=strategy==='model-v1'&&profileContent.memoryPolicy==='approved-memory-v1'?await selectSessionMemories(prisma,store,{projectId:session.projectId,environmentId:session.environmentId!,oracleHash:session.oracleHash},3):[];
            input={...input,images:[...browserImages.values()].map(({size,...image})=>image),hints:memories.filter(m=>m.decision==='used').map(m=>({memoryId:m.memoryRecordId,text:m.text!}))};
            const real=strategy==='model-v1';
            const vision=input.operations.some(x=>x.visual);
            if(vision&&real&&profileContent.modelRoutes.vision!=='browser-vision-v1')throw fault('FORBIDDEN','配置未授权视觉模型');
            const reserve=Buffer.byteLength(JSON.stringify(input))+16000+(vision?Math.ceil(Math.max(0,...[...browserImages.values()].map(x=>x.size))*4/3):0);
            if(real){
              if(profileContent.modelRoutes.decision!=='browser-model-v1'||budget.maxCostMicros!==null)throw fault('FORBIDDEN','配置未授权模型规划或金额预算无可信价格');
              await commit(async tx=>{if((cp.modelCalls??0)>=budget.maxModelCalls||(cp.tokens??0)+reserve>budget.maxTokens)throw fault('BUDGET_EXCEEDED','模型预算耗尽');cp.modelCalls=(cp.modelCalls??0)+1;cp.tokens=(cp.tokens??0)+reserve;await saveUsage(tx);});
            }
            const requestId=randomUUID(),timeoutMs=Math.max(1000,Math.min(60000,deadline-Date.now()));
            const ref=await commit(async tx=>{const artifact=await put(input,'browser-plan-input',tx);for(const memory of memories)await tx.v2MemoryUsage.create({data:{projectId:session.projectId,sessionId,memoryRecordId:memory.memoryRecordId,retrieved:true,decision:memory.decision,reason:memory.reason+'；请求证据 '+artifact.id,outcome:'unknown'}});return artifact;});
            const response=await fetch(new URL('/v2/browser/plan',args.intelligence.url),{method:'POST',headers:{authorization:'Bearer '+args.intelligence.token,'content-type':'application/json','x-aiqa-model-calls':real?'1':'0','x-aiqa-model-tokens':real?String(reserve):'0'},body:JSON.stringify({schemaVersion:'1.0',requestId,mode:real?'real':'mock',timeoutMs,input}),signal:AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)])});
            if(!response.ok){const error=await response.json().catch(()=>null) as {code?:string}|null;const code=error?.code&&['MODEL_NOT_CONFIGURED','MODEL_TIMEOUT','BUDGET_EXCEEDED','MODEL_OUTPUT_INVALID','DEPENDENCY_UNAVAILABLE','VALIDATION_ERROR'].includes(error.code)?error.code:'PLANNER_ERROR';throw fault(code,'规划服务拒绝请求：'+code);}
            const parsed=BrowserAgentResponse.parse(await response.json());if(parsed.requestId!==requestId||parsed.mode!==(real?'real':'mock')||real&&(parsed.invocations.length!==1||parsed.invocations[0]?.response.provider!=='moonshot')||!real&&parsed.invocations.length!==0)throw fault('MODEL_OUTPUT_INVALID','规划响应身份不符');
            await commit(async tx=>{const out=await put(parsed,'browser-plan-output',tx);await tx.v2Observation.create({data:{sessionId,round:cp.toolCalls??0,source:'browser-plan',evidenceArtifactIds:[ref.id,out.id],summary:{strategy,modelCalls:parsed.invocations.length}}});});
            return parsed.output;
          },
        });
        browsers.set(request.idempotencyKey,browser);
      }else if(request.capabilityId==='platform.browser-read'){
        browser=browsers.get((request.input as {browserRef:string}).browserRef);
        if(!browser)throw fault('BROWSER_RECOVERY_REQUIRED','浏览器实例不存在或已过期，不能复用其他会话');
      }
      result=await invokeCapability({...request,browser,deadline:Math.min(request.deadline,+intent!.deadline),invocationId:invocation.id});}
    catch(error){const code=(error as {code?:string}).code??'DEPENDENCY_UNAVAILABLE';result={status:write||code==='BROWSER_RECOVERY_REQUIRED'?'UNKNOWN':'FAILED',output:null,resourceKeys:[],retryable:false,error:{code,message:'能力执行中断：'+code}};}
    if(write&&result.status==='CANCELLED')result={...result,status:'UNKNOWN',retryable:false};
    await commit(async tx=>{
      const attached:string[]=[];
      const output=result.output as {screenshotPath?:unknown;screenshotSha256?:unknown}|null;
      if(result.status==='SUCCEEDED'&&output?.screenshotPath){
        if(manifest.protocol!=='local-ts'||typeof output.screenshotPath!=='string'||typeof output.screenshotSha256!=='string')throw fault('EVIDENCE_INVALID','截图必须来自受控本地适配器');
        const file=realpathSync(output.screenshotPath),root=realpathSync(args.artifactDir);
        if(!file.startsWith(root+sep)||statSync(file).size>32*1024*1024)throw fault('EVIDENCE_INVALID','截图路径或大小非法');
        const bytes=readFileSync(file);if(createHash('sha256').update(bytes).digest('hex')!==output.screenshotSha256)throw fault('EVIDENCE_INVALID','截图内容哈希不符');
        const saved=store.put({runId:sessionId,attemptId:'graph',filename:`screenshot-${randomUUID()}.png`,data:bytes});
        const shot=await tx.artifact.create({data:{projectId:session.projectId,storageKey:saved.storageKey,checksum:saved.checksum,type:'SCREENSHOT',sensitivity:'RESTRICTED_RAW'}});attached.push(shot.id);
      }
      const ref=await put(result,'receipt',tx);
      await tx.v2Invocation.update({where:{id:invocation.id},data:{status:result.status,finishedAt:new Date(),receipt:{artifactId:ref.id,outputHash:digest(result),evidenceIds:attached},error:result.error as never}});
      await tx.v2StepAttempt.update({where:{id:intent!.stepAttemptId},data:{status:result.status,outputRefs:[ref.id]}});
      await tx.v2Observation.create({data:{sessionId,round:ordinal,source:manifest.effectClass==='READ'?'capability-read':'capability-receipt',evidenceArtifactIds:[ref.id,...attached],summary:{capabilityId:request.capabilityId,logicalKey:request.idempotencyKey,output:result.output} as never}});
      await tx.v2SessionEvent.create({data:{sessionId,type:'invocation',payload:{invocationId:invocation.id,status:result.status,evidenceId:ref.id}}});await saveUsage(tx);
    });
    return result;
  }
  async function finish(result:Record<string,unknown>){
    await commit(async tx=>{
      await saveUsage(tx);
      const fresh=await tx.v2ExecutionSession.findUniqueOrThrow({where:{id:sessionId}});
      await tx.v2ExecutionSession.update({where:{id:sessionId},data:{status:String(result.status),result:result as never,terminationReason:String(result.reason??''),checkpoint:{...(fresh.checkpoint as object),activeSince:null},leaseToken:null,leaseExpiresAt:null}});
      await tx.v2SessionEvent.create({data:{sessionId,type:'state',payload:result as never}});
    });return result;
  }
  try{
    if(cp.snapshotHash!==digest(snapshot))throw fault('CONFLICT','冻结图快照哈希不符');
    const environment=await prisma.environment.findFirst({where:{id:session.environmentId,projectId:session.projectId,isProduction:false}});
    if(!environment)throw fault('FORBIDDEN','测试环境不可用');
    const profile=await prisma.v2HarnessProfile.findFirst({where:{id:session.profileId,projectId:session.projectId,contentHash:session.profileHash,status:'PUBLISHED'}});
    if(!profile)throw fault('FORBIDDEN','组合配置已停用');
    profileContent=HarnessProfileContent.parse(profile.content);
    if(computeProfileHash(profileContent)!==session.profileHash)throw fault('CONFLICT','组合配置内容已漂移');
    for(const [key,pin]of Object.entries(snapshot.installations)){
      const installation=await prisma.v2AdapterInstallation.findFirst({where:{id:pin.installationId,projectId:session.projectId,status:'AUTHORIZED',manifestHash:pin.manifestHash}});
      if(!installation)throw fault('FORBIDDEN','固定安装已撤销');
      const row=await prisma.v2CapabilityManifest.findUniqueOrThrow({where:{capabilityId_version:{capabilityId:installation.capabilityId,version:installation.capabilityVersion}}});
      if(row.manifestHash!==pin.manifestHash)throw fault('CONFLICT','能力版本漂移');
      const parsed=CapabilityManifest.parse(row.manifest);if(computeManifestHash(parsed)!==pin.manifestHash)throw fault('CONFLICT','能力清单内容漂移');manifests.set(key,parsed);
    }
    const row=await prisma.v2OracleSpec.findFirstOrThrow({where:{id:session.oracleSpecId,projectId:session.projectId}});
    const oracle=OracleSpec.parse({...row,createdAt:row.createdAt.toISOString(),approvedAt:row.approvedAt?.toISOString()??null});
    if(!['APPROVED','SUPERSEDED'].includes(oracle.status)||!oracle.approvedBy||!oracle.approvedAt||computeOracleHash(oracle)!==session.oracleHash)throw fault('CONFLICT','批准标准漂移');
    // Observation mappings cannot substitute write acknowledgements for business facts.
    for(const assertion of oracle.assertions){
      const binding=snapshot.assertionBindings[assertion.id];
      const node=snapshot.definition.nodes.find(n=>n.nodeId===binding?.nodeId);
      if(!binding||!node||manifests.get(`${node.capabilityId}@${node.capabilityVersion}`)?.effectClass!=='READ'||assertion.precondition||(assertion.allowedRoles.length&&node.capabilityId!=='platform.browser-read')||assertion.unit)throw fault('UNSUPPORTED_ORACLE','断言必须绑定只读观察节点；条件、角色或单位需要专用验证器');
      const downstream=snapshot.definition.nodes.filter(n=>n.dependsOn.includes(node.nodeId));
      if(downstream.length)throw fault('UNSUPPORTED_ORACLE','判定必须引用末端观察，不能用后续动作之前的快照');
    }
    await commit(saveUsage);
    const graph:GraphExecutionResult=await executeGraph({prisma,projectId:session.projectId,definition:snapshot.definition,subflows:snapshot.subflows,taskInput:snapshot.taskInput,deadline,signal,allowedOrigins:environment.allowedOrigins.filter(origin=>snapshot.allowedOrigins.includes(origin)),environmentId:environment.id,artifactDir:args.artifactDir,executionKey:sessionId,installations:snapshot.installations,invoke});
    await guard();
    await checkBuild();
    const checks=verifyGraphAssertions(oracle,snapshot.assertionBindings,graph.nodes);
    const verdict=graph.status==='require_human'?'review':graph.status!=='completed'?'blocked':checks.some(c=>c.verdict==='fail')?'fail':checks.some(c=>c.verdict!=='pass')||oracle.semanticCandidates.length?'review':'pass';
    const result={status:graph.status==='require_human'?'WAITING_HUMAN':verdict==='pass'?'COMPLETED':'FAILED',verdict,reason:graph.firstFailure?.error?.message??'已按冻结标准核验',graph,checks,buildVerification:{verified:buildVerified,evidenceIds:buildEvidence,reason:snapshot.buildProbe?'运行前后及各调用前核验':'未配置构建探针，仅完成声明版本上的诊断'}};
    await commit(async tx=>{await tx.v2CoverageLedger.create({data:{projectId:session.projectId,oracleSpecId:session.oracleSpecId,entries:{sessionId,checks,declarations:oracle.coverageDeclarations} as never}});});
    await commit(async tx=>{
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${session.projectId} FOR UPDATE`;
      const observations=await tx.v2Observation.findMany({where:{sessionId}});
      const evidenceIds=observations.flatMap(o=>o.evidenceArtifactIds);
      for(const check of checks.filter(c=>c.verdict==='fail')){
        const dedupeKey=digest({oracleHash:session.oracleHash,assertionId:check.assertionId,buildId:session.buildId});
        if(await tx.v2Finding.findFirst({where:{projectId:session.projectId,dedupeKey}}))continue;
        const records=[];for(const observation of observations)for(const id of observation.evidenceArtifactIds){const artifact=await tx.artifact.findUnique({where:{id}});if(artifact?.type==='SCREENSHOT')continue;try{records.push({id,source:observation.source,body:await read(id)});}catch{}}
        const investigation=investigateEvidence(records);
        await tx.v2Finding.create({data:{projectId:session.projectId,oracleSpecId:oracle.id,ruleVersionId:check.ruleVersionId,status:'candidate',expected:canonicalStringify(oracle.assertions.find(a=>a.id===check.assertionId)!.expected),actual:canonicalStringify(check.actual),firstFailure:{sessionId,attemptId:null,runId:null,evidenceIds,observedAt:new Date().toISOString()},hypotheses:investigation.hypotheses,dedupeKey,buildId:session.buildId}});
      }
    });
    return await finish(result);
  }catch(error){
    const current=await prisma.v2ExecutionSession.findUniqueOrThrow({where:{id:sessionId}});
    if(current.leaseToken!==token||current.status!=='RUNNING')return {status:current.status,verdict:'review',reason:'会话控制已变更'};
    return await finish({status:(error as {code?:string}).code==='BROWSER_RECOVERY_REQUIRED'?'WAITING_HUMAN':'FAILED',verdict:(error as {code?:string}).code==='BROWSER_RECOVERY_REQUIRED'?'review':'blocked',reason:(error as Error).message,code:(error as {code?:string}).code??'INTERNAL'});
  }finally{await Promise.allSettled([...browsers.values()].map(browser=>browser.close()));clearInterval(heartbeat);clearTimeout(timer);controller.abort();await prisma.v2ExecutionSession.updateMany({where:{id:sessionId,leaseToken:token},data:{leaseToken:null,leaseExpiresAt:null}});}
}
