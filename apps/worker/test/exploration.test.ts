import {beforeAll,afterAll,it,expect} from 'vitest';
import Fastify from 'fastify';
import {randomUUID} from 'node:crypto';
import {createTestEnv,type TestEnv} from '../../api/test/helpers/db.js';
import {registerReleaseRoutes} from '../../api/src/routes-release.js';
import {registerJobRoutes} from '../../api/src/routes-jobs.js';
import {sendApiError} from '../../api/src/errors.js';
import {processAgentJob} from '../src/agent-job-processor.js';
import {WorkerConfig} from '../src/config.js';
const app=Fastify(),site=Fastify(),outside=Fastify();let env:TestEnv,projectId='',environmentId='',url='',outsideUrl='',outsideHits=0,sideEffects=0;
beforeAll(async()=>{
 env=await createTestEnv('explore');const actor=await env.prisma.user.create({data:{username:randomUUID(),displayName:'探索测试',passwordHash:'unused',platformRole:'LEAD'}});
 projectId=(await env.prisma.project.create({data:{name:'只读探索',memberships:{create:{userId:actor.id,role:'ADMIN'}}}})).id;
 outside.all('/*',async()=>{outsideHits++;return 'outside';});await outside.listen({host:'127.0.0.1',port:0});outsideUrl=`http://127.0.0.1:${(outside.server.address() as any).port}`;
 site.all('/write',async()=>{sideEffects++;return 'written';});site.get('/redirect',async(_q,r)=>r.redirect(outsideUrl+'/blocked'));
 site.get('/slow',async(_q,r)=>{await new Promise(resolve=>setTimeout(resolve,1600));return r.type('text/html').send('<p>slow</p>');});
 site.get('/login',async(_q,r)=>r.type('text/html').send('<h1>登录</h1><input type="password">'));
 site.get('/*',async(_q,r)=>r.type('text/html').send(`<h1>采购管理</h1><p>订单入口</p><script>fetch('/write',{method:'POST'});fetch('${outsideUrl}/steal')</script><iframe src='/write'></iframe><img src='${outsideUrl}/image'><form method='post' action='/write'><button>提交</button></form><a href='/orders'>订单</a>`));
 await site.listen({host:'127.0.0.1',port:0});url=`http://127.0.0.1:${(site.server.address() as any).port}`;
 environmentId=(await env.prisma.environment.create({data:{projectId,name:'隔离站点',baseUrl:url,allowedOrigins:[url]}})).id;
 app.addHook('onRequest',async req=>{req.auth={userId:actor.id,username:actor.username,displayName:actor.displayName,platformRole:'LEAD'};});app.setErrorHandler((e,q,r)=>sendApiError(q,r,e));const queue={add:async()=>{}};registerReleaseRoutes(app,env.prisma,env.store,queue);registerJobRoutes(app,env.prisma,queue);
},30000);
afterAll(async()=>{await app.close();site.server.closeAllConnections();outside.server.closeAllConnections();await site.close();await outside.close();await env?.cleanup();});
const config=()=>WorkerConfig.parse({databaseUrl:env.databaseUrl,redisUrl:'redis://127.0.0.1:1',artifactDir:env.artifactDir});
async function start(paths:string[],extra:any={}){const result=await app.inject({method:'POST',url:`/api/projects/${projectId}/explorations`,payload:{environmentId,idempotencyKey:randomUUID(),paths,...extra}});expect(result.statusCode,result.body).toBe(202);await processAgentJob(env.prisma,config(),result.json().jobId);return env.prisma.job.findUniqueOrThrow({where:{id:result.json().jobId}});}
it('真实浏览器静态探索有证据；脚本、表单、iframe 和外站均零请求，不生成批准资产',async()=>{
 const job=await start(['/']);expect(job.status,JSON.stringify(job.error)).toBe('SUCCEEDED');expect(job.result).toMatchObject({pageCount:1,stopReason:'COMPLETED'});
 const artifact=await env.prisma.artifact.findUniqueOrThrow({where:{id:(job.result as any).artifactId}});expect(artifact.sensitivity).toBe('RESTRICTED_RAW');const result=JSON.parse(env.store.read(artifact.storageKey).toString());expect(result.pages[0].candidates).toContainEqual({text:'订单',path:'/orders',approved:false});
 expect(outsideHits).toBe(0);expect(sideEffects).toBe(0);expect(await env.prisma.rule.count({where:{projectId}})).toBe(0);
 expect((await app.inject({url:'/api/jobs/'+job.id})).statusCode).toBe(200);
});
it('越界跳转、登录、无新信息及时间预算明确停止；已取消任务不复活',async()=>{
 expect((await start(['/redirect'])).result).toMatchObject({stopReason:'SCOPE_BLOCKED',pageCount:0});expect(outsideHits).toBe(0);
 expect((await start(['/login'])).result).toMatchObject({stopReason:'AUTH_REQUIRED'});
 expect((await start(['/a','/b','/c','/d'])).result).toMatchObject({stopReason:'NO_PROGRESS',pageCount:3});
 expect((await start(['/slow'],{maxDurationMs:1000})).result).toMatchObject({stopReason:'BUDGET_EXCEEDED'});
 const queued=await app.inject({method:'POST',url:`/api/projects/${projectId}/explorations`,payload:{environmentId,idempotencyKey:randomUUID(),paths:['/']}});
 expect((await app.inject({method:'POST',url:'/api/jobs/'+queued.json().jobId+'/cancel'})).statusCode).toBe(200);
 await processAgentJob(env.prisma,config(),queued.json().jobId);expect((await env.prisma.job.findUniqueOrThrow({where:{id:queued.json().jobId}})).status).toBe('CANCELLED');
},30000);
