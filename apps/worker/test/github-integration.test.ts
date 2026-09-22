import {beforeAll,afterAll,it,expect} from 'vitest';
import Fastify from 'fastify';
import {createHmac,generateKeyPairSync,randomUUID,createVerify} from 'node:crypto';
import {createTestEnv,type TestEnv} from '../../api/test/helpers/db.js';
import {registerGithubRoutes} from '../../api/src/routes-github.js';
import {registerWorkflowRoutes} from '../../api/src/routes-workflow.js';
import {registerRunnerRoutes} from '../../api/src/routes-runners.js';
import {GitHubApp,privateRepositoryFetch,privateSourceArchive} from '../../api/src/github-app.js';
import {sendApiError} from '../../api/src/errors.js';
import {installBuiltinTemplates} from '../../api/src/template-runtime.js';
import {advanceGitHubDelivery} from '../src/github-ci.js';
import {advanceWorkflow} from '../src/workflow-orchestrator.js';
const app=Fastify(),remote=Fastify(),keys=generateKeyPairSync('rsa',{modulusLength:2048}),sha='a'.repeat(40),secret=randomUUID();
let env:TestEnv,provider:GitHubApp,projectId='',actor:any,integrationId='',templateId='',remoteUrl='',runnerToken='',currentSha=sha,failWrite=false,rateLimit=false;
const checks:any[]=[],issued:any[]=[],requests:string[]=[];
beforeAll(async()=>{
 env=await createTestEnv('github');actor=await env.prisma.user.create({data:{username:randomUUID(),displayName:'GitHub 测试',passwordHash:'unused',platformRole:'LEAD'}});
 projectId=(await env.prisma.project.create({data:{name:'Github',memberships:{create:{userId:actor.id,role:'ADMIN'}}}})).id;
 await env.prisma.$transaction(async tx=>{const templates=await installBuiltinTemplates(tx,projectId,actor.id);templateId=templates.find(t=>t.key==='engineering-check')!.id;});
 remote.all('/*',async(req,reply)=>{
  requests.push(req.url);const path=req.url.split('?')[0]!,body=req.body as any;
  if(rateLimit)return reply.code(429).send({message:'limited'});
  if(path==='/login/oauth/access_token')return {access_token:'fixture-user-token'};
  if(path==='/user')return {id:99};
  if(path==='/repos/team/project/installation')return {id:7,app_id:123,suspended_at:null};
  if(path==='/app/installations/7/access_tokens'){
   const jwt=req.headers.authorization!.slice(7),[header,payload,signature]=jwt.split('.');expect(createVerify('RSA-SHA256').update(header+'.'+payload).verify(keys.publicKey,Buffer.from(signature!,'base64url'))).toBe(true);
   expect(body.repository_ids).toEqual([42]);issued.push(body);return {token:'fixture-installation-token',expires_at:new Date(Date.now()+3600000).toISOString(),repositories:[{id:42}]};
  }
  if(path==='/repos/team/project')return {id:42,full_name:'team/project',permissions:{admin:true},private:true};
  if(path==='/repos/team/project/git/ref/heads/main')return {object:{sha:currentSha}};
  if(path.includes('/commits/')&&path.endsWith('/check-runs'))return {check_runs:checks};
  if(path==='/repos/team/project/check-runs'){
   checks.push({...body,id:checks.length+10});if(failWrite){failWrite=false;return reply.code(503).send({message:'response lost after write'});}return checks.at(-1);
  }
  if(path.startsWith('/repos/team/project/git/'))return {ok:true};
  if(path.startsWith('/repos/team/project/tarball/'))return reply.code(302).header('location',`https://codeload.github.com/team/project/legacy.tar.gz/${sha}`).send();
  if(path.startsWith('/team/project/legacy.tar.gz/'))return reply.type('application/gzip').send(Buffer.from('archive-protocol-fixture'));
  return reply.code(404).send({message:'not found'});
 });
 await remote.listen({host:'127.0.0.1',port:0});remoteUrl=`http://127.0.0.1:${(remote.server.address() as any).port}`;
 provider=new GitHubApp({appId:'123',clientId:'client',clientSecret:'fixture-secret',privateKey:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),webhookSecret:secret,callbackUrl:'http://127.0.0.1:7840/github/callback'},async(input,init)=>{const url=new URL(String(input));return fetch(remoteUrl+url.pathname+url.search,init);});
 app.addHook('onRequest',async req=>{if(!req.url.endsWith('/webhook'))req.auth={userId:actor.id,username:actor.username,displayName:actor.displayName,platformRole:'LEAD'};});
 app.setErrorHandler((e,q,r)=>sendApiError(q,r,e));registerGithubRoutes(app,env.prisma,()=>provider);registerWorkflowRoutes(app,env.prisma);registerRunnerRoutes(app,env.prisma,env.store,()=>provider);await app.ready();
 runnerToken=(await app.inject({method:'POST',url:`/api/projects/${projectId}/runners`,payload:{name:'隔离 CI 测试对端',capabilities:['NODE_TEST']}})).json().token;
},30000);
afterAll(async()=>{await app.close();await remote.close();await env?.cleanup();});
async function connect(){const start=await app.inject({method:'POST',url:`/api/projects/${projectId}/github/connect`,payload:{repository:'team/project'}});expect(start.statusCode,start.body).toBe(200);const state=new URL(start.json().authorizationUrl).searchParams.get('state');const callback=await app.inject({method:'POST',url:'/api/github/callback',payload:{state,code:'fixture-code'}});expect(callback.statusCode,callback.body).toBe(200);integrationId=callback.json().integration.id;return state;}
async function configure(){const res=await app.inject({method:'PUT',url:`/api/github/${integrationId}/ci`,payload:{enabled:true,branch:'main',templateId,kind:'NODE_TEST',subdirectory:'',timeoutSeconds:60}});expect(res.statusCode,res.body).toBe(200);}
function webhook(delivery:string,body:any,event='push',signed=true){const raw=JSON.stringify(body);return app.inject({method:'POST',url:'/api/github/webhook',headers:{'content-type':'application/json','x-github-delivery':delivery,'x-github-event':event,'x-hub-signature-256':'sha256='+(signed?createHmac('sha256',secret).update(raw).digest('hex'):'0'.repeat(64))},payload:raw});}
const push=(value=sha)=>({installation:{id:7},repository:{id:42},ref:'refs/heads/main',after:value});
it('授权回调验证 state/用户/仓库范围，一次使用；不保存模型或仓库凭据',async()=>{
 const state=await connect();expect((await app.inject({method:'POST',url:'/api/github/callback',payload:{state,code:'again'}})).statusCode).toBe(403);
 expect((await app.inject({method:'POST',url:'/api/github/callback',payload:{state:'0'.repeat(64),code:'forged'}})).statusCode).toBe(403);
 await configure();const stored=await env.prisma.githubIntegration.findUniqueOrThrow({where:{id:integrationId}});expect(JSON.stringify(stored)).not.toContain('fixture-installation-token');expect(issued[0].permissions).toEqual({contents:'read',metadata:'read'});
});
it('伪签名拒绝；并发重复 delivery 仅一条；同 id 不同正文拒绝；fork/错分支不执行',async()=>{
 expect((await webhook('bad',push(),'push',false)).statusCode).toBe(403);
 const r=await Promise.all([webhook('once',push()),webhook('once',push())]);expect(r.map(x=>x.statusCode)).toEqual([202,202]);expect(await env.prisma.githubDelivery.count({where:{deliveryId:'once:'+integrationId}})).toBe(1);
 expect((await webhook('once',push('b'.repeat(40)))).statusCode).toBe(409);
 expect((await webhook('fork',{...push(),action:'opened',number:1,pull_request:{head:{repo:{id:43},sha},base:{ref:'main'}}},'pull_request')).statusCode).toBe(202);
 await webhook('branch',{...push(),ref:'refs/heads/other'});expect(await env.prisma.githubDelivery.count({where:{status:'IGNORED'}})).toBe(2);
});
it('真实 HTTP 固定 SHA → 已发布工作流 → runner 协议结果 → Checks；重复推进不再创建',async()=>{
 const delivery=await env.prisma.githubDelivery.findUniqueOrThrow({where:{deliveryId:'once:'+integrationId}});
 await advanceGitHubDelivery(env.prisma,env.store,delivery.id,provider);const waiting=await env.prisma.githubDelivery.findUniqueOrThrow({where:{id:delivery.id}});expect(waiting.status,waiting.detail??'').toBe('WAITING');expect(waiting.workflowId).toBeTruthy();
 await advanceWorkflow(env.prisma,waiting.workflowId!,env.store);const claimed=(await app.inject({method:'POST',url:'/api/runner/claim',headers:{authorization:'Bearer '+runnerToken},payload:{}})).json().task;expect(claimed.request.commitSha).toBe(sha);expect(claimed.sourceViaPlatform).toBe(true);
 const source=await app.inject({method:'POST',url:`/api/runner/tasks/${claimed.id}/source`,headers:{authorization:'Bearer '+runnerToken},payload:{leaseToken:claimed.leaseToken}});expect(source.statusCode,source.body).toBe(200);expect(source.headers['x-source-commit']).toBe(sha);
 const submitted=await app.inject({method:'POST',url:`/api/runner/tasks/${claimed.id}/result`,headers:{authorization:'Bearer '+runnerToken},payload:{leaseToken:claimed.leaseToken,result:{commitSha:sha,exitCode:0,cases:[{name:'protocol fixture',status:'PASS'}],output:'protocol fixture only'}}});expect(submitted.statusCode,submitted.body).toBe(200);
 for(let n=0;n<3;n++)await advanceWorkflow(env.prisma,waiting.workflowId!,env.store);
 await advanceGitHubDelivery(env.prisma,env.store,delivery.id,provider);const done=await env.prisma.githubDelivery.findUniqueOrThrow({where:{id:delivery.id}});expect(done.status,done.detail??'').toBe('COMPLETED');expect(checks).toHaveLength(1);expect(checks[0].head_sha).toBe(sha);expect(checks[0].conclusion).toBe('success');
 await advanceGitHubDelivery(env.prisma,env.store,delivery.id,provider);expect(checks).toHaveLength(1);
});
it('乱序事件不测试旧提交；限流明确失败；Checks 写入未知经显式重试对账不重复',async()=>{
 await webhook('old',push('b'.repeat(40)));let row=await env.prisma.githubDelivery.findUniqueOrThrow({where:{deliveryId:'old:'+integrationId}});await advanceGitHubDelivery(env.prisma,env.store,row.id,provider);expect((await env.prisma.githubDelivery.findUniqueOrThrow({where:{id:row.id}})).status).toBe('IGNORED');
 await webhook('limited',push());row=await env.prisma.githubDelivery.findUniqueOrThrow({where:{deliveryId:'limited:'+integrationId}});rateLimit=true;await advanceGitHubDelivery(env.prisma,env.store,row.id,provider);rateLimit=false;expect((await env.prisma.githubDelivery.findUniqueOrThrow({where:{id:row.id}})).detail).toContain('限流');
 // Reuse completed workflow in this outbox recovery test, with a new external_id.
 const done=await env.prisma.githubDelivery.findUniqueOrThrow({where:{deliveryId:'once:'+integrationId}});await env.prisma.githubDelivery.update({where:{id:row.id},data:{status:'QUEUED',workflowId:done.workflowId}});failWrite=true;await advanceGitHubDelivery(env.prisma,env.store,row.id,provider);expect((await env.prisma.githubDelivery.findUniqueOrThrow({where:{id:row.id}})).status).toBe('WRITE_UNCERTAIN');expect(checks).toHaveLength(2);
 expect((await app.inject({method:'POST',url:`/api/github/deliveries/${row.id}/retry`})).statusCode).toBe(200);await advanceGitHubDelivery(env.prisma,env.store,row.id,provider);expect(checks).toHaveLength(2);expect((await env.prisma.githubDelivery.findUniqueOrThrow({where:{id:row.id}})).status).toBe('COMPLETED');
});
it('私库读取不越仓库、不向外站转发凭据；撤销后阻止同步和排队 CI',async()=>{
 const f=privateRepositoryFetch(env.prisma,projectId,integrationId,provider);
 await expect(f('https://api.github.com/repos/another/project/git/x')).rejects.toMatchObject({code:'FORBIDDEN'});await expect(f('https://outside.test/repos/team/project/x')).rejects.toMatchObject({code:'FORBIDDEN'});
 await webhook('pending',push());expect((await webhook('revoke',{installation:{id:7},action:'deleted'},'installation')).statusCode).toBe(200);
 await expect(f('https://api.github.com/repos/team/project/git/x')).rejects.toMatchObject({code:'FORBIDDEN'});
 const pending=await env.prisma.githubDelivery.findUniqueOrThrow({where:{deliveryId:'pending:'+integrationId}});expect(pending.status).toBe('IGNORED');expect((await env.prisma.githubIntegration.findUniqueOrThrow({where:{id:integrationId}})).status).toBe('REVOKED');
});
it('旧撤销事件重放不撤销新授权；配置变更取消旧 CI；手动私库任务也随撤销停止',async()=>{
 await connect();await configure();
 await webhook('revoke',{installation:{id:7},action:'deleted'},'installation');
 expect((await env.prisma.githubIntegration.findUniqueOrThrow({where:{id:integrationId}})).status).toBe('ACTIVE');
 expect((await webhook('revoke',{installation:{id:7},action:'suspend'},'installation')).statusCode).toBe(409);
 await webhook('config-cancel',push());const d=await env.prisma.githubDelivery.findUniqueOrThrow({where:{deliveryId:'config-cancel:'+integrationId}});
 await advanceGitHubDelivery(env.prisma,env.store,d.id,provider);const wf=(await env.prisma.githubDelivery.findUniqueOrThrow({where:{id:d.id}})).workflowId!;
 await configure();expect((await env.prisma.workflowRun.findUniqueOrThrow({where:{id:wf}})).status).toBe('CANCELLED');
 const spec={repositoryUrl:'https://github.com/team/project.git',commitSha:sha,kind:'NODE_TEST',timeoutSeconds:60,installDependencies:false,subdirectory:''};
 const queued=await env.prisma.codeCheck.create({data:{projectId,request:spec,createdBy:actor.id}});
 const running=await env.prisma.codeCheck.create({data:{projectId,request:spec,status:'RUNNING',createdBy:actor.id}});
 await webhook('revoke-new',{installation:{id:7},action:'deleted'},'installation');
 expect((await env.prisma.codeCheck.findUniqueOrThrow({where:{id:queued.id}})).status).toBe('CANCELLED');
 expect((await env.prisma.codeCheck.findUniqueOrThrow({where:{id:running.id}})).status).toBe('CANCEL_REQUESTED');
});
