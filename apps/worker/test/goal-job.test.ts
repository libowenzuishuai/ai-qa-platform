import {beforeAll,afterAll,it,expect} from 'vitest';
import Fastify from 'fastify';
import {spawn,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createTestEnv,type TestEnv} from '../../api/test/helpers/db.js';
import {registerReleaseRoutes} from '../../api/src/routes-release.js';
import {registerJobRoutes} from '../../api/src/routes-jobs.js';
import {installBuiltinTemplates} from '../../api/src/template-runtime.js';
import {sendApiError} from '../../api/src/errors.js';
import {WorkerConfig} from '../src/config.js';
import {processAgentJob} from '../src/agent-job-processor.js';
const root=fileURLToPath(new URL('../../../',import.meta.url)),app=Fastify(),token=randomUUID();
let env:TestEnv,python:ChildProcess,url='',projectId='';const queue={add:async()=>{throw new Error('simulate queue outage');}};
beforeAll(async()=>{
 env=await createTestEnv('goals');const actor=await env.prisma.user.create({data:{username:randomUUID(),displayName:'规划测试',passwordHash:'unused',platformRole:'ADMIN'}});
 projectId=(await env.prisma.project.create({data:{name:'目标规划',memberships:{create:{userId:actor.id,role:'ADMIN'}}}})).id;
 app.addHook('onRequest',async req=>{req.auth={userId:actor.id,username:actor.username,displayName:actor.displayName,platformRole:'ADMIN'};});
 app.setErrorHandler((e,q,r)=>sendApiError(q,r,e));registerReleaseRoutes(app,env.prisma,env.store,queue);registerJobRoutes(app,env.prisma,queue);
 await env.prisma.$transaction(tx=>installBuiltinTemplates(tx,projectId,actor.id));
 const path=join(env.artifactDir,'gateway.py');writeFileSync(path,`import os,json,uvicorn
from aiqa_intelligence.app import create_app
from aiqa_intelligence.models import Gateway
class ProtocolGateway(Gateway):
    async def complete_text(self, request):
        data=json.loads(request.user)
        self.register_mock(request, {'suggestedTools':[{'capabilityKey':'ghost' if data['goal']=='invalid' else 'code-check','reason':'没有资料，先做工程检查'}],'suggestedBudget':{},'blockers':[{'kind':'MISSING_DATA','description':'尚缺完整 PRD'}],'rationale':'在现有能力与资料范围内提出建议'})
        return await super().complete_text(request)
uvicorn.run(create_app(token=os.environ['AIQA_INTELLIGENCE_TOKEN'],gateway_factory=ProtocolGateway),host='127.0.0.1',port=0)
`);
 python=spawn(root+'services/intelligence/.venv/bin/python',[path],{env:{...process.env,PYTHONPATH:root+'services/intelligence/src',AIQA_INTELLIGENCE_TOKEN:token},stdio:['ignore','pipe','pipe']});
 url=await new Promise((resolve,reject)=>{let log='';const timer=setTimeout(()=>reject(new Error(log)),15000);const on=(b:Buffer)=>{log+=b;const m=/Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/.exec(log);if(m){clearTimeout(timer);resolve(m[1]!);}};python.stdout!.on('data',on);python.stderr!.on('data',on);});
},30000);
afterAll(async()=>{python?.kill();await app.close();await env?.cleanup();});
const config=()=>WorkerConfig.parse({databaseUrl:env.databaseUrl,redisUrl:'redis://127.0.0.1:1',artifactDir:env.artifactDir,intelligenceBackend:'python',intelligenceUrl:url,intelligenceToken:token});
const propose=(key:string,goal='检查项目')=>app.inject({method:'POST',url:`/api/projects/${projectId}/goal-proposals/propose`,payload:{goal,idempotencyKey:key,documentVersionIds:[],mode:'mock'}});
it('排队失败保留 durable job，真实 Python 管线返回草稿，重复提交幂等',async()=>{
 const [a,b]=await Promise.all([propose('goal-test-0001'),propose('goal-test-0001')]);expect(a.statusCode,a.body).toBe(202);expect(b.json().jobId).toBe(a.json().jobId);
 await processAgentJob(env.prisma,config(),a.json().jobId);
 const job=await env.prisma.job.findUniqueOrThrow({where:{id:a.json().jobId}});expect(job.status,JSON.stringify(job.error)).toBe('SUCCEEDED');
 const rows=await env.prisma.goalProposal.findMany({where:{projectId}});expect(rows).toHaveLength(1);expect(rows[0]!.status).toBe('DRAFT');expect((rows[0]!.suggestedScope as any).mode).toBe('mock');
 expect(await env.prisma.modelInvocation.count({where:{projectId}})).toBe(1);
 expect((await app.inject({url:`/api/jobs/${job.id}`})).statusCode).toBe(200);
});
it('非法模型工具拒绝；排队期间上下文改变后拒绝调用；取消不能复活',async()=>{
 const invalid=await propose('goal-invalid-001','invalid');await processAgentJob(env.prisma,config(),invalid.json().jobId);
 expect((await env.prisma.job.findUniqueOrThrow({where:{id:invalid.json().jobId}})).status).toBe('FAILED');
 const changed=await propose('goal-changed-001');await env.prisma.capabilityCatalog.updateMany({where:{projectId,key:'code-check'},data:{enabled:false}});
 await processAgentJob(env.prisma,config(),changed.json().jobId);expect((await env.prisma.job.findUniqueOrThrow({where:{id:changed.json().jobId}})).error).toMatchObject({code:'CONFLICT'});
 const cancelled=await propose('goal-cancelled-001');expect((await app.inject({method:'POST',url:`/api/jobs/${cancelled.json().jobId}/cancel`})).statusCode).toBe(200);
 await processAgentJob(env.prisma,config(),cancelled.json().jobId);expect((await env.prisma.job.findUniqueOrThrow({where:{id:cancelled.json().jobId}})).status).toBe('CANCELLED');
 expect(await env.prisma.goalProposal.count({where:{projectId}})).toBe(1);
});
