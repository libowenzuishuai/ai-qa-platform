import {canonicalStringify} from '@ai-qa/contracts';
import type {FastifyInstance} from 'fastify';
import type {PrismaClient} from '@prisma/client';
import {ArtifactStore} from '@ai-qa/artifact-store';
import {createHash,randomUUID} from 'node:crypto';
import {requireAuth,requireProjectAccess} from './auth.js';
import {requireV2Evidence} from './v2-evidence.js';
import {ApiError} from './errors.js';
export function registerV2ResourceRoutes(app:FastifyInstance,prisma:PrismaClient,artifactDir:string){
 const store=new ArtifactStore(artifactDir);
 async function evidence(projectId:string,id:string){const [a]=await requireV2Evidence(prisma,projectId,[id],artifactDir);return JSON.parse(store.read(a!.storageKey).toString());}
 async function resources(sessionId:string,projectId:string){
  const rows=await prisma.v2Observation.findMany({where:{sessionId,source:{in:['fixture-intent','fixture-receipt','fixture-cleanup']}},orderBy:[{observedAt:'asc'},{id:'asc'}]});const map=new Map<string,{key:string;status:string;lastAction:string}>();
  for(const row of rows){let e;try{e=await evidence(projectId,row.evidenceArtifactIds[0]!);}catch{const key=(row.summary as {resourceKey?:string})?.resourceKey;if(key)map.set(key,{key,status:'unknown',lastAction:'evidence-unavailable'});continue;}const key=e.resourceKey;if(typeof key!=='string')continue;
   const old=map.get(key);if(row.source==='fixture-intent'&&e.creates)map.set(key,{key,status:'unknown',lastAction:e.action});
   else if(old){old.lastAction=e.action;if(e.response?.namespace!==key){old.status='unknown';continue;}if(e.action==='reproduction:cleanup')old.status=e.response.clean===true?'cleaned':'cleanup_failed';else if(e.action==='reproduction:reset'&&e.response.clean===true)old.status='active';}
  }return [...map.values()];
 }
 app.get('/api/v2/sessions/:id/resources',async req=>{const {id}=req.params as {id:string};const s=await prisma.v2ExecutionSession.findUnique({where:{id}});if(!s)throw new ApiError('NOT_FOUND','运行不存在');await requireProjectAccess(prisma,req,s.projectId,'LEAD');return {resources:await resources(id,s.projectId)};});
 app.post('/api/v2/sessions/:id/resources/:key/cleanup',async req=>{
  const {id,key}=req.params as {id:string;key:string};const s=await prisma.v2ExecutionSession.findUnique({where:{id}});if(!s)throw new ApiError('NOT_FOUND','运行不存在');await requireProjectAccess(prisma,req,s.projectId,'ADMIN');
  const owned=(await resources(id,s.projectId)).find(r=>r.key===key);if(!owned)throw new ApiError('FORBIDDEN','资源不属于该运行的账本');if(owned.status==='cleaned')return {cleaned:true,existed:true};
  // Recover the target only from the original checksummed invocation input; callers supply no URL.
  const intents=await prisma.v2ActionIntent.findMany({where:{sessionId:id,capabilityId:'platform.reproduction-minimize'}});let original:{baseUrl:string;buildId:string;oracleHash:string}|undefined;
  for(const intent of intents){const logical=intent.idempotencyKey.replace(/:attempt-\d+$/,'');const scope=createHash('sha256').update(logical).digest('hex').slice(0,24);if(key.startsWith(`aiqa-${scope}-`)&&/^\d+$/.test(key.slice(scope.length+6))&&intent.inputArtifactId){const input=await evidence(s.projectId,intent.inputArtifactId);if(createHash('sha256').update(canonicalStringify(input)).digest('hex')!==intent.inputHash)throw new ApiError('CONFLICT','原始资源输入哈希不符');original=input;}}
  if(!original)throw new ApiError('FORBIDDEN','资源与原始调用身份不一致');
  const env=await prisma.environment.findFirst({where:{id:s.environmentId!,projectId:s.projectId,isProduction:false}}),target=new URL('/aiqa/reproduction/cleanup',original.baseUrl);
  if(!env?.allowedOrigins.includes(target.origin)||target.username||target.password)throw new ApiError('FORBIDDEN','清理环境未授权');
  await prisma.auditEvent.create({data:{actorId:requireAuth(req).userId,entityType:'V2ExecutionSession',entityId:id,action:'v2.resource.cleanup.request',metadata:{resourceKey:key}}});
  return prisma.$transaction(async tx=>{
   await tx.$queryRaw`SELECT id FROM "V2ExecutionSession" WHERE id=${id} FOR UPDATE`;const fresh=await tx.v2ExecutionSession.findUniqueOrThrow({where:{id}});
   if(!['COMPLETED','FAILED','CANCELLED','WAITING_HUMAN'].includes(fresh.status)||fresh.leaseExpiresAt&&fresh.leaseExpiresAt>new Date())throw new ApiError('CONFLICT','运行仍持有资源，不能并发清理');
   await tx.auditEvent.create({data:{actorId:requireAuth(req).userId,entityType:'V2ExecutionSession',entityId:id,action:'v2.resource.cleanup',metadata:{resourceKey:key}}});
   const response=await fetch(target,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{'content-type':'application/json'},body:JSON.stringify({namespace:key,buildId:original!.buildId,oracleHash:original!.oracleHash,steps:[],idempotencyKey:key+':cleanup'})});
   if(!response.ok||!response.body)throw new ApiError('DEPENDENCY_UNAVAILABLE','清理未确认，残留继续保留');
   const reader=response.body.getReader(),parts:Buffer[]=[];let size=0;try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>65536)throw new ApiError('VALIDATION_ERROR','清理响应超限');parts.push(Buffer.from(part.value));}}finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
   const value=JSON.parse(Buffer.concat(parts).toString());if(value.namespace!==key||value.buildId!==original!.buildId||value.oracleHash!==original!.oracleHash||value.clean!==true)throw new ApiError('CONFLICT','清理回执与资源归属不一致');
   const saved=store.put({runId:id,attemptId:'cleanup',filename:randomUUID()+'.json',data:Buffer.from(JSON.stringify({action:'reproduction:cleanup',resourceKey:key,response:value}))});
   const artifact=await tx.artifact.create({data:{projectId:s.projectId,storageKey:saved.storageKey,checksum:saved.checksum,type:'OBSERVATION',sensitivity:'RESTRICTED_RAW'}});
   await tx.v2Observation.create({data:{sessionId:id,round:0,source:'fixture-cleanup',evidenceArtifactIds:[artifact.id],summary:{resourceKey:key,cleaned:true}}});return {cleaned:true,existed:false};
  },{timeout:10000});
 });
}
