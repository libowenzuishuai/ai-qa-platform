import {z} from 'zod';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {PrismaClient} from '@prisma/client';
import {ArtifactStore} from '@ai-qa/artifact-store';
import {canonicalStringify} from '@ai-qa/contracts';
import {createHash} from 'node:crypto';
import {executeGraph} from '@ai-qa/adapter-sdk/graph-kernel';
import type {WorkflowDefinitionContent} from '@ai-qa/contracts';
interface GraphSnapshot{definition:WorkflowDefinitionContent;subflows:Record<string,WorkflowDefinitionContent>;taskInput:Record<string,unknown>}
import type {CapabilityResult} from '@ai-qa/adapter-sdk';
import {requireProjectAccess} from './auth.js';
import {ApiError} from './errors.js';
import {requireV2Evidence} from './v2-evidence.js';
const hash=(x:unknown)=>createHash('sha256').update(canonicalStringify(x)).digest('hex');
export function registerV2ReplayRoutes(app:FastifyInstance,prisma:PrismaClient,artifactDir?:string){
 app.post('/api/v2/sessions/:id/replay',async(req:FastifyRequest)=>{
  const options=z.object({faults:z.array(z.object({nodeId:z.string(),code:z.enum(['TIMEOUT','DEPENDENCY_UNAVAILABLE','MODEL_OUTPUT_INVALID']),retryable:z.boolean().default(false)}).strict()).max(30).default([]),onlyNode:z.string().optional()}).strict().parse(req.body??{});
  const sessionId=(req.params as {id:string}).id,session=await prisma.v2ExecutionSession.findUnique({where:{id:sessionId}});if(!session)throw new ApiError('NOT_FOUND','运行不存在');
  await requireProjectAccess(prisma,req,session.projectId,'LEAD');
  if(!['COMPLETED','FAILED','CANCELLED','WAITING_HUMAN'].includes(session.status))throw new ApiError('CONFLICT','只能回放已停止运行');
  const jobs=await prisma.job.findMany({where:{projectId:session.projectId,kind:'V2_GRAPH_SESSION',request:{path:['sessionId'],equals:sessionId}},take:2});
  if(jobs.length!==1)throw new ApiError('CONFLICT','冻结运行快照不存在或不唯一');
  const snapshot=(jobs[0]!.request as unknown as {snapshot:GraphSnapshot}).snapshot;
  if(hash(snapshot)!==(session.checkpoint as {snapshotHash:string}).snapshotHash)throw new ApiError('CONFLICT','快照内容漂移');
  if(options.onlyNode&&!snapshot.definition.nodes.some(n=>n.nodeId===options.onlyNode))throw new ApiError('VALIDATION_ERROR','调试节点不属于原始图');
  if(options.faults.some(f=>!snapshot.definition.nodes.some(n=>n.nodeId===f.nodeId)))throw new ApiError('VALIDATION_ERROR','注入节点不属于原始图');
  const injected=new Set<string>();
  const store=new ArtifactStore(artifactDir??process.env.AIQA_ARTIFACT_DIR??'data/artifacts');
  const graph=await executeGraph({projectId:session.projectId,definition:snapshot.definition,subflows:snapshot.subflows,taskInput:snapshot.taskInput,deadline:Date.now()+30000,signal:AbortSignal.timeout(30000),allowedOrigins:[],executionKey:sessionId,
   invoke:async request=>{
    const nodeId=request.idempotencyKey.slice(sessionId.length+1).split(':')[0];const fault=options.faults.find(f=>f.nodeId===nodeId);
    if(fault&&!injected.has(nodeId!)){injected.add(nodeId!);return {status:'FAILED',output:null,resourceKeys:[],retryable:fault.retryable,error:{code:fault.code,message:'显式离线故障注入'}};}
    const intent=await prisma.v2ActionIntent.findUnique({where:{sessionId_idempotencyKey:{sessionId,idempotencyKey:request.invocationId}}});
    if(!intent||intent.inputHash!==hash(request.input)||intent.capabilityId!==request.capabilityId||intent.capabilityVersion!==request.capabilityVersion)throw new ApiError('CONFLICT','回放缺少匹配的原始意图');
    const invocation=await prisma.v2Invocation.findFirst({where:{intentId:intent.id},orderBy:{attemptNo:'desc'}}),receipt=invocation?.receipt as {artifactId?:string;evidenceIds?:string[]}|null;
    if(!receipt?.artifactId||!intent.inputArtifactId)throw new ApiError('CONFLICT','回放缺少原始输入或回执，禁止访问目标补齐');
    const artifacts=await requireV2Evidence(prisma,session.projectId,[intent.inputArtifactId,receipt.artifactId,...receipt.evidenceIds??[]],artifactDir);
    const original=JSON.parse(store.read(artifacts.find(x=>x.id===intent.inputArtifactId)!.storageKey).toString());if(hash(original)!==intent.inputHash)throw new ApiError('CONFLICT','原始输入被修改');
    return JSON.parse(store.read(artifacts.find(x=>x.id===receipt.artifactId)!.storageKey).toString()) as CapabilityResult;
   }});
  return {mode:options.faults.length?'fault-injection-replay':options.onlyNode?'node-replay':'recorded-replay',externalCalls:0,sourceSessionId:sessionId,graph:options.onlyNode?{...graph,nodes:graph.nodes.filter(n=>n.nodeId===options.onlyNode)}:graph,notes:['回放保留失败与重试，不调用目标系统或模型','历史证据回放不等于当前构建重新通过']};
 });
}
