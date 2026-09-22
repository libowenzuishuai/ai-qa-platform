import {beforeAll,afterAll,it,expect} from 'vitest';
import Fastify from 'fastify';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {mkdirSync,symlinkSync,writeFileSync,readFileSync} from 'node:fs';
import {createTestEnv,seedMinimalAssets,type TestEnv} from '../../api/test/helpers/db.js';
import {registerReleaseRoutes} from '../../api/src/routes-release.js';
import {registerArtifactRoutes} from '../../api/src/routes-artifacts.js';
import {sendApiError} from '../../api/src/errors.js';
import {buildRunReport} from '@ai-qa/reporting';
import {sweepProjectEvidence} from '../src/evidence-retention.js';
let env:TestEnv,projectId='',runId='',attemptId='',evidenceId='',rawId='',recentId='',sourceId='',otherId='';
const app=Fastify(),past=new Date(Date.now()-40*86400000);
beforeAll(async()=>{
 env=await createTestEnv('retention');const assets=await seedMinimalAssets(env.prisma,env.store);projectId=assets.projectId;sourceId=assets.evidenceArtifactId;
 const user=await env.prisma.user.create({data:{username:randomUUID(),displayName:'保留策略测试',passwordHash:'unused',platformRole:'LEAD'}});
 await env.prisma.projectMembership.create({data:{projectId,userId:user.id,role:'ADMIN'}});
 app.addHook('onRequest',async req=>{req.auth={userId:user.id,username:user.username,displayName:user.displayName,platformRole:'LEAD'};});
 app.setErrorHandler((e,q,r)=>sendApiError(q,r,e));registerReleaseRoutes(app,env.prisma,env.store);registerArtifactRoutes(app,env.prisma,env.store);
 const plan=await env.prisma.testPlanVersion.findUniqueOrThrow({where:{id:assets.planVersionId}});
 runId=(await env.prisma.run.create({data:{projectId,baselineId:assets.baselineId,environmentId:assets.environmentId,lifecycle:'FINISHED',acceptanceStatus:'PASS',mode:'real',selectedCaseVersionIds:[assets.caseVersionId],budget:{},idempotencyKey:randomUUID(),casePlanPins:[{caseVersionId:assets.caseVersionId,planVersionId:plan.id,acceptanceHash:plan.acceptanceHash}]}})).id;
 attemptId=(await env.prisma.caseAttempt.create({data:{projectId,runId,caseVersionId:assets.caseVersionId,attemptNo:1,namespace:'retention',lifecycle:'FINISHED',verdict:'PASS',reasonCode:'NONE'}})).id;
 async function artifact(type:string,createdAt:Date,sensitivity='NORMAL',owner=projectId){
  const stored=env.store.put({runId,attemptId,filename:randomUUID()+'.txt',data:Buffer.from(type)});
  return env.prisma.artifact.create({data:{projectId:owner,attemptId:owner===projectId?attemptId:null,type,sensitivity,storageKey:stored.storageKey,checksum:stored.checksum,createdAt}});
 }
 evidenceId=(await artifact('SCREENSHOT',past)).id;rawId=(await artifact('TRACE',past,'RESTRICTED_RAW')).id;recentId=(await artifact('SCREENSHOT',new Date())).id;
 const other=(await env.prisma.project.create({data:{name:'其他项目'}})).id;otherId=(await artifact('SCREENSHOT',past,'NORMAL',other)).id;
 await env.prisma.artifact.update({where:{id:sourceId},data:{createdAt:past}});
 await env.prisma.assertionResultRecord.create({data:{attemptId,assertionId:'a1',result:'PASS',evaluatedAt:past,evidenceIds:[evidenceId]}});
},30000);
afterAll(async()=>{await app.close();await env?.cleanup();});
const policy=(body:unknown,id=projectId)=>app.inject({method:'PUT',url:`/api/projects/${id}/evidence-retention`,payload:body as any});
it('默认不删除；策略只允许项目 ADMIN 且不覆盖其他项目设置',async()=>{
 expect((await sweepProjectEvidence(env.prisma,env.store,projectId)).deleted).toBe(0);
 const other=(await env.prisma.artifact.findUniqueOrThrow({where:{id:otherId}})).projectId;
 expect((await policy({enabled:true,normalDays:1,restrictedDays:1},other)).statusCode).toBe(403);
 expect((await policy({enabled:true,normalDays:0})).statusCode).toBe(422);
 await env.prisma.project.update({where:{id:projectId},data:{settings:{preserved:'yes'}}});
 expect((await policy({enabled:true,normalDays:30,restrictedDays:7})).statusCode).toBe(200);
 expect((await env.prisma.project.findUniqueOrThrow({where:{id:projectId}})).settings).toMatchObject({preserved:'yes'});
});
it('真实文件清理、重入幂等、来源/近期/跨项目保留；报告失证降级且原判定不改',async()=>{
 expect((await buildRunReport(env.prisma,env.store,runId)).cases[0]!.verdict).toBe('PASS');
 const [a,b]=await Promise.all([sweepProjectEvidence(env.prisma,env.store,projectId),sweepProjectEvidence(env.prisma,env.store,projectId)]);expect(a.deleted+b.deleted).toBe(2);
 for(const id of [evidenceId,rawId]){const row=await env.prisma.artifact.findUniqueOrThrow({where:{id}});expect(env.store.exists(row.storageKey)).toBe(false);expect(row.expiresAt).not.toBeNull();expect((await app.inject({url:`/api/artifacts/${id}`})).statusCode).toBe(404);}
 for(const id of [recentId,sourceId,otherId]){const row=await env.prisma.artifact.findUniqueOrThrow({where:{id}});expect(env.store.exists(row.storageKey)).toBe(true);}
 expect(await env.prisma.auditEvent.count({where:{action:'artifact.expired',entityId:{in:[evidenceId,rawId]}}})).toBe(2);
 expect((await buildRunReport(env.prisma,env.store,runId)).metrics.acceptanceStatus).toBe('INCOMPLETE');
 expect((await env.prisma.caseAttempt.findUniqueOrThrow({where:{id:attemptId}})).verdict).toBe('PASS');
 const stats=(await app.inject({url:`/api/projects/${projectId}/stats`})).json();expect(stats.runs.byAcceptance.INCOMPLETE).toBe(1);expect(stats.runs.recordedByAcceptance.PASS).toBe(1);
 expect((await sweepProjectEvidence(env.prisma,env.store,projectId)).deleted).toBe(0);
});
it('过期材料即使文件尚在也不可下载；删除拒绝目录、穿越与符号链接',async()=>{
 await env.prisma.artifact.update({where:{id:recentId},data:{expiresAt:past}});
 expect((await app.inject({url:`/api/artifacts/${recentId}`})).statusCode).toBe(404);
 const target=join(env.artifactDir,'external');mkdirSync(target);writeFileSync(join(target,'keep.txt'),'keep');symlinkSync(target,join(env.artifactDir,'link'));
 expect(()=>env.store.remove('link/keep.txt')).toThrow(/符号链接/);expect(readFileSync(join(target,'keep.txt'),'utf8')).toBe('keep');
 expect(()=>env.store.remove('../outside')).toThrow();expect(()=>env.store.remove('external')).toThrow(/普通/);expect(env.store.remove('missing/file')).toBe(false);
});
it('非终态运行不清理；数据库已登记但物理文件缺失时恢复审计',async()=>{
 await env.prisma.run.update({where:{id:runId},data:{lifecycle:'RUNNING'}});expect((await sweepProjectEvidence(env.prisma,env.store,projectId)).deleted).toBe(0);
 await env.prisma.run.update({where:{id:runId},data:{lifecycle:'FINISHED'}});
 const row=await env.prisma.artifact.findUniqueOrThrow({where:{id:recentId}});env.store.remove(row.storageKey);
 expect((await sweepProjectEvidence(env.prisma,env.store,projectId)).deleted).toBe(1);
 expect(await env.prisma.auditEvent.count({where:{action:'artifact.expired',entityId:recentId}})).toBe(1);
});
