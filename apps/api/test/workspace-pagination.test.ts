import {beforeAll,afterAll,it,expect} from 'vitest';
import Fastify from 'fastify';
import {randomUUID} from 'node:crypto';
import {createTestEnv,seedMinimalAssets,type TestEnv} from './helpers/db.js';
import {registerProductRoutes} from '../src/routes-product.js';
import {registerReviewRoutes} from '../src/routes-review.js';
import {sendApiError} from '../src/errors.js';
const app=Fastify();let env:TestEnv,projectId='';
beforeAll(async()=>{
 env=await createTestEnv('paging');const assets=await seedMinimalAssets(env.prisma,env.store);projectId=assets.projectId;
 const actor=await env.prisma.user.create({data:{username:randomUUID(),displayName:'分页验证',passwordHash:'unused',platformRole:'LEAD'}});await env.prisma.projectMembership.create({data:{projectId,userId:actor.id,role:'ADMIN'}});
 app.addHook('onRequest',async req=>{req.auth={userId:actor.id,username:actor.username,displayName:actor.displayName,platformRole:'LEAD'};});app.setErrorHandler((e,q,r)=>sendApiError(q,r,e));registerProductRoutes(app,env.prisma,env.store,{add:async()=>{}} as any,{add:async()=>{}} as any);registerReviewRoutes(app,env.prisma);
 const source=await env.prisma.testCaseVersion.findUniqueOrThrow({where:{id:assets.caseVersionId}});await env.prisma.testCaseVersion.createMany({data:Array.from({length:204},(_,i)=>({...source,id:randomUUID(),version:i+2,approvalStatus:i===203?'APPROVED':'DRAFT'}))});
 await env.prisma.job.createMany({data:Array.from({length:205},(_,i)=>({projectId,kind:'TEST_FIXTURE',request:{},fingerprint:'page-'+i}))});
},30000);
afterAll(async()=>{await app.close();await env?.cleanup();});
it('超过旧 200 条限制全部可达；全量最新版本统计不被旧草稿或翻页影响',async()=>{
 const cases=new Set<string>(),jobs=new Set<string>();
 for(let page=1;page<=7;page++){
  const r=await app.inject({url:`/api/projects/${projectId}/review?page=${page}`});expect(r.statusCode,r.body).toBe(200);const d=r.json();expect(d.totals.cases).toBe(205);expect(d.totalPages).toBe(7);d.cases.forEach((x:any)=>cases.add(x.id));d.jobs.forEach((x:any)=>jobs.add(x.id));
  const w=await app.inject({url:`/api/projects/${projectId}/workspace?page=${page}`});expect(w.statusCode,w.body).toBe(200);expect(w.json().metrics).toMatchObject({drafts:0,approved:1,latestCases:1});expect(w.json().totals.cases).toBe(205);expect(w.json().cases).toHaveLength(page===7?25:30);
 }
 expect(cases.size).toBe(205);expect(jobs.size).toBe(205);
});
