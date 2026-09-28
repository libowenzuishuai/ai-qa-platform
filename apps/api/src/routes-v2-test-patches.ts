import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {PrismaClient} from '@prisma/client';
import {z} from 'zod';
import {createHash,randomUUID} from 'node:crypto';
import {ArtifactStore} from '@ai-qa/artifact-store';
import {CandidateTestsOutput,CandidateTestsInput,CandidateTestsRequest,CandidateTestsResponse,CodeCheckRequest,canonicalStringify} from '@ai-qa/contracts';
import {requireProjectAccess,requireAuth} from './auth.js';
import {ApiError} from './errors.js';
import {requireV2Evidence} from './v2-evidence.js';
const digest=(v:unknown)=>createHash('sha256').update(canonicalStringify(v)).digest('hex');
export function registerV2TestPatchRoutes(app:FastifyInstance,prisma:PrismaClient,config:{artifactDir:string;intelligenceUrl?:string;intelligenceToken?:string}){
 const id=(req:FastifyRequest)=>(req.params as {id:string}).id;
 const store=new ArtifactStore(config.artifactDir);
 async function patch(req:FastifyRequest,role:'LEAD'|'VIEWER'='LEAD'){
  const p=await prisma.v2TestPatch.findUnique({where:{id:id(req)}});if(!p)throw new ApiError('NOT_FOUND','测试补丁不存在');await requireProjectAccess(prisma,req,p.projectId,role);return p;
 }
 async function bundle(p:Awaited<ReturnType<typeof patch>>){
  const rows=await requireV2Evidence(prisma,p.projectId,p.contentArtifactId?[p.contentArtifactId]:[],config.artifactDir);
  const data=z.object({input:CandidateTestsInput,output:CandidateTestsOutput}).strict().parse(JSON.parse(store.read(rows[0]!.storageKey).toString()));
  if(data.output.files.length!==(p.files as unknown[]).length)throw new ApiError('CONFLICT','补丁文件数量不符');
  for(const file of data.output.files){const actual=createHash('sha256').update(file.content).digest('hex');if(actual!==file.contentHash||!(p.files as Array<{path:string;contentHash:string}>).some(f=>f.path===file.path&&f.contentHash===actual))throw new ApiError('CONFLICT','补丁文件哈希不符');}
  return data;
 }
 app.get('/api/v2/projects/:id/test-patches',async req=>{await requireProjectAccess(prisma,req,id(req),'VIEWER');return {patches:await prisma.v2TestPatch.findMany({where:{projectId:id(req)},orderBy:{createdAt:'desc'},take:100})};});
 app.get('/api/v2/projects/:id/test-patches/rules',async req=>{await requireProjectAccess(prisma,req,id(req),'LEAD');return {rules:await prisma.ruleVersion.findMany({where:{rule:{projectId:id(req)},reviewStatus:'APPROVED'},select:{id:true,statement:true,expectation:true},take:100,orderBy:{createdAt:'desc'}})};});
 app.get('/api/v2/test-patches/:id',async req=>{const p=await patch(req);return {patch:p,candidate:await bundle(p),checks:await prisma.codeCheck.findMany({where:{projectId:p.projectId,request:{path:['candidateTestPatchId'],equals:p.id}},select:{id:true,status:true,verdict:true,createdAt:true},orderBy:{createdAt:'asc'}})};});
 app.post('/api/v2/test-patches/:id/reject',async req=>{const p=await patch(req);const body=z.object({reason:z.string().min(1).max(2000)}).strict().parse(req.body);return prisma.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${p.projectId} FOR UPDATE`;const row=await tx.v2TestPatch.update({where:{id:p.id},data:{status:'rejected'}});await tx.auditEvent.create({data:{actorId:requireAuth(req).userId,action:'v2.test-patch.reject',entityType:'V2TestPatch',entityId:p.id,metadata:body}});return row;});});
 app.post('/api/v2/projects/:id/test-patches',async(req,reply)=>{
  const projectId=id(req);await requireProjectAccess(prisma,req,projectId,'LEAD');
  const body=z.object({repositoryUrl:CodeCheckRequest.shape.repositoryUrl,commitSha:CodeCheckRequest.shape.commitSha,language:CandidateTestsInput.shape.language,modulePath:CandidateTestsInput.shape.modulePath,functionName:CandidateTestsInput.shape.functionName,examples:CandidateTestsInput.shape.examples}).strict().parse(req.body);
  if(!config.intelligenceUrl||!config.intelligenceToken)throw new ApiError('DEPENDENCY_UNAVAILABLE','Python 测试生成服务未配置（此模板不调用模型）');
  const ruleIds=[...new Set(body.examples.map(e=>e.ruleVersionId))];
  const rules=await prisma.ruleVersion.findMany({where:{id:{in:ruleIds},rule:{projectId},reviewStatus:'APPROVED'}});
  if(rules.length!==ruleIds.length)throw new ApiError('VALIDATION_ERROR','仅能依据本项目已批准规则生成测试');
  const input=CandidateTestsInput.parse({language:body.language,modulePath:body.modulePath,functionName:body.functionName,examples:body.examples,rules:rules.map(r=>({id:r.id,reviewStatus:r.reviewStatus,expectation:r.expectation}))});
  const wire=CandidateTestsRequest.parse({schemaVersion:'1.0',requestId:randomUUID(),mode:'real',timeoutMs:10000,input});
  let response:Response;
  try{response=await fetch(new URL('/v2/tests/propose',config.intelligenceUrl),{method:'POST',redirect:'error',headers:{authorization:`Bearer ${config.intelligenceToken}`,'content-type':'application/json','x-aiqa-model-calls':'0','x-aiqa-model-tokens':'0'},body:JSON.stringify(wire),signal:AbortSignal.timeout(10000)});}catch{throw new ApiError('DEPENDENCY_UNAVAILABLE','测试生成服务不可达');}
  if(!response.ok)throw new ApiError('MODEL_OUTPUT_INVALID','输入未被测试生成器接受');
  const generated=CandidateTestsResponse.parse(await response.json());
  if(generated.requestId!==wire.requestId||generated.mode!==wire.mode||generated.output.exampleIds.length!==input.examples.length||generated.output.exampleIds.some((e,i)=>e!==input.examples[i]!.id))throw new ApiError('MODEL_OUTPUT_INVALID','生成结果身份或样例覆盖不符');
  for(const f of generated.output.files)if(createHash('sha256').update(f.content).digest('hex')!==f.contentHash)throw new ApiError('MODEL_OUTPUT_INVALID','生成文件哈希不符');
  const stored=store.put({runId:`test-patch-${randomUUID()}`,attemptId:'candidate',filename:'candidate.json',data:Buffer.from(canonicalStringify({input,output:generated.output}))});
  const created=await prisma.$transaction(async tx=>{
   const artifact=await tx.artifact.create({data:{projectId,storageKey:stored.storageKey,checksum:stored.checksum,type:'TEST_CANDIDATE',sensitivity:'RESTRICTED_RAW'}});
   const p=await tx.v2TestPatch.create({data:{projectId,origin:{kind:'approved_rule',refs:ruleIds},repositoryUrl:body.repositoryUrl,commitSha:body.commitSha,contentArtifactId:artifact.id,files:generated.output.files.map(f=>({path:f.path,contentHash:f.contentHash})),execution:{ranAt:null,totalTests:null,failedTests:null,reportArtifactId:null},validity:{knownDefectsDetected:null,mutantsKilled:null,mutantsTotal:null,weakPatternsFound:[]}}});
   await tx.auditEvent.create({data:{actorId:requireAuth(req).userId,action:'v2.test-patch.create',entityType:'V2TestPatch',entityId:p.id,metadata:{inputHash:digest(input),generator:generated.output.generatorVersion}}});return p;
  });return reply.code(201).send(created);
 });
 app.post('/api/v2/test-patches/:id/approve',async req=>{
  const p=await patch(req);await bundle(p);if(p.status==='rejected')throw new ApiError('CONFLICT','已驳回补丁不能执行');
  return prisma.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${p.projectId} FOR UPDATE`;const fresh=await tx.v2TestPatch.findUniqueOrThrow({where:{id:p.id}});if(fresh.status==='rejected')throw new ApiError('CONFLICT','补丁已驳回');const saved=await tx.v2TestPatch.update({where:{id:p.id},data:{reviewedBy:requireAuth(req).userId,reviewedAt:new Date()}});await tx.auditEvent.create({data:{actorId:requireAuth(req).userId,action:'v2.test-patch.approve-examples',entityType:'V2TestPatch',entityId:p.id}});return saved;});
 });
 app.get('/api/v2/test-patches/:id/download',async(req,reply)=>{
  const p=await patch(req,'LEAD'),data=await bundle(p);
  const diff=data.output.files.map(f=>{const lines=f.content.replace(/\n$/,'').split('\n');return `diff --git a/${f.path} b/${f.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${f.path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l=>'+'+l).join('\n')}\n`;}).join('');
  return reply.type('text/x-diff').header('content-disposition',`attachment; filename="aiqa-${p.id}.patch"`).send(diff);
 });
 app.post('/api/v2/test-patches/:id/run',async(req,reply)=>{
  const p=await patch(req),data=await bundle(p);if(!p.reviewedAt||!p.reviewedBy||p.status==='rejected')throw new ApiError('CONFLICT','请先审核样例期望及生成补丁');
  const body=z.object({variant:z.enum(['healthy','defect','fix']),commitSha:CodeCheckRequest.shape.commitSha,timeoutSeconds:CodeCheckRequest.shape.timeoutSeconds,installDependencies:CodeCheckRequest.shape.installDependencies,idempotencyKey:z.string().min(8).max(120)}).strict().parse(req.body);
  if(body.variant==='healthy'&&body.commitSha!==p.commitSha)throw new ApiError('CONFLICT','健康基线必须为补丁固定的原始 SHA');
  const kind=data.input.language==='node'?'NODE_TEST':'PYTHON_TEST';
  if(!await prisma.executionRunner.findFirst({where:{projectId:p.projectId,revokedAt:null,capabilities:{has:kind}}}))throw new ApiError('DEPENDENCY_UNAVAILABLE','缺少支持当前语言的隔离运行器');
  const request=CodeCheckRequest.parse({repositoryUrl:p.repositoryUrl,commitSha:body.commitSha,subdirectory:'',kind,timeoutSeconds:body.timeoutSeconds,installDependencies:body.installDependencies,idempotencyKey:body.idempotencyKey,candidateTestPatchId:p.id,candidateVariant:body.variant,candidateFiles:data.output.files});
  const check=await prisma.$transaction(async tx=>{
   await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${p.projectId} FOR UPDATE`;
   const fresh=await tx.v2TestPatch.findUniqueOrThrow({where:{id:p.id}});if(fresh.status==='rejected'||!fresh.reviewedAt)throw new ApiError('CONFLICT','补丁未获执行批准');
   const old=await tx.codeCheck.findUnique({where:{projectId_idempotencyKey:{projectId:p.projectId,idempotencyKey:body.idempotencyKey}}});
   if(old){if(digest(old.request)!==digest(request))throw new ApiError('CONFLICT','运行幂等键对应不同对照');return old;}
   return tx.codeCheck.create({data:{projectId:p.projectId,createdBy:requireAuth(req).userId,idempotencyKey:body.idempotencyKey,request}});
  });return reply.code(202).send(check);
 });
 app.post('/api/v2/test-patches/:id/evaluate',async req=>{
  const p=await patch(req),data=await bundle(p);if(p.status==='rejected')throw new ApiError('CONFLICT','已驳回的补丁不能升级为有效');const checks=await prisma.codeCheck.findMany({where:{projectId:p.projectId,request:{path:['candidateTestPatchId'],equals:p.id}},orderBy:{createdAt:'asc'}});
  const first=new Map<string,typeof checks[number]>();
  for(const c of checks){const request=c.request as {candidateVariant:string;commitSha:string;candidateFiles:unknown};if(digest(request.candidateFiles)!==digest(data.output.files))throw new ApiError('CONFLICT','对照运行使用了不同补丁');const key=`${request.candidateVariant}:${request.commitSha}`;if(!first.has(key))first.set(key,c);}
  const healthy=[...first.values()].find(c=>(c.request as {candidateVariant:string}).candidateVariant==='healthy');
  const defect=[...first.values()].filter(c=>(c.request as {candidateVariant:string}).candidateVariant==='defect'&&c.verdict==='FAIL'&&c.status==='FINISHED');
  const fixed=[...first.values()].find(c=>(c.request as {candidateVariant:string}).candidateVariant==='fix'&&c.verdict==='PASS'&&c.status==='FINISHED');
  const ids=[healthy,...defect,fixed].filter((c):c is typeof checks[number]=>Boolean(c));
  if(ids.length){if(ids.some(c=>!c.evidenceId))throw new ApiError('CONFLICT','运行结果缺少证据');const evidence=await requireV2Evidence(prisma,p.projectId,ids.map(c=>c.evidenceId!),config.artifactDir);for(const c of ids){const artifact=evidence.find(a=>a.id===c.evidenceId)!;if(digest(JSON.parse(store.read(artifact.storageKey).toString()))!==digest(c.result))throw new ApiError('CONFLICT','运行记录与原始证据不一致');}}
  const tested=ids.every(c=>{const r=c.result as {cases?:Array<{status:string}>;platformError?:string}|null;return !r?.platformError&&r?.cases?.length===data.input.examples.length&&r.cases.every(x=>x.status!=='SKIP');});
  const assertionDefects=defect.every(c=>{const r=c.result as {cases:Array<{status:string;failureKind?:string}>};const failures=r.cases.filter(x=>x.status==='FAIL');return failures.length>0&&failures.every(x=>x.failureKind==='assertion');});
  const distinct=healthy&&fixed&&defect.length&&new Set(ids.map(c=>(c.request as {commitSha:string}).commitSha)).size===ids.length;
  const valid=Boolean(p.reviewedAt&&healthy?.verdict==='PASS'&&healthy.status==='FINISHED'&&fixed&&defect.length&&tested&&distinct&&assertionDefects);
  const report={generatedAt:new Date().toISOString(),validated:valid,firstAttempts:[...first.values()].map(c=>({codeCheckId:c.id,verdict:c.verdict,status:c.status})),limitations:data.output.limitations,reason:valid?'健康、已知缺陷、修复三个不同 SHA 使用同一补丁通过对照':'对照不完整或存在跳过、首轮失败、重复构建、平台错误或非断言失败'};
  const stored=store.put({runId:`test-patch-${p.id}`,attemptId:'evaluation',filename:`${randomUUID()}.json`,data:Buffer.from(canonicalStringify(report))});
  const row=await prisma.artifact.create({data:{projectId:p.projectId,storageKey:stored.storageKey,checksum:stored.checksum,type:'TEST_PATCH_EVALUATION',sensitivity:'NORMAL'}});
  const saved=await prisma.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${p.projectId} FOR UPDATE`;const fresh=await tx.v2TestPatch.findUniqueOrThrow({where:{id:p.id}});if(fresh.status==='rejected')throw new ApiError('CONFLICT','补丁已驳回');return tx.v2TestPatch.update({where:{id:p.id},data:{status:valid?'validated':checks.some(c=>c.status==='FINISHED')?'executed':'draft',execution:{ranAt:report.generatedAt,totalTests:data.input.examples.length,failedTests:null,reportArtifactId:row.id},validity:{knownDefectsDetected:valid?defect.length:null,mutantsKilled:null,mutantsTotal:null,weakPatternsFound:[]}}});});return {...report,patch:saved};
 });
}
