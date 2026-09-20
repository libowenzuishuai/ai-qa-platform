import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { processAgentJob } from '../src/agent-job-processor.js';
import { Queue, Worker } from 'bullmq';
import { chromium } from 'playwright';
import { registerProjectRoutes } from '../../api/src/routes-projects.js';
import { randomUUID } from 'node:crypto';
import { createTestEnv, type TestEnv } from '../../api/test/helpers/db.js';
import { registerProductRoutes } from '../../api/src/routes-product.js';
import { registerDefectRoutes } from '../../api/src/routes-defects.js';
import { sendApiError } from '../../api/src/errors.js';
import { observeProject } from '../src/observation.js';
import { processRun } from '../src/run-processor.js';
import { buildRunReport } from '@ai-qa/reporting';
import { TestCaseVersion, computePlanAcceptanceHash } from '@ai-qa/contracts';
import { registerRunnerRoutes } from '../../api/src/routes-runners.js';
import { WorkerConfig } from '../src/config.js';

let env: TestEnv; const app=Fastify(); const target=Fastify();let baseUrl:string;let actor:any;let build='v1';let broken=false;
const realModel = process.env.REAL_PRODUCT_EVAL === '1';
let python: ChildProcess | undefined, intelligenceUrl = '', pythonLog = ''; 
const internalToken = randomUUID();
const root = fileURLToPath(new URL('../../../', import.meta.url));
const realEvidence: unknown[] = [];
const redisName='aiqa-product-'+randomUUID().slice(0,8);
let redisStarted=false, runQueue:Queue, jobQueue:Queue, runWorker:Worker, jobWorker:Worker, redisUrl='', web:ChildProcess|undefined, webUrl='';
function config(){return WorkerConfig.parse({databaseUrl:env.databaseUrl,redisUrl,artifactDir:env.artifactDir,intelligenceBackend:'python',intelligenceUrl:intelligenceUrl||undefined,intelligenceToken:internalToken,intelligenceTimeoutMs:120000});}
async function waitFor<T>(load:()=>Promise<T|undefined>, timeout=150000):Promise<T>{const end=Date.now()+timeout;while(Date.now()<end){const value=await load();if(value!==undefined)return value;await new Promise(r=>setTimeout(r,100));}throw new Error('后台处理超时');}
beforeAll(async()=>{
  env=await createTestEnv('product');
  execFileSync('docker',['run','--rm','-d','--name',redisName,'-p','127.0.0.1::6379','redis:7-alpine']);redisStarted=true;
  const port=Number(execFileSync('docker',['port',redisName,'6379/tcp'],{encoding:'utf8'}).trim().split(':').at(-1));redisUrl=`redis://127.0.0.1:${port}`;
  const connection={host:'127.0.0.1',port};runQueue=new Queue('product-runs',{connection});jobQueue=new Queue('product-jobs',{connection});
  runWorker=new Worker('product-runs',async job=>{if(job.name!=='execute')throw new Error('错误运行消息类型');await processRun(env.prisma,config(),job.data.runId);},{connection});
  jobWorker=new Worker('product-jobs',async job=>{if(job.name!=='run')throw new Error('错误作业消息类型');await processAgentJob(env.prisma,config(),job.data.jobId);},{connection});
  if(realModel){
    python=spawn(root+'services/intelligence/.venv/bin/python',['-c',"import sys;from pathlib import Path;sys.path.insert(0,'services/intelligence/scripts');from verify_kimi_agents import load_env;load_env(Path('.env.local'));import uvicorn;uvicorn.run('aiqa_intelligence.app:app',host='127.0.0.1',port=0)"],{cwd:root,env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!['ALL_PROXY','all_proxy','HTTP_PROXY','http_proxy','HTTPS_PROXY','https_proxy'].includes(key))),AIQA_INTELLIGENCE_TOKEN:internalToken,AIQA_ARTIFACT_DIR:env.artifactDir,PYTHONPATH:root+'services/intelligence/src'},stdio:['ignore','pipe','pipe']});
    intelligenceUrl=await new Promise<string>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Python 启动超时')),15000);let log='';python!.stderr!.on('data',chunk=>{log+=chunk.toString();pythonLog=log;const found=/Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/.exec(log);if(found){clearTimeout(timer);resolve(found[1]!);}});python!.once('exit',()=>{clearTimeout(timer);reject(new Error('Python 服务退出'));});});
  }
actor=await env.prisma.user.create({data:{username:randomUUID(),displayName:'Test lead',passwordHash:'unused',platformRole:'LEAD'}});
  app.addHook('onRequest',async req=>{req.auth={userId:actor.id,username:actor.username,displayName:actor.displayName,platformRole:'LEAD'};});
  app.setErrorHandler((err,req,reply)=>sendApiError(req,reply,err));registerProjectRoutes(app,env.prisma);registerProductRoutes(app,env.prisma,env.store,jobQueue,runQueue);registerDefectRoutes(app,env.prisma,env.store,runQueue);registerRunnerRoutes(app,env.prisma,env.store);
  target.get('/api/status',async()=>({state:broken?'wrong':'ready'}));
  target.get('/build',async()=>({buildId:build}));
  target.get('/subscription',async(_req,reply)=>reply.type('text/html').send(`<meta charset="utf-8"><h1>订阅中心</h1><button data-testid="upgrade" onclick="document.querySelector('[data-testid=result]').textContent='${broken?'Basic':'Pro'}'">升级</button><output data-testid="result">Basic</output>`));
  target.get('/booking',async(_req,reply)=>reply.type('text/html').send(`<meta charset="utf-8"><h1>预约中心</h1><input data-testid="name"><button data-testid="book" onclick="document.querySelector('[data-testid=result]').textContent='${broken?'未预约':'预约成功'}'">预约</button><output data-testid="result">未预约</output>`));
  baseUrl=await target.listen({host:'127.0.0.1',port:0});const apiUrl=await app.listen({host:'127.0.0.1',port:0});
  web=spawn('node',['--import','tsx',root+'apps/web/src/server.ts'],{cwd:root+'apps/web',env:{...process.env,WEB_PORT:'0',WEB_HOST:'127.0.0.1',API_BASE_URL:apiUrl},stdio:['ignore','pipe','pipe']});
  webUrl=await new Promise<string>((resolve,reject)=>{let log='';const timer=setTimeout(()=>reject(new Error('Web 启动超时')),10000);const read=(chunk:Buffer)=>{log+=chunk.toString();const found=/web ready on (http:\/\/127\.0\.0\.1:\d+)/.exec(log);if(found){clearTimeout(timer);resolve(found[1]!);}};web!.stdout!.on('data',read);web!.stderr!.on('data',read);});
},30000);
afterAll(async()=>{web?.kill('SIGTERM');await runWorker?.close();await jobWorker?.close();await runQueue?.close();await jobQueue?.close();if(redisStarted)execFileSync('docker',['rm','-f',redisName]);python?.kill("SIGTERM");if(realModel)writeFileSync('/tmp/aiqa-product-python-service.log',pythonLog);if(realModel){mkdirSync(root+"docs/delivery/evidence",{recursive:true});writeFileSync(root+"docs/delivery/evidence/real-plan-evaluation.json",JSON.stringify({mode:"real",scope:"two synthetic business projects, real Kimi plan generation and browser execution; manually approved rules/cases",evaluations:realEvidence},null,2));}await app.close();await target.close();await env?.cleanup();});
async function post(url:string,payload:any){const res=await app.inject({method:'POST',url,payload});expect(res.statusCode,res.body).toBeLessThan(300);return res.json();}
async function prepare(kind:'subscription'|'booking', useReal = false){
  const project=await env.prisma.project.create({data:{name:kind,memberships:{create:{userId:actor.id,role:'ADMIN'}}}});
  const environment=await env.prisma.environment.create({data:{projectId:project.id,name:'staging',baseUrl,allowedOrigins:[baseUrl],runtime:{fixture:'none',buildProbe:{path:'/build',field:'buildId'}}}});
  const rule=await env.prisma.rule.create({data:{projectId:project.id}});
  const rv=await env.prisma.ruleVersion.create({data:{ruleId:rule.id,version:1,statement:kind==='subscription'?'升级后显示 Pro':'预约后显示成功',classification:'EXPLICIT',action:'提交',expectation:'成功',reviewStatus:'APPROVED',origin:'manual'}});
  const tc=await env.prisma.testCase.create({data:{projectId:project.id}});
  const expected=kind==='subscription'?'Pro':'预约成功';
  const cv=await env.prisma.testCaseVersion.create({data:{caseId:tc.id,projectId:project.id,version:1,title:kind,roles:['visitor'],ruleVersionIds:[rv.id],preconditions:[],dataSpec:{strategy:'create',note:'浏览器提交'},steps:[{id:'business-submit',role:'visitor',action:'提交并确认结果'}],assertions:[{id:'result',description:'业务操作结果',kind:'ui.text',operator:'equals',expected,required:true,ruleVersionId:rv.id}],cleanup:{strategy:'manual',note:'仅本浏览器内状态，无远程持久化'},origin:'manual'}});
  await post(`/api/case-versions/${cv.id}/approve`,{});
  const observing=await post(`/api/projects/${project.id}/observations`,{environmentId:environment.id,pages:[{role:'visitor',path:`/${kind}`}]});
  const observed=await waitFor(async()=>{const j=await env.prisma.job.findUniqueOrThrow({where:{id:observing.jobId}});return ['SUCCEEDED','FAILED'].includes(j.status)?j:undefined;});
  expect(observed.status,JSON.stringify(observed.error)).toBe('SUCCEEDED');
  const observation=observed.result as {artifactId:string};
  const artifact=await env.prisma.artifact.findUniqueOrThrow({where:{id:observation.artifactId}});
  const bundle=JSON.parse(env.store.read(artifact.storageKey).toString());
  const ref=(id:string)=>bundle.bindings.find((b:any)=>b.locator.type==='testId'&&b.locator.value===id).targetRef;
  const row=await env.prisma.testCaseVersion.findUniqueOrThrow({where:{id:cv.id}});
  const testCase=TestCaseVersion.parse({...row,description:undefined,createdAt:row.createdAt.toISOString()});
  const actions:any[]=[{id:'role',type:'switchRole',role:'visitor',effect:'READ'},{id:'open',type:'goto',path:`/${kind}`,effect:'READ'}];
  if(kind==='booking')actions.push({id:'fill',type:'fill',targetRef:ref('name'),value:{source:'literal',value:'测试用户'},effect:'READ'});
  actions.push({id:'submit',type:'click',targetRef:ref(kind==='subscription'?'upgrade':'book'),effect:'WRITE'},{id:'check',type:'assert',assertionId:'result',effect:'READ'});
  const plan:any={schemaVersion:'1.0',caseVersionId:cv.id,ruleVersionIds:[rv.id],roles:['visitor'],bindings:bundle.bindings,actions,assertions:[{...testCase.assertions[0],stepId:'check',targetRef:ref('result')}],businessTimeLimits:[]};
  plan.acceptanceHash=computePlanAcceptanceHash({testCase,plan});
  // Deterministic planner fixture; model quality is tested independently, never labelled real-model success.
  let proposal;
  if(useReal && realModel){
    const job = await post(`/api/case-versions/${cv.id}/propose-plan`,{observationId:observation.artifactId,mode:'real'});
    await waitFor(async()=>{const j=await env.prisma.job.findUniqueOrThrow({where:{id:job.jobId}});return ['SUCCEEDED','FAILED'].includes(j.status)?j:undefined;});
    const finished=await env.prisma.job.findUniqueOrThrow({where:{id:job.jobId}});
    realEvidence.push({kind,jobStatus:finished.status,error:finished.error,invocations:await env.prisma.modelInvocation.findMany({where:{projectId:project.id}})});
    expect(finished.status,JSON.stringify(finished.error)).toBe('SUCCEEDED');
    proposal=await env.prisma.planProposal.findUniqueOrThrow({where:{id:(finished.result as {proposalId:string}).proposalId}});
  }else proposal=await env.prisma.planProposal.create({data:{projectId:project.id,caseVersionId:cv.id,environmentId:environment.id,environmentRevision:environment.revision,mode:'real',plan}});
  await post(`/api/plan-proposals/${proposal.id}/approve`,{});
  const baseline=await post(`/api/projects/${project.id}/baselines`,{name:'验收基线',caseVersionIds:[cv.id]});
  const mission=await post(`/api/projects/${project.id}/missions`,{title:'发布验收',goal:'验证业务提交结果',template:'RELEASE',baselineId:baseline.id,environmentId:environment.id});
  return {project,environment,cv,mission,proposal};
}
async function execute(runId:string){await waitFor(async()=>{const row=await env.prisma.run.findUniqueOrThrow({where:{id:runId}});const queued=await runQueue.getJob(`run-${runId}`);if(queued&&await queued.getState()==='failed')throw new Error(queued.failedReason);return ['FINISHED','ERROR','CANCELLED'].includes(row.lifecycle)&&!queued?row:undefined;});return buildRunReport(env.prisma,env.store,runId);}
describe(realModel?'通用项目（真实 Kimi/HTTP/Redis/DB/Chromium）':'通用项目（真实 HTTP/Redis/DB/Chromium，人工计划）',()=>{
  for(const kind of ['subscription','booking'] as const)it(`${kind}: 观察 → 批准 → 任务 → PASS → 缺陷 → 原计划复测`,async()=>{
    build='v1';broken=false;const p=await prepare(kind,true);
    const run=await post(`/api/missions/${p.mission.id}/start`,{buildId:build,idempotencyKey:randomUUID()});
    const good=await execute(run.runId);expect(good.cases[0]?.verdict).toBe('PASS');expect(good.run.buildVerified).toBe(true);expect(good.run.acceptanceStatus).toBe('PASS');
    if(realModel)realEvidence.push({kind,healthy:good.run,caseVerdicts:good.cases.map(c=>c.verdict)});
    build='v2';broken=true;
    const bad=await post(`/api/runs/${run.runId}/retest`,{buildId:build,idempotencyKey:randomUUID()});const badReport=await execute(bad.runId);if(realModel)realEvidence.push({kind,broken:badReport.run,caseVerdicts:badReport.cases.map(c=>c.verdict)});expect(badReport.run.acceptanceStatus).toBe('FAIL');
    const defect=await env.prisma.defect.findFirstOrThrow({where:{projectId:p.project.id}});expect(defect.status).toBe('CANDIDATE');
    build='v3';broken=false;
    const fixed=await post(`/api/runs/${bad.runId}/retest`,{buildId:build,idempotencyKey:randomUUID()});const fixedReport=await execute(fixed.runId);if(realModel)realEvidence.push({kind,fixed:fixedReport.run,caseVerdicts:fixedReport.cases.map(c=>c.verdict)});expect(fixedReport.run.acceptanceStatus).toBe('PASS');
    const original=await env.prisma.run.findUniqueOrThrow({where:{id:bad.runId}});const retest=await env.prisma.run.findUniqueOrThrow({where:{id:fixed.runId}});expect(retest.casePlanPins).toEqual(original.casePlanPins);
    expect((await post(`/api/defects/${defect.id}/verify`,{runId:fixed.runId})).status).toBe('VERIFIED');
  },180000);
  it.skipIf(process.env.REAL_REPOSITORY_EVAL!=='1')('真实 GitHub → 内容分类 → 确认 PRD → Python 解析，无需重复上传',async()=>{
    const project=await env.prisma.project.create({data:{name:'GitHub 接入验收',memberships:{create:{userId:actor.id,role:'ADMIN'}}}});
    const queued=await post(`/api/projects/${project.id}/repositories`,{url:'https://github.com/libowenzuishuai/ai-qa-platform',ref:'main',subdirectory:'docs/ai-qa'});
    const job=await waitFor(async()=>{const j=await env.prisma.job.findUniqueOrThrow({where:{id:queued.jobId}});return ['SUCCEEDED','FAILED'].includes(j.status)?j:undefined;});
    expect(job.status,JSON.stringify(job.error)).toBe('SUCCEEDED');
    const snapshot=await env.prisma.contextSnapshot.findUniqueOrThrow({where:{id:(job.result as any).snapshotId}});
    const files=snapshot.files as any[];const prd=files.find(f=>f.path.includes('02-产品需求'));
    expect(prd.category).toBe('BUSINESS_CANDIDATE');expect(files.find(f=>f.path.includes('03-GLM'))?.category).not.toBe('BUSINESS_CANDIDATE');
    const imported=await post(`/api/context/${snapshot.id}/import`,{paths:[prd.path]});
    const version=await waitFor(async()=>{const v=await env.prisma.documentVersion.findUniqueOrThrow({where:{id:imported.documents[0].documentVersionId}});return ['PARSED','FAILED'].includes(v.parseStatus)?v:undefined;});
    expect(version.parseStatus).toBe('PARSED');expect(await env.prisma.sourceSpan.count({where:{documentVersionId:version.id}})).toBeGreaterThan(0);
    const repeat=await post(`/api/context/${snapshot.id}/import`,{paths:[prd.path]});expect(repeat.documents[0].documentVersionId).toBe(version.id);
    realEvidence.push({kind:'repository',commitSha:snapshot.commitSha,files:files.map(({path,category,reason})=>({path,category,reason})),parseStatus:version.parseStatus,invocations:await env.prisma.modelInvocation.findMany({where:{projectId:project.id}})});
  },180000);
  it('七个产品页面读取真实数据，并能从界面创建任务',async()=>{
    const p=await prepare('subscription');const browser=await chromium.launch({headless:true});
    try{const context=await browser.newContext();await context.addCookies([{name:'web_sid',value:'product-ui',url:webUrl}]);const page=await context.newPage();
      const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
      for(const tab of ['overview','projects','context','missions','execution','assessment','integrations']){const response=await page.goto(`${webUrl}/space/${p.project.id}?tab=${tab}`);expect(response?.status()).toBe(200);expect(await page.locator('h1').innerText()).toBeTruthy();}
      await page.goto(`${webUrl}/space/${p.project.id}?tab=missions`);
      const form=page.locator('form[action$="/mission"]');await form.locator('[name=title]').fill('浏览器创建的验收任务');await form.locator('[name=goal]').fill('验证订阅结果');await form.locator('button').click();
      expect(await env.prisma.mission.count({where:{projectId:p.project.id,title:'浏览器创建的验收任务'}})).toBe(1);expect(errors).toEqual([]);
      mkdirSync(root+'docs/delivery/evidence',{recursive:true});await page.screenshot({path:root+'docs/delivery/evidence/product-missions.png',fullPage:true});
    }finally{await browser.close();}
  },60000);
  it('填写错误版本不能获得整体 PASS；环境变化拒绝旧绑定',async()=>{
    broken=false;build='actual';const p=await prepare('subscription');
    const run=await post(`/api/missions/${p.mission.id}/start`,{buildId:'claimed',idempotencyKey:randomUUID()});
    const report=await execute(run.runId);expect(report.cases[0]?.verdict).toBe('PASS');expect(report.run.acceptanceStatus).toBe('INCOMPLETE');
    await post(`/api/environments/${p.environment.id}/runtime`,{buildProbe:{path:'/build',field:'buildId'}});
    const rejected=await app.inject({method:'POST',url:`/api/missions/${p.mission.id}/start`,payload:{buildId:'actual',idempotencyKey:randomUUID()}});expect(rejected.statusCode).toBe(422);
  },30000);
  it('登记 API 请求模板 → 固定语义 → 真 HTTP 检查及证据',async()=>{
    broken=false;build='api-v1';const p=await prepare('subscription');
    const source=await env.prisma.testCaseVersion.findUniqueOrThrow({where:{id:p.cv.id}});
    const revised=await post(`/api/case-versions/${p.cv.id}/revise`,{title:'API 状态',preconditions:[],dataSpec:source.dataSpec,steps:source.steps,assertions:[{...(source.assertions as any[])[0],kind:'api.response',expected:'ready'}],cleanup:source.cleanup,roles:source.roles,ruleVersionIds:source.ruleVersionIds});
    await post(`/api/case-versions/${revised.id}/approve`,{});
    const template=await post(`/api/projects/${p.project.id}/api-templates`,{environmentId:p.environment.id,request:{name:'状态接口',method:'GET',path:'/api/status',responseField:'body.state'}});
    const proposal=await post(`/api/case-versions/${revised.id}/api-plan`,{templateId:template.id});
    await post(`/api/plan-proposals/${proposal.id}/approve`,{});
    const baseline=await post(`/api/projects/${p.project.id}/baselines`,{name:'API 基线',caseVersionIds:[revised.id]});
    const mission=await post(`/api/projects/${p.project.id}/missions`,{title:'API 验收',goal:'状态接口',template:'RELEASE',environmentId:p.environment.id,baselineId:baseline.id});
    const run=await post(`/api/missions/${mission.id}/start`,{buildId:build,idempotencyKey:randomUUID()});
    const report=await execute(run.runId);expect(report.run.acceptanceStatus,JSON.stringify(report)).toBe('PASS');
    expect(await env.prisma.artifact.count({where:{projectId:p.project.id,type:'API_RESPONSE'}})).toBe(1);
  },30000);
  it('运行器并发领取唯一、错版本与旧租约拒绝、空测试不能 PASS',async()=>{
    const p=await prepare('booking');
    const r=await post(`/api/projects/${p.project.id}/runners`,{name:'isolated',capabilities:['NODE_TEST']});
    const headers={authorization:`Bearer ${r.token}`};
    const task=await post(`/api/projects/${p.project.id}/code-checks`,{repositoryUrl:'https://github.com/org/project',commitSha:'a'.repeat(40),kind:'NODE_TEST'});
    const claims=await Promise.all([app.inject({method:'POST',url:'/api/runner/claim',headers,payload:{}}),app.inject({method:'POST',url:'/api/runner/claim',headers,payload:{}})]);
    expect(claims.every(r=>r.statusCode===200),claims.map(r=>r.body).join()).toBe(true);
    const owned=claims.map(r=>r.json().task).filter(Boolean);expect(owned).toHaveLength(1);
    const result={commitSha:'b'.repeat(40),exitCode:0,cases:[],output:''};
    expect((await app.inject({method:'POST',url:`/api/runner/tasks/${task.id}/result`,headers,payload:{leaseToken:owned[0].leaseToken,result}})).statusCode).toBe(422);
    result.commitSha='a'.repeat(40);
    const complete=await app.inject({method:'POST',url:`/api/runner/tasks/${task.id}/result`,headers,payload:{leaseToken:owned[0].leaseToken,result}});
    expect(complete.statusCode,complete.body).toBe(200);expect(complete.json().verdict).toBe('INCOMPLETE');
    expect((await app.inject({method:'POST',url:`/api/runner/tasks/${task.id}/result`,headers,payload:{leaseToken:owned[0].leaseToken,result}})).statusCode).toBe(409);
  },30000);
  it('跨项目用例与观察拒绝；模拟计划禁止批准',async()=>{
    const p=await prepare('booking');await env.prisma.planProposal.update({where:{id:p.proposal.id},data:{mode:'mock'}});
    expect((await app.inject({method:'POST',url:`/api/plan-proposals/${p.proposal.id}/approve`,payload:{}})).statusCode).toBe(422);
    await env.prisma.projectMembership.deleteMany({where:{projectId:p.project.id}});
    expect((await app.inject({method:'POST',url:`/api/case-versions/${p.cv.id}/approve`,payload:{}})).statusCode).toBe(403);
  },30000);
});
