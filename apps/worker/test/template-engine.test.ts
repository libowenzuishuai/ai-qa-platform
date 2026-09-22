import {beforeAll,afterAll,it,expect} from 'vitest';
import Fastify from 'fastify';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createTestEnv,type TestEnv} from '../../api/test/helpers/db.js';
import {registerWorkflowRoutes} from '../../api/src/routes-workflow.js';
import {registerRunnerRoutes} from '../../api/src/routes-runners.js';
import {installBuiltinTemplates} from '../../api/src/template-runtime.js';
import {sendApiError} from '../../api/src/errors.js';
import {advanceWorkflow} from '../src/workflow-orchestrator.js';
let env:TestEnv,projectId:string,templateId:string,actor:any;
const app=Fastify(),token=randomUUID()+randomUUID();
beforeAll(async()=>{
 env=await createTestEnv('templates');actor=await env.prisma.user.create({data:{username:randomUUID(),displayName:'模板测试',passwordHash:'unused',platformRole:'ADMIN'}});
 projectId=(await env.prisma.project.create({data:{name:'独立模板验收',memberships:{create:{userId:actor.id,role:'ADMIN'}}}})).id;
 app.addHook('onRequest',async req=>{req.auth={userId:actor.id,username:actor.username,displayName:actor.displayName,platformRole:'ADMIN'};});
 app.setErrorHandler((e,q,r)=>sendApiError(q,r,e));registerWorkflowRoutes(app,env.prisma);registerRunnerRoutes(app,env.prisma,env.store);
 templateId=(await env.prisma.$transaction(tx=>installBuiltinTemplates(tx,projectId,actor.id))).find(t=>t.key==='engineering-check')!.id;
 await env.prisma.executionRunner.create({data:{projectId,name:'协议测试运行器',capabilities:['NODE_TEST','NODE_VITEST'],tokenHash:createHash('sha256').update(token).digest('hex')}});
},30000);
afterAll(async()=>{await app.close();await env?.cleanup();});
const post=(url:string,payload:any={},runner=false)=>app.inject({method:'POST',url,payload,headers:runner?{authorization:`Bearer ${token}`}:{}});
const spec={repositoryUrl:'https://github.com/fixture/project',commitSha:'a'.repeat(40),kind:'NODE_TEST',subdirectory:'',timeoutSeconds:60,installDependencies:false};
async function create(template=templateId){const r=await post(`/api/projects/${projectId}/workflows`,{idempotencyKey:randomUUID(),templateId:template,inputs:{codeCheck:spec}});expect(r.statusCode,r.body).toBe(202);return r.json().workflowId as string;}
it('工程模板实际创建运行器任务，执行真实 Node 测试后回传；重复调度不重复任务',async()=>{
 const id=await create();await advanceWorkflow(env.prisma,id,env.store);await advanceWorkflow(env.prisma,id,env.store);
 expect(await env.prisma.codeCheck.count({where:{projectId}})).toBe(1);
 const claimed=(await post('/api/runner/claim',{},true)).json().task;expect(claimed).toBeTruthy();
 // Actual local test; HTTP runner protocol is exercised, container isolation belongs to runner-e2e.
 const file=join(env.artifactDir,'node-fixture.test.mjs');writeFileSync(file,"import test from 'node:test';import assert from 'node:assert/strict';test('integer arithmetic',()=>assert.equal(2+3,5));");
 const output=execFileSync(process.execPath,['--test',file],{encoding:'utf8'});expect(output).toMatch(/pass 1/);
 const result=await post(`/api/runner/tasks/${claimed.id}/result`,{leaseToken:claimed.leaseToken,result:{commitSha:spec.commitSha,exitCode:0,cases:[{name:'integer arithmetic',status:'PASS'}],output}},true);
 expect(result.statusCode,result.body).toBe(200);
 await advanceWorkflow(env.prisma,id,env.store);await advanceWorkflow(env.prisma,id,env.store);
 const wf=await env.prisma.workflowRun.findUniqueOrThrow({where:{id},include:{nodes:true}});
 expect(wf.status).toBe('COMPLETED');expect(wf.nodes[0]!.outputRef).toMatchObject({verdict:'PASS'});
});
it('反向数组顺序按依赖执行；两个独立工程节点并行，取消后排队任务收敛',async()=>{
 const base=await env.prisma.workflowTemplate.findUniqueOrThrow({where:{id:templateId}});
 const n=(key:string,dependsOn:string[]=[])=>({key,dependsOn,capabilityKey:'code-check',capabilityVersion:1,isApprovalGate:false,inputMapping:{}});
 const t=await env.prisma.workflowTemplate.create({data:{projectId,key:'parallel',version:1,name:'并行检查',status:'PUBLISHED',nodes:[n('last',['first','second']),n('first'),n('second')],defaultParallelism:2,defaultBudget:base.defaultBudget as any,createdBy:actor.id}});
 const id=await create(t.id);await advanceWorkflow(env.prisma,id,env.store);await advanceWorkflow(env.prisma,id,env.store);
 const nodes=await env.prisma.workflowNode.findMany({where:{workflowId:id}});
 expect(nodes.find(n=>n.nodeKey==='last')!.status).toBe('queued');
 expect(nodes.filter(n=>n.status==='running')).toHaveLength(2);
 const checkIds=nodes.flatMap(n=>(n.outputRef as any)?.checkId?[(n.outputRef as any).checkId]:[]);
 await post(`/api/workflows/${id}/cancel`);await advanceWorkflow(env.prisma,id,env.store);
 expect((await env.prisma.codeCheck.findMany({where:{id:{in:checkIds}}})).every(c=>c.status==='CANCELLED')).toBe(true);
});
it('运行冻结模板版本，排队后修改目录内容不能改变执行图；完整性篡改拒绝',async()=>{
 const id=await create();
 const base=await env.prisma.workflowTemplate.findUniqueOrThrow({where:{id:templateId}});
 await env.prisma.workflowTemplate.create({data:{projectId,key:base.key,version:2,name:'第二版',status:'DRAFT',nodes:[],defaultBudget:base.defaultBudget as any,createdBy:actor.id}});
 await advanceWorkflow(env.prisma,id,env.store);
 expect(await env.prisma.workflowNode.count({where:{workflowId:id}})).toBe(1);
 const wf=await env.prisma.workflowRun.findUniqueOrThrow({where:{id}});
 await env.prisma.workflowRun.update({where:{id},data:{inputs:{...(wf.inputs as object),templateHash:'forged'}}});
 await advanceWorkflow(env.prisma,id,env.store);
 expect((await env.prisma.workflowRun.findUniqueOrThrow({where:{id}})).status).toBe('FAILED');
});
