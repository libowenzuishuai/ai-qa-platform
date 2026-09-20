import { afterAll, beforeAll, afterEach, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { registerAuth } from '../src/auth.js';
import { sendApiError } from '../src/errors.js';
import { registerJobRoutes } from '../src/routes-jobs.js';
import { createTestEnv, type TestEnv } from './helpers/db.js';

let env: TestEnv, app: FastifyInstance, projectId: string, docId: string;
let offline = true;
const add = vi.fn(async () => { if (offline) throw new Error('Redis unavailable'); return {} as never; });
beforeAll(async()=>{
 env=await createTestEnv('stage2api');
 const user=await env.prisma.user.create({data:{username:'stage2-test',displayName:'Test',passwordHash:'unused',platformRole:'LEAD'}});
 const project=await env.prisma.project.create({data:{name:'stage2 API'}});projectId=project.id;
 await env.prisma.projectMembership.create({data:{projectId,userId:user.id,role:'LEAD'}});
 await env.prisma.session.create({data:{id:'stage2-session',userId:user.id,expiresAt:new Date(Date.now()+600000)}});
 const doc=await env.prisma.document.create({data:{projectId,title:'test'}});
 docId=(await env.prisma.documentVersion.create({data:{documentId:doc.id,version:1,checksum:'x',storageKey:'x',format:'MARKDOWN',parseStatus:'PARSED'}})).id;
 app=Fastify(); await app.register(cookie);registerAuth(app,env.prisma,600);
 app.setErrorHandler((e,req,reply)=>sendApiError(req,reply,e));
 registerJobRoutes(app,env.prisma,{add});
});
afterEach(()=>vi.unstubAllEnvs());
afterAll(async()=>{await app?.close();await env?.cleanup();});
function post(mode='mock') {return app.inject({method:'POST',url:`/api/projects/${projectId}/rule-extractions`,headers:{cookie:'aiqa_sid=stage2-session'},payload:{documentVersionIds:[docId],mode}});}
it('显式 reference 作业 HTTP：模型缺配置返回 503/MODEL_NOT_CONFIGURED',async()=>{
 vi.stubEnv('AIQA_INTELLIGENCE_BACKEND','reference');
 vi.stubEnv('AIQA_TEXT_PROVIDER','');
 const res=await post('real');expect(res.statusCode).toBe(503);
 expect(res.json()).toMatchObject({code:'MODEL_NOT_CONFIGURED',requestId:expect.any(String)});
 expect(await env.prisma.job.count()).toBe(0);
});
it('入队失败仍可靠保存，重复提交同一作业时补投',async()=>{
 offline=true; const first=await post();expect(first.statusCode).toBe(202);
 const id=first.json().jobId;
 expect((await env.prisma.job.findUniqueOrThrow({where:{id}})).status).toBe('QUEUED');
 const before=add.mock.calls.length;offline=false;
 const second=await post();expect(second.statusCode).toBe(200);expect(second.json().jobId).toBe(id);
 expect(add.mock.calls.length).toBe(before+1);expect(await env.prisma.job.count()).toBe(1);
});
it('失败作业显式重试，活跃/成功作业不可重试，未登录被拒绝',async()=>{
 const job=await env.prisma.job.findFirstOrThrow();
 const url=`/api/jobs/${job.id}/retry`;
 expect((await app.inject({method:'POST',url})).statusCode).toBe(401);
 const request={method:'POST' as const,url,headers:{cookie:'aiqa_sid=stage2-session'}};
 expect((await app.inject(request)).statusCode).toBe(409);
 await env.prisma.job.update({where:{id:job.id},data:{status:'FAILED',error:{code:'INTERNAL'},finishedAt:new Date()}});
 const responses=await Promise.all([app.inject(request),app.inject(request)]);
 expect(responses.map(r=>r.statusCode).sort()).toEqual([202,409]);
 const updated=await env.prisma.job.findUniqueOrThrow({where:{id:job.id}});
 expect(updated).toMatchObject({status:'QUEUED',startedAt:null,finishedAt:null,error:null,result:null});
});

it('默认 Python 后端无需 API 进程持有模型凭据即可可靠入队 real 作业', async()=>{
 vi.stubEnv('AIQA_INTELLIGENCE_BACKEND',undefined);
 vi.stubEnv('AIQA_TEXT_PROVIDER','');
 const res=await post('real');expect(res.statusCode).toBe(202);
 expect((await env.prisma.job.findUniqueOrThrow({where:{id:res.json().jobId}})).status).toBe('QUEUED');
});
