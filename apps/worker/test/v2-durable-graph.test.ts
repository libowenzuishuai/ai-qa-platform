import {registerJobRoutes} from '../../api/src/routes-jobs.js';
import {registerV2InvestigationRoutes} from "../../api/src/routes-v2-investigation.js";
import {beforeAll,afterAll,it,expect} from 'vitest';
import Fastify from 'fastify';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {rmSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createTestEnv,type TestEnv} from '../../api/test/helpers/db.js';
import {registerV2CapabilityRoutes} from '../../api/src/routes-v2-capabilities.js';
import {registerV2DefinitionRoutes} from '../../api/src/routes-v2-definitions.js';
import {registerV2ProfileRoutes} from '../../api/src/routes-v2-profiles.js';
import {registerV2SessionRoutes} from '../../api/src/routes-v2-sessions.js';
import {sendApiError} from '../../api/src/errors.js';
import {registerBuiltinSamples} from '../src/v2/samples.js';
import {HttpReadManifest} from '@ai-qa/adapter-sdk/samples/http-checker';
import {computeOracleHash} from '@ai-qa/contracts';
import {runGraphSession,type GraphSnapshot} from '../src/v2/graph-session.js';
let env:TestEnv,app:ReturnType<typeof Fastify>,server:ReturnType<typeof createServer>;
let projectId:string,environmentId:string,oracleSpecId:string,profileId:string,definitionId:string,installationId:string,baseUrl:string;
let hits=0,status=200,probeBuildId='declared-test';
let holdAfter=Infinity,holdReached=false;
const queue={add:async()=>({}) as never};
const budget={maxWallClockMs:60000,maxActiveMs:60000,maxModelCalls:0,maxTokens:0,maxToolCalls:20,maxResources:0,maxCostMicros:null};
beforeAll(async()=>{
 env=await createTestEnv('v2durable');app=Fastify();app.setErrorHandler((e,q,r)=>sendApiError(q,r,e));
 const user=await env.prisma.user.create({data:{username:randomUUID(),displayName:'lead',passwordHash:'unused',platformRole:'LEAD'}});
 projectId=(await env.prisma.project.create({data:{name:'durable',memberships:{create:{userId:user.id,role:'ADMIN'}}}})).id;
 app.addHook('onRequest',async req=>{req.auth={userId:user.id,username:user.username,displayName:user.displayName,platformRole:'LEAD'};});
 registerJobRoutes(app,env.prisma,queue);registerV2InvestigationRoutes(app,env.prisma,env.artifactDir);registerV2CapabilityRoutes(app,env.prisma);registerV2DefinitionRoutes(app,env.prisma);registerV2ProfileRoutes(app,env.prisma,queue);registerV2SessionRoutes(app,env.prisma,queue,{artifactDir:env.artifactDir});registerBuiltinSamples();
 server=createServer((_req,res)=>{if(_req.url==='/build'){res.setHeader('content-type','application/json');res.end(JSON.stringify({buildId:probeBuildId}));return;}hits++;if(hits===holdAfter){holdReached=true;return;}res.writeHead(status).end('actual business response');});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));baseUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 environmentId=(await env.prisma.environment.create({data:{projectId,name:'test',baseUrl,allowedOrigins:[baseUrl],runtime:{buildProbe:{path:'/build',field:'buildId'}}}})).id;
 installationId=(await app.inject({method:'POST',url:`/api/v2/projects/${projectId}/capabilities/install`,payload:{manifest:HttpReadManifest}})).json().installationId;
 expect((await app.inject({method:'POST',url:`/api/v2/installations/${installationId}/authorize`,payload:{scope:['read:http']}})).statusCode).toBe(200);
 const content={capabilities:[{capabilityId:HttpReadManifest.id,version:HttpReadManifest.version,installationId}],modelRoutes:{generator:'disabled',vision:'disabled',decision:'deterministic-v1'},verifierPolicy:'oracle-graph-v1',memoryPolicy:'none'};
 const profile=await app.inject({method:'POST',url:`/api/v2/projects/${projectId}/profiles`,payload:{key:'read-checks',content}});expect(profile.statusCode).toBe(201);profileId=profile.json().id;
 expect((await app.inject({method:'POST',url:`/api/v2/profiles/${profileId}/publish`})).statusCode).toBe(200);
 const node=(nodeId:string,dependsOn:string[])=>({nodeId,capabilityId:HttpReadManifest.id,capabilityVersion:'1.0.0',dependsOn,onFailure:'fail',bindings:{baseUrl:{source:'input',path:'url',type:'string'},resourcePath:{source:'constant',value:'/',type:'string'}}});
 const definition=await app.inject({method:'POST',url:`/api/v2/projects/${projectId}/definitions`,payload:{name:'checks',description:'two real HTTP calls',maxSubflowDepth:4,nodes:[node('first',[]),node('verify',['first'])]}});expect(definition.statusCode).toBe(202);definitionId=definition.json().definitionId;
 expect((await app.inject({method:'POST',url:`/api/v2/definitions/${definitionId}/publish`})).statusCode).toBe(200);
 const rv='rule-durable';const assertions=[{id:'status',ruleVersionId:rv,kind:'deterministic',fact:'resource available',observationType:'api_status',observationRef:'resource.status',operator:'equals',expected:'200',precondition:null,unit:null,tolerance:null,allowedRoles:[],required:true}];
 const declarations=['normal','boundary','permission','multi_role','state','persistence'].map(dimension=>({ruleVersionId:rv,dimension,status:'planned',reason:'fixture'}));
 const oracle={projectId,ruleVersionIds:[rv],assertions,semanticCandidates:[],coverageDeclarations:declarations};
 oracleSpecId=(await env.prisma.v2OracleSpec.create({data:{...oracle,assertions:assertions as never,coverageDeclarations:declarations as never,version:1,status:'APPROVED',oracleHash:computeOracleHash(oracle as never),createdBy:user.id,approvedBy:user.id,approvedAt:new Date()}})).id;
},30000);
afterAll(async()=>{await app?.close();server?.closeAllConnections();await new Promise<void>(r=>server?.close(()=>r()));await env?.cleanup();});
async function create(over:Record<string,unknown>={}){
 const body={goal:'Read twice and verify',definitionId,profileId,oracleSpecId,environmentId,buildId:'declared-test',taskInput:{url:baseUrl},assertionBindings:{status:{nodeId:'verify',path:'status'}},budget,idempotencyKey:randomUUID(),...over};
 const response=await app.inject({method:'POST',url:`/api/v2/projects/${projectId}/graph-sessions`,payload:body});expect(response.statusCode,response.body).toBe(202);
 expect((await app.inject({url:`/api/jobs/${response.json().jobId}`})).statusCode).toBe(200);
 const job=await env.prisma.job.findUniqueOrThrow({where:{id:response.json().jobId}});return {body,response,request:job.request as unknown as {sessionId:string;snapshot:GraphSnapshot}};
}
async function run(request:{sessionId:string;snapshot:GraphSnapshot}){probeBuildId=(await env.prisma.v2ExecutionSession.findUniqueOrThrow({where:{id:request.sessionId}})).buildId!;return runGraphSession({prisma:env.prisma,...request,artifactDir:env.artifactDir});}
it('published profile → frozen graph → real HTTP → independent oracle, complete evidence',async()=>{
 const {request}=await create();const before=hits;const result=await run(request);expect(result.verdict).toBe('pass');expect(hits-before).toBe(2);
 const detail=(await app.inject({url:`/api/v2/sessions/${request.sessionId}`})).json();expect(detail.invocations).toHaveLength(2);expect(detail.reportVerdict).toBe('pass');expect(detail.evidenceComplete).toBe(true);
 expect(await env.prisma.v2CoverageLedger.count({where:{projectId}})).toBeGreaterThan(0);
 await run(request);expect(hits-before).toBe(2);
});
it('HTTP 500 is a business FAIL, never a successful tool receipt PASS',async()=>{status=500;try{const {request}=await create();expect((await run(request)).verdict).toBe('fail');}finally{status=200;}});
it('same idempotency key compares full request; changed body returns 409',async()=>{
 const {body,response}=await create();const same=await app.inject({method:'POST',url:`/api/v2/projects/${projectId}/graph-sessions`,payload:body});expect(same.statusCode).toBe(200);expect(same.json().sessionId).toBe(response.json().sessionId);
 expect((await app.inject({method:'POST',url:`/api/v2/projects/${projectId}/graph-sessions`,payload:{...body,goal:'changed'}})).statusCode).toBe(409);
});
it('restart reuses verified receipts, not external calls; missing receipt blocks rather than reruns',async()=>{
 const {request}=await create();await run(request);const before=hits;
 await env.prisma.v2ExecutionSession.update({where:{id:request.sessionId},data:{status:'RUNNING',result:undefined,leaseToken:null,leaseExpiresAt:null}});
 expect((await run(request)).verdict).toBe('pass');expect(hits).toBe(before);
 const observation=await env.prisma.v2Observation.findFirstOrThrow({where:{sessionId:request.sessionId,source:'capability-read'}});const artifact=await env.prisma.artifact.findUniqueOrThrow({where:{id:observation.evidenceArtifactIds[0]}});rmSync(join(env.artifactDir,artifact.storageKey));
 await env.prisma.v2ExecutionSession.update({where:{id:request.sessionId},data:{status:'RUNNING',leaseToken:null,leaseExpiresAt:null}});
 expect((await run(request)).verdict).toBe('blocked');expect(hits).toBe(before);
});
it('revoked pinned installation prevents dispatch, even with a newer installation',async()=>{
 const {request}=await create();await env.prisma.v2AdapterInstallation.update({where:{id:installationId},data:{status:'REVOKED'}});const before=hits;
 try{expect((await run(request)).verdict).toBe('blocked');expect(hits).toBe(before);}finally{await env.prisma.v2AdapterInstallation.update({where:{id:installationId},data:{status:'AUTHORIZED'}});}
});
it('snapshot mutation and incomplete oracle bindings produce zero calls',async()=>{
 const {request}=await create();request.snapshot.taskInput.url='http://outside.invalid';const before=hits;expect((await run(request)).verdict).toBe('blocked');expect(hits).toBe(before);
 const other=await create({assertionBindings:{}});expect((await run(other.request)).verdict).toBe('blocked');expect(hits).toBe(before);
});
it('tool budget persists and queued pause/resume selects the graph job',async()=>{
 const {request}=await create({budget:{...budget,maxToolCalls:1}});const before=hits;
 expect((await app.inject({method:'POST',url:`/api/v2/sessions/${request.sessionId}/pause`})).statusCode).toBe(200);
 expect((await app.inject({method:'POST',url:`/api/v2/sessions/${request.sessionId}/resume`})).statusCode).toBe(200);
 expect((await run(request)).verdict).toBe('blocked');expect(hits-before).toBe(1);
});

it('finding lifecycle requires independent defect reproduction and a different fixed build',async()=>{
 status=500;const first=await create({buildId:'bug-investigation'});await run(first.request);
 const finding=await env.prisma.v2Finding.findFirstOrThrow({where:{projectId,buildId:'bug-investigation'}});
 const verify=(sessionId:string,purpose:string)=>app.inject({method:'POST',url:`/api/v2/findings/${finding.id}/verify-session`,payload:{sessionId,purpose}});
 expect((await verify(first.request.sessionId,'reproduce')).statusCode).toBe(409);
 const second=await create({buildId:'bug-investigation'});await run(second.request);
 expect((await verify(second.request.sessionId,'reproduce')).json().status).toBe('reproduced');
 expect(await env.prisma.v2Finding.count({where:{projectId,buildId:'bug-investigation'}})).toBe(1);
 status=200;const fixed=await create({buildId:'fix-investigation'});await run(fixed.request);
 expect((await verify(fixed.request.sessionId,'verify_fix')).json().status).toBe('fix_verified');
 const preserved=await env.prisma.v2Finding.findUniqueOrThrow({where:{id:finding.id}});expect(preserved.firstFailure).toEqual(finding.firstFailure);
});

it('real SIGKILL during second read: original first receipt reused, interrupted read recovered',async()=>{
 const {request}=await create();probeBuildId='declared-test';const before=hits;holdAfter=hits+2;holdReached=false;
 const root=fileURLToPath(new URL('../../../',import.meta.url));
 const script=join(root,'apps/worker/test',`.tmp-loop-child-${randomUUID()}.mts`);
 writeFileSync(script,`
 import {PrismaClient} from '@prisma/client';
 import {runGraphSession} from '../src/v2/graph-session.ts';
 import {registerBuiltinSamples} from '../src/v2/samples.ts';
 const prisma=new PrismaClient({datasources:{db:{url:${JSON.stringify(env.databaseUrl)}}}});
 registerBuiltinSamples();
 await runGraphSession({prisma,...${JSON.stringify(request)},artifactDir:${JSON.stringify(env.artifactDir)}});
 await prisma.$disconnect();
 `);
 const child=spawn(process.execPath,['--import',join(root,'apps/worker/node_modules/tsx/dist/loader.mjs'),script],{cwd:root,stdio:['ignore','pipe','pipe']});let log='';child.stderr?.on('data',b=>{log+=b.toString();});
 try{
  const until=Date.now()+15000;while(!holdReached&&Date.now()<until&&child.exitCode===null)await new Promise(r=>setTimeout(r,50));
  expect(holdReached,log).toBe(true);child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));holdAfter=Infinity;
  // Use actual lease expiry, not forcibly stealing a live lease.
  const row=await env.prisma.v2ExecutionSession.findUniqueOrThrow({where:{id:request.sessionId}});
  await new Promise(r=>setTimeout(r,Math.max(1,+row.leaseExpiresAt!-Date.now()+50)));
  expect((await run(request)).verdict).toBe('pass');expect(hits-before).toBe(3);
  const intents=await env.prisma.v2ActionIntent.findMany({where:{sessionId:request.sessionId}});
  expect(await env.prisma.v2Invocation.count({where:{intentId:{in:intents.map(i=>i.id)}}})).toBe(3);
 }finally{holdAfter=Infinity;child.kill('SIGKILL');rmSync(script,{force:true});}
},30000);

it('build drift blocks the next dispatch and missing probe cannot claim verified release',async()=>{
 const {request}=await create();probeBuildId='unexpected-deployment';const before=hits;const result=await runGraphSession({prisma:env.prisma,...request,artifactDir:env.artifactDir});expect(result.verdict).toBe('blocked');expect(hits).toBe(before);probeBuildId='declared-test';
 await env.prisma.environment.update({where:{id:environmentId},data:{runtime:{}}});
 try{const other=await create();expect((await run(other.request)).verdict).toBe('pass');const report=(await app.inject({url:`/api/v2/sessions/${other.request.sessionId}`})).json();expect(report.reportVerdict).toBe('review');}finally{await env.prisma.environment.update({where:{id:environmentId},data:{runtime:{buildProbe:{path:'/build',field:'buildId'}}}});}
});

it('browser screenshots are registered as owned evidence and missing bytes degrade the report',async()=>{
 const {WebObserveManifest}=await import('@ai-qa/adapter-sdk/samples/web-observe');
 const installed=(await app.inject({method:'POST',url:`/api/v2/projects/${projectId}/capabilities/install`,payload:{manifest:WebObserveManifest}})).json();
 expect((await app.inject({method:'POST',url:`/api/v2/installations/${installed.installationId}/authorize`,payload:{scope:['read:web']}})).statusCode).toBe(200);
 const profile=(await app.inject({method:'POST',url:`/api/v2/projects/${projectId}/profiles`,payload:{key:'browser-proof',content:{capabilities:[{capabilityId:WebObserveManifest.id,version:WebObserveManifest.version,installationId:installed.installationId}],modelRoutes:{generator:'disabled',vision:'disabled',decision:'deterministic-v1'},verifierPolicy:'oracle-graph-v1',memoryPolicy:'none'}}})).json();
 await app.inject({method:'POST',url:`/api/v2/profiles/${profile.id}/publish`});
 const definition=(await app.inject({method:'POST',url:`/api/v2/projects/${projectId}/definitions`,payload:{name:'browser-evidence',nodes:[{nodeId:'verify',capabilityId:WebObserveManifest.id,capabilityVersion:WebObserveManifest.version,bindings:{baseUrl:{source:'input',path:'url',type:'string'},path:{source:'constant',value:'/',type:'string'}},dependsOn:[],onFailure:'fail'}]}})).json();
 await app.inject({method:'POST',url:`/api/v2/definitions/${definition.definitionId}/publish`});
 const {request}=await create({profileId:profile.id,definitionId:definition.definitionId});expect((await run(request)).verdict).toBe('pass');
 const screenshot=await env.prisma.artifact.findFirstOrThrow({where:{projectId,type:'SCREENSHOT',storageKey:{startsWith:request.sessionId+'/'}}});
 expect(env.store.verify(screenshot.storageKey,screenshot.checksum)).toBe(true);rmSync(join(env.artifactDir,screenshot.storageKey));
 expect((await app.inject({url:`/api/v2/sessions/${request.sessionId}`})).json().reportVerdict).toBe('review');
},30000);
