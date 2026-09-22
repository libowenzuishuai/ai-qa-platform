import {beforeAll,afterAll,it,expect} from 'vitest';
import Fastify from 'fastify';
import {randomUUID} from 'node:crypto';
import {createTestEnv,type TestEnv} from './helpers/db.js';
import {registerProductRoutes} from '../src/routes-product.js';
import {sendApiError} from '../src/errors.js';
let env:TestEnv,projectId='';const app=Fastify();
beforeAll(async()=>{
 env=await createTestEnv('import');const user=await env.prisma.user.create({data:{username:randomUUID(),displayName:'导入测试',passwordHash:'unused',platformRole:'ADMIN'}});
 projectId=(await env.prisma.project.create({data:{name:'导入来源',memberships:{create:{userId:user.id,role:'ADMIN'}}}})).id;
 app.addHook('onRequest',async req=>{req.auth={userId:user.id,username:user.username,displayName:user.displayName,platformRole:'ADMIN'};});
 app.setErrorHandler((e,q,r)=>sendApiError(q,r,e));const queue={add:async()=>({})};registerProductRoutes(app,env.prisma,env.store,queue as any,queue as any);
},30000);
afterAll(async()=>{await app.close();await env?.cleanup();});
async function snapshot(text:string,path='docs/prd.md',repo='https://github.com/team/project'){
 const stored=env.store.put({runId:'import',attemptId:randomUUID(),filename:'prd.md',data:Buffer.from(text)});
 return env.prisma.contextSnapshot.create({data:{projectId,repositoryUrl:repo,subdirectory:'',commitSha:randomUUID().replaceAll('-','').padEnd(40,'a'),files:[{path,category:'BUSINESS_CANDIDATE',format:'MARKDOWN',...stored}],skipped:[]}});
}
async function importDoc(id:string,path='docs/prd.md'){
 const r=await app.inject({method:'POST',url:`/api/context/${id}/import`,payload:{paths:[path]}});expect(r.statusCode,r.body).toBe(202);return env.prisma.documentVersion.findUniqueOrThrow({where:{id:r.json().documents[0].documentVersionId}});
}
it('同仓库同路径连续版本；相同正文保持引用；内容回退仍追加新版，旧正文不变',async()=>{
 const a=await snapshot('审批上限 10'),v1=await importDoc(a.id);const b=await snapshot('审批上限 20'),v2=await importDoc(b.id);
 expect(v2.documentId).toBe(v1.documentId);expect(v2.version).toBe(2);
 const same=await snapshot('审批上限 20');expect((await importDoc(same.id)).id).toBe(v2.id);
 const reverted=await snapshot('审批上限 10'),v3=await importDoc(reverted.id);expect(v3.documentId).toBe(v1.documentId);expect(v3.version).toBe(3);
 expect(env.store.read(v1.storageKey).toString()).toBe('审批上限 10');
 expect((await importDoc(a.id)).id).toBe(v1.id);
});
it('相同字节不同仓库或路径不串来源；并发同路径只创建一个新版本',async()=>{
 const base=await snapshot('identical'),original=await importDoc(base.id);
 for(const [path,repo] of [['docs/another.md','https://github.com/team/project'],['docs/prd.md','https://github.com/team/other']]){
  const s=await snapshot('identical',path,repo);expect((await importDoc(s.id,path)).documentId).not.toBe(original.documentId);
 }
 const one=await snapshot('parallel'),two=await snapshot('parallel');const [a,b]=await Promise.all([importDoc(one.id),importDoc(two.id)]);expect(a.id).toBe(b.id);expect(a.documentId).toBe(original.documentId);
});
