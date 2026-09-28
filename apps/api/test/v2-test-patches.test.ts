import {chromium} from 'playwright';
import cookie from '@fastify/cookie';
import {registerTestPatchPages} from '../../web/src/v2-test-patches.js';
import {beforeAll,afterAll,it,expect} from 'vitest';
import Fastify from 'fastify';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createTestEnv,type TestEnv} from './helpers/db.js';
import {registerV2TestPatchRoutes} from '../src/routes-v2-test-patches.js';
import {registerRunnerRoutes} from '../src/routes-runners.js';
import {sendApiError} from '../src/errors.js';
const root=fileURLToPath(new URL('../../../',import.meta.url));
let env:TestEnv,app:ReturnType<typeof Fastify>,python:ChildProcess,projectId:string,ruleId:string,runnerHeaders:Record<string,string>;
const sha='a'.repeat(40);
beforeAll(async()=>{
 env=await createTestEnv('v2patch');app=Fastify();app.setErrorHandler((e,q,r)=>sendApiError(q,r,e));
 const user=await env.prisma.user.create({data:{username:randomUUID(),displayName:'reviewer',passwordHash:'unused',platformRole:'LEAD'}});
 projectId=(await env.prisma.project.create({data:{name:'candidate fixtures',memberships:{create:{userId:user.id,role:'ADMIN'}}}})).id;
 app.addHook('onRequest',async req=>{req.auth={userId:user.id,username:user.username,displayName:user.displayName,platformRole:'LEAD'};});
 const rule=await env.prisma.rule.create({data:{projectId}});ruleId=(await env.prisma.ruleVersion.create({data:{ruleId:rule.id,version:1,statement:'超过 500000 分需审批',classification:'EXPLICIT',action:'判断',expectation:'严格大于才返回 true',sources:[],reviewStatus:'APPROVED',origin:'manual'}})).id;
 python=spawn(join(root,'services/intelligence/.venv/bin/python'),['-c',"import uvicorn;uvicorn.run('aiqa_intelligence.app:app',host='127.0.0.1',port=0)"],{cwd:root,env:{...process.env,PYTHONPATH:join(root,'services/intelligence/src'),AIQA_INTELLIGENCE_TOKEN:'fixture',AIQA_ARTIFACT_DIR:env.artifactDir},stdio:['ignore','pipe','pipe']});
 const url=await new Promise<string>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Python startup timeout')),10000);python.stderr!.on('data',b=>{const match=b.toString().match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});python.once('exit',()=>{clearTimeout(timer);reject(Error('Python exited'));});});
 registerV2TestPatchRoutes(app,env.prisma,{artifactDir:env.artifactDir,intelligenceUrl:url,intelligenceToken:'fixture'});registerRunnerRoutes(app,env.prisma,env.store);
 const runner=(await app.inject({method:'POST',url:`/api/projects/${projectId}/runners`,payload:{name:'candidate isolated runner',capabilities:['NODE_TEST','PYTHON_TEST']}})).json();runnerHeaders={authorization:`Bearer ${runner.token}`};
},30000);
afterAll(async()=>{python?.kill('SIGTERM');await app?.close();await env?.cleanup();});
function body(language:'node'|'python'='node'){return {repositoryUrl:'https://github.com/example/synthetic-candidate',commitSha:sha,language,modulePath:language==='node'?'subject.mjs':'subject.py',functionName:'threshold',examples:[{id:'boundary',ruleVersionId:ruleId,args:[500000],expected:false},{id:'above',ruleVersionId:ruleId,args:[500001],expected:true}]};}
const create=(b=body())=>app.inject({method:'POST',url:`/api/v2/projects/${projectId}/test-patches`,payload:b});
it('true Python generation and approval, additive patch download, no implicit validity',async()=>{
 const r=await create();expect(r.statusCode,r.body).toBe(201);const p=r.json();expect(p.status).toBe('draft');expect(p.reviewedAt).toBeNull();
 const run=await app.inject({method:'POST',url:`/api/v2/test-patches/${p.id}/run`,payload:{variant:'healthy',commitSha:sha,idempotencyKey:randomUUID()}});expect(run.statusCode).toBe(409);
 const download=await app.inject({url:`/api/v2/test-patches/${p.id}/download`});expect(download.statusCode).toBe(200);expect(download.body).toContain('new file mode 100644');expect(download.body).toContain('assert.deepStrictEqual');expect(download.body).not.toContain('--- a/subject.mjs');
 const review=await app.inject({method:'POST',url:`/api/v2/test-patches/${p.id}/approve`});expect(review.statusCode).toBe(200);
 const evaluation=await app.inject({method:'POST',url:`/api/v2/test-patches/${p.id}/evaluate`});expect(evaluation.json().validated).toBe(false);expect(evaluation.json().patch.status).toBe('draft');
});
it('unapproved/cross-project rules and unsafe source paths reject before generation',async()=>{
 const b=body();b.examples[0]!.ruleVersionId='invented';expect((await create(b)).statusCode).toBe(422);
 expect((await create({...body(),modulePath:'../../outside.mjs'})).statusCode).toBe(422);
 await env.prisma.ruleVersion.update({where:{id:ruleId},data:{reviewStatus:'DRAFT'}});try{expect((await create()).statusCode).toBe(422);}finally{await env.prisma.ruleVersion.update({where:{id:ruleId},data:{reviewStatus:'APPROVED'}});}
});
it('rejected candidates cannot be approved or dispatched again',async()=>{const p=(await create()).json();expect((await app.inject({method:'POST',url:`/api/v2/test-patches/${p.id}/reject`,payload:{reason:'预期未批准'}})).statusCode).toBe(200);expect((await app.inject({method:'POST',url:`/api/v2/test-patches/${p.id}/approve`})).statusCode).toBe(409);expect((await app.inject({method:'POST',url:`/api/v2/test-patches/${p.id}/evaluate`})).statusCode).toBe(409);});
const real=process.env.REAL_CANDIDATE_EVAL==='1'?it:it.skip;
for(const language of ['node','python'] as const)real(`${language}: true disposable containers healthy / defect / fix with identical generated tests`,async()=>{
 const created=await create(body(language));expect(created.statusCode,created.body).toBe(201);const p=created.json();await app.inject({method:'POST',url:`/api/v2/test-patches/${p.id}/approve`});
 const source=mkdtempSync(join(tmpdir(),'aiqa-candidate-source-'));const results:string[]=[];
 try{
  for(const [variant,char,operator]of [['healthy','a','>'],['defect','b','>='],['fix','c','>']] as const){
   const code=language==='node'?`export function threshold(amount) { return amount ${operator} 500000; }`:`def threshold(amount):\n    return amount ${operator} 500000\n`;
   writeFileSync(join(source,language==='node'?'subject.mjs':'subject.py'),code);
   const submitted=await app.inject({method:'POST',url:`/api/v2/test-patches/${p.id}/run`,payload:{variant,commitSha:char.repeat(40),timeoutSeconds:60,installDependencies:false,idempotencyKey:randomUUID()}});expect(submitted.statusCode,submitted.body).toBe(202);
   const task=(await app.inject({method:'POST',url:'/api/runner/claim',headers:runnerHeaders,payload:{}})).json().task;expect(task.id).toBe(submitted.json().id);
   const program=`import sys,json,importlib.util;spec=importlib.util.spec_from_file_location('runner',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);print(json.dumps(m.execute(json.loads(sys.argv[2]),source_directory=sys.argv[3])))`;
   const result=JSON.parse(execFileSync(join(root,'services/intelligence/.venv/bin/python'),['-c',program,join(root,'tools/self-hosted-runner/runner.py'),JSON.stringify(task.request),source],{cwd:root,env:{...process.env,AIQA_RUNNER_NODE_IMAGE:'node:22-alpine',AIQA_RUNNER_PYTHON_IMAGE:'aiqa-python-test:local'},encoding:'utf8',timeout:70000,maxBuffer:1024*1024}));
   expect(result.platformError,JSON.stringify(result)).toBeUndefined();expect(result.cases.length).toBe(2);
   const stored=await app.inject({method:'POST',url:`/api/runner/tasks/${task.id}/result`,headers:runnerHeaders,payload:{leaseToken:task.leaseToken,result}});expect(stored.statusCode,stored.body).toBe(200);results.push(stored.json().verdict);
   expect(result.resources.every((r:any)=>r.status==='CLEANED')).toBe(true);
  }
  expect(results).toEqual(['PASS','FAIL','PASS']);
  const evaluation=await app.inject({method:'POST',url:`/api/v2/test-patches/${p.id}/evaluate`});expect(evaluation.statusCode,evaluation.body).toBe(200);expect(evaluation.json().validated).toBe(true);expect(evaluation.json().patch.validity.knownDefectsDetected).toBe(1);
  const check=await env.prisma.codeCheck.findFirstOrThrow({where:{projectId,request:{path:['candidateTestPatchId'],equals:p.id},verdict:'FAIL'}});
  await env.prisma.codeCheck.update({where:{id:check.id},data:{result:{tampered:true}}});
  expect((await app.inject({method:'POST',url:`/api/v2/test-patches/${p.id}/evaluate`})).statusCode).toBe(409);
 }finally{rmSync(source,{recursive:true,force:true});}
},120000);

it('browser journey generates, reviews and downloads a candidate without writing JSON',async()=>{
 const old=process.env.API_BASE_URL;process.env.API_BASE_URL=await app.listen({host:'127.0.0.1',port:0});
 const web=Fastify();await web.register(cookie);await web.register(import('@fastify/formbody'));registerTestPatchPages(web);const url=await web.listen({host:'127.0.0.1',port:0});
 const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});
 try{
  await page.context().addCookies([{name:'web_sid',value:'fixture',url}]);await page.goto(`${url}/space/${projectId}/test-patches`);
  await page.locator('[name=repositoryUrl]').fill(body().repositoryUrl);await page.locator('[name=commitSha]').fill(sha);await page.locator('[name=modulePath]').fill('subject.mjs');await page.locator('[name=functionName]').fill('threshold');
  await page.getByLabel('样例 1 参数 1',{exact:true}).fill('500000');
  const value=page.locator('.example-card label').filter({has:page.getByLabel('样例 1 预期结果',{exact:true})});await value.locator('select').selectOption('boolean');await page.getByLabel('样例 1 预期结果',{exact:true}).fill('false');
  mkdirSync(join(root,'docs/evidence/v2-ui'),{recursive:true});await page.screenshot({path:join(root,'docs/evidence/v2-ui/desktop-code-candidate.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:join(root,'docs/evidence/v2-ui/mobile-code-candidate.png'),fullPage:true});
  await page.getByRole('button',{name:'生成待审核补丁 →'}).click();await page.waitForURL(/\/v2\/test-patches\/[^/]+$/);expect(await page.getByRole('heading',{name:'审核样例，验证断言强度'}).count()).toBe(1);
  await page.getByRole('button',{name:'确认样例符合独立业务标准，允许隔离执行'}).click();await page.waitForLoadState('networkidle');expect(await page.locator('.page-heading').innerText()).toContain('样例已审核');
  const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'下载 Git 补丁'}).click()]);expect(download.suggestedFilename()).toMatch(/^aiqa-.*\.patch$/);
 }finally{await browser.close();await web.close();if(old===undefined)delete process.env.API_BASE_URL;else process.env.API_BASE_URL=old;}
},40000);
