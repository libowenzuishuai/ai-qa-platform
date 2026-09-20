import { beforeAll,afterAll,it,expect } from 'vitest';
import Fastify from 'fastify';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync,writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createTestEnv,type TestEnv } from '../../api/test/helpers/db.js';
import { registerRunnerRoutes,reconcileCodeChecks } from '../../api/src/routes-runners.js';
import { sendApiError } from '../../api/src/errors.js';
const enabled=process.env.REAL_RUNNER_EVAL==='1';
const root=fileURLToPath(new URL('../../../',import.meta.url));
let env:TestEnv,app:ReturnType<typeof Fastify>,base:string,actor:any;
const evidence:any[]=[];
beforeAll(async()=>{
 if(!enabled)return;
 if(!/^[a-f0-9]{40}$/.test(process.env.AIQA_RUNNER_FIXTURE_SHA??''))throw new Error('指定已上传的完整夹具 SHA');
 env=await createTestEnv('runner-e2e');app=Fastify();
 actor=await env.prisma.user.create({data:{username:randomUUID(),displayName:'Runner eval',passwordHash:'unused',platformRole:'LEAD'}});
 app.addHook('onRequest',async req=>{req.auth={userId:actor.id,username:actor.username,displayName:actor.displayName,platformRole:'LEAD'};});
 app.setErrorHandler((e,req,reply)=>sendApiError(req,reply,e));registerRunnerRoutes(app,env.prisma,env.store);
 base=await app.listen({host:'127.0.0.1',port:0});
},30000);
afterAll(async()=>{if(!enabled)return;mkdirSync(root+'data/pilot-evidence',{recursive:true});writeFileSync(root+'data/pilot-evidence/runner-e2e.json',JSON.stringify({source:'real public GitHub download; synthetic test fixtures; actual CLI, Docker and API',evaluations:evidence},null,2));await app?.close();await env?.cleanup();});
async function post(url:string,payload:any,headers={}){const r=await app.inject({method:'POST',url,payload,headers});expect(r.statusCode,r.body).toBe(200);return r.json();}
for(const [kind,name,verdict] of [['NODE_TEST','node-pass','PASS'],['NODE_TEST','node-fail','FAIL'],['PYTHON_TEST','python-pass','PASS'],['PYTHON_TEST','python-fail','FAIL']] as const){
 it.skipIf(!enabled)(`GitHub → runner CLI → ${name} → ${verdict}`,async()=>{
  const project=await env.prisma.project.create({data:{name,memberships:{create:{userId:actor.id,role:'ADMIN'}}}});
  const r=await post(`/api/projects/${project.id}/runners`,{name:'real local runner',capabilities:[kind]});
  const check=await post(`/api/projects/${project.id}/code-checks`,{repositoryUrl:'https://github.com/libowenzuishuai/ai-qa-platform',commitSha:process.env.AIQA_RUNNER_FIXTURE_SHA,subdirectory:`tests-golden/runner-projects/${name}`,kind,timeoutSeconds:120});
  const child=spawn(root+'services/intelligence/.venv/bin/python',[root+'tools/self-hosted-runner/runner.py','--once'],{env:{PATH:process.env.PATH,HOME:process.env.HOME,DOCKER_HOST:process.env.DOCKER_HOST,SSL_CERT_FILE:process.env.SSL_CERT_FILE,AIQA_PLATFORM_URL:base,AIQA_RUNNER_TOKEN:r.token,AIQA_RUNNER_PYTHON_IMAGE:process.env.AIQA_RUNNER_PYTHON_IMAGE??'aiqa-python-test:local'},stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',b=>logs+=b.toString());child.stderr.on('data',b=>logs+=b.toString());
  const exit=await new Promise<number|null>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('Runner CLI exceeded timeout'));},140000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve(code);});});expect(exit,logs).toBe(0);
  const finished=await env.prisma.codeCheck.findUniqueOrThrow({where:{id:check.id}});
  evidence.push({kind,request:check.request,status:finished.status,verdict:finished.verdict,result:finished.result});
  expect(finished.status,JSON.stringify(finished.result)).toBe('FINISHED');expect(finished.verdict).toBe(verdict);
  const artifact=await env.prisma.artifact.findUniqueOrThrow({where:{id:finished.evidenceId!}});expect(env.store.verify(artifact.storageKey,artifact.checksum)).toBe(true);
 },150000);
}
it.skipIf(!enabled)('取消、过期和跨项目结果无法覆盖终态',async()=>{
 const project=await env.prisma.project.create({data:{name:'cancel',memberships:{create:{userId:actor.id,role:'ADMIN'}}}});
 const other=await env.prisma.project.create({data:{name:'other',memberships:{create:{userId:actor.id,role:'ADMIN'}}}});
 const r=await post(`/api/projects/${project.id}/runners`,{name:'a',capabilities:['NODE_TEST']});const b=await post(`/api/projects/${other.id}/runners`,{name:'b',capabilities:['NODE_TEST']});
 const headers={authorization:`Bearer ${r.token}`};const otherHeaders={authorization:`Bearer ${b.token}`};
 const queued=await post(`/api/projects/${project.id}/code-checks`,{repositoryUrl:'https://github.com/libowenzuishuai/ai-qa-platform',commitSha:process.env.AIQA_RUNNER_FIXTURE_SHA,kind:'NODE_TEST'});
 expect((await post('/api/runner/claim',{},otherHeaders)).task).toBeNull();
 const owned=(await post('/api/runner/claim',{},headers)).task;
 await post(`/api/code-checks/${queued.id}/cancel`,{});expect((await post(`/api/runner/tasks/${queued.id}/heartbeat`,{leaseToken:owned.leaseToken},headers)).continue).toBe(false);
 await env.prisma.codeCheck.update({where:{id:queued.id},data:{leaseExpiresAt:new Date(0)}});await reconcileCodeChecks(env.prisma);
 expect((await env.prisma.codeCheck.findUniqueOrThrow({where:{id:queued.id}})).status).toBe('CANCELLED');
 const payload={leaseToken:owned.leaseToken,result:{commitSha:process.env.AIQA_RUNNER_FIXTURE_SHA,exitCode:0,cases:[{name:'forged',status:'PASS'}],output:''}};
 for(const auth of [headers,otherHeaders])expect((await app.inject({method:'POST',url:`/api/runner/tasks/${queued.id}/result`,headers:auth,payload})).statusCode).toBe(409);
});
