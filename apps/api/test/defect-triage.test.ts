import {beforeAll,afterAll,it,expect} from 'vitest';
import Fastify from 'fastify';
import {randomUUID} from 'node:crypto';
import {createTestEnv,type TestEnv} from './helpers/db.js';
import {registerDefectRoutes} from '../src/routes-defects.js';
import {sendApiError} from '../src/errors.js';
const app=Fastify();let env:TestEnv,projectId='',otherId='',actor:any,defectId='';
beforeAll(async()=>{
 env=await createTestEnv('triage');actor=await env.prisma.user.create({data:{username:randomUUID(),displayName:'缺陷负责人',passwordHash:'unused',platformRole:'LEAD'}});
 projectId=(await env.prisma.project.create({data:{name:'缺陷台账',memberships:{create:{userId:actor.id,role:'ADMIN'}}}})).id;otherId=(await env.prisma.project.create({data:{name:'其他项目'}})).id;
 app.addHook('onRequest',async req=>{req.auth={userId:actor.id,username:actor.username,displayName:actor.displayName,platformRole:'LEAD'};});app.setErrorHandler((e,q,r)=>sendApiError(q,r,e));registerDefectRoutes(app,env.prisma,env.store,{add:async()=>{}});
 for(let i=0;i<65;i++){const d=await env.prisma.defect.create({data:{projectId,fingerprint:'d'+i,title:'分页夹具 '+i,severity:i%2?'P1':'P2'}});if(i===0)defectId=d.id;}
 await env.prisma.defectOccurrence.createMany({data:Array.from({length:65},(_,i)=>({defectId,runId:'synthetic-run-'+i,attemptId:'synthetic-attempt-'+i,evidenceRefs:[],buildId:'fixture-'+i}))});
},30000);
afterAll(async()=>{await app.close();await env?.cleanup();});
const post=(payload:any)=>app.inject({method:'POST',url:'/api/defects/'+defectId+'/update',payload});
it('超过旧列表限额仍分页可达；出现次数全量、负责人为可读成员，跨项目拒绝',async()=>{
 const ids=new Set<string>();for(let page=1;page<=3;page++){const r=await app.inject({url:`/api/projects/${projectId}/defects?page=${page}`});expect(r.statusCode,r.body).toBe(200);const data=r.json();expect(data.total).toBe(65);expect(data.members[0].user.displayName).toBe('缺陷负责人');for(const d of data.defects)ids.add(d.id);}expect(ids.size).toBe(65);
 const detail=(await app.inject({url:'/api/defects/'+defectId+'?page=3'})).json();expect(detail.total).toBe(65);expect(detail.occurrences).toHaveLength(5);
 const filtered=(await app.inject({url:`/api/projects/${projectId}/defects?severity=P1`})).json();expect(filtered.total).toBe(32);
 expect((await app.inject({url:`/api/projects/${otherId}/defects`})).statusCode).toBe(403);
});
it('严重度需业务影响依据，负责人需项目成员，并发旧版本不能覆盖新处理记录',async()=>{
 expect((await post({status:'CONFIRMED',severity:'P0',reason:'确认影响'})).statusCode).toBe(422);
 expect((await post({status:'CONFIRMED',assignedTo:'other-member',reason:'确认影响'})).statusCode).toBe(422);
 const original=await env.prisma.defect.findUniqueOrThrow({where:{id:defectId}}),body={status:'CONFIRMED',assignedTo:actor.id,severity:'P1',severityBasis:'所有申请人无法完成提交',reason:'复现核心流程阻断',expectedUpdatedAt:original.updatedAt.toISOString()};
 const responses=await Promise.all([post(body),post({...body,status:'FIX_PENDING'})]);expect(responses.map(r=>r.statusCode).sort()).toEqual([200,409]);
 const current=await env.prisma.defect.findUniqueOrThrow({where:{id:defectId}});expect(current.assignedTo).toBe(actor.id);expect(current.severityBasis).toBe(body.severityBasis);
 const events=await env.prisma.auditEvent.findMany({where:{entityId:defectId,action:'defect.update'}});expect(events).toHaveLength(1);
});
