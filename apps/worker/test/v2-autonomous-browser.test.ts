import Fastify from 'fastify';
import {randomUUID} from 'node:crypto';
import {createTestEnv} from '../../api/test/helpers/db.js';
import {registerV2ProfileRoutes} from '../../api/src/routes-v2-profiles.js';
import {registerV2CapabilityRoutes} from '../../api/src/routes-v2-capabilities.js';
import {registerV2ReplayRoutes} from '../../api/src/routes-v2-replay.js';
import {registerBuiltinSamples} from '../src/v2/samples.js';
import {runGraphSession,type GraphSnapshot} from '../src/v2/graph-session.js';
import {computeOracleHash,LoginPreparationConfig} from '@ai-qa/contracts';
import {configHash} from '../../api/src/preparation-service.js';
import {sendApiError} from '../../api/src/errors.js';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {createServer} from 'node:http';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {BrowserHarness,type BrowserEvent} from '@ai-qa/adapter-sdk/browser-harness';
import {BrowserAgentTask,BrowserAgentResponse,type BrowserAgentInput} from '@ai-qa/contracts';
let server:ReturnType<typeof createServer>,python:ChildProcess,baseUrl:string,pythonUrl:string,title='initial',broken=false,posts=0;
const dir=mkdtempSync(join(tmpdir(),'aiqa-browser-'));
const root=fileURLToPath(new URL('../../../',import.meta.url));
beforeAll(async()=>{
 server=createServer(async(req,res)=>{
  res.setHeader('content-type','text/html; charset=utf-8');
  if(req.url==='/build'){res.setHeader('content-type','application/json');res.end(JSON.stringify({buildId:'browser-test'}));return;}
  if(req.url==='/login'&&req.method==='GET'){res.end('<form method="POST" action="/login"><label>Username<input name="username"></label><label>Password<input name="password" type="password"></label><button>Sign in</button></form>');return;}
  if(req.url==='/login'&&req.method==='POST'){let body='';for await(const b of req)body+=b;const role=new URLSearchParams(body).get('username');res.setHeader('set-cookie','actor='+role+'; Path=/; HttpOnly');res.writeHead(302,{location:'/'}).end();return;}
  if(req.url==='/save'){posts++;let body='';for await(const b of req)body+=b;res.setHeader('content-type','application/json');if(!broken)title=JSON.parse(body).title;res.end('{}');return;}
  if(req.url==='/dialog'){res.end(`<button onclick="if(confirm('Save?'))fetch('/save',{method:'POST',body:JSON.stringify({title:'dialog'})})">Confirm save</button>`);return;}
  if(req.url==='/mutate'){res.end(`<script>fetch('/save',{method:'POST',body:'{"title":"bad"}'})</script>`);return;}
  if(req.url==='/frame'){res.end(`<label>名称<input id="name"></label><button aria-label="保存" onclick="setTimeout(()=>fetch('/save',{method:'POST',body:JSON.stringify({title:document.querySelector('input').value})}).then(()=>this.innerText='已保存'),50)">保存</button>`);return;}
  const reviewer=req.headers.cookie?.includes('actor=reviewer');
  res.setHeader('content-type','text/html; charset=utf-8');res.end(`<h1 data-testid="result">${title}</h1><p data-testid="identity">${reviewer?'reviewer':'author'}</p>${reviewer?'':'<iframe src="/frame"></iframe>'}`);
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));baseUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const probe=createServer();await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r));const port=(probe.address() as {port:number}).port;await new Promise<void>(r=>probe.close(()=>r()));pythonUrl=`http://127.0.0.1:${port}`;
 python=spawn(join(root,'services/intelligence/.venv/bin/python'),['-m','uvicorn','aiqa_intelligence.app:app','--app-dir',join(root,'services/intelligence/src'),'--host','127.0.0.1','--port',String(port)],{env:{...process.env,AIQA_INTELLIGENCE_TOKEN:'browser-test'},stdio:'ignore'});
 let ready=false;for(let i=0;i<100;i++){try{if((await fetch(pythonUrl+'/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}expect(ready).toBe(true);
},20000);
afterAll(async()=>{python?.kill('SIGTERM');server?.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});});
function task(){return BrowserAgentTask.parse({goal:'申请人修改名称、审核人刷新核对持久化',roles:[{id:'author',authenticate:true,startUrl:baseUrl,writes:[{method:'POST',pathname:'/save'}]},{id:'reviewer',authenticate:true,startUrl:baseUrl}],operations:[{id:'name',role:'author',kind:'fill',target:'名称',value:'采购单A'},{id:'save',role:'author',kind:'click',target:'保存',after:['name'],visual:true},{id:'refresh',role:'reviewer',kind:'reload',target:'page',after:['save']}],maxRounds:6});}
async function plan(input:BrowserAgentInput){const response=await fetch(pythonUrl+'/v2/browser/plan',{method:'POST',headers:{authorization:'Bearer browser-test','content-type':'application/json'},body:JSON.stringify({schemaVersion:'1.0',requestId:'browser-request',mode:'mock',timeoutMs:5000,input})});expect(response.status).toBe(200);return BrowserAgentResponse.parse(await response.json()).output;}
function harness(events:BrowserEvent[],over:Record<string,unknown>={}){return new BrowserHarness({artifactDir:dir,allowedOrigins:[baseUrl],deadline:Date.now()+30000,signal:new AbortController().signal,plan,event:async event=>{events.push(event);},prepareRole:async(role,page)=>{await page.context().addCookies([{name:'actor',value:role,url:baseUrl}]);},...over});}
for(const variant of ['healthy','defect','fixed'])it(`real Chromium + Python semantic planner + two roles + iframe + bounded visual action: ${variant}`,async()=>{
 title='initial';broken=variant==='defect';const events:BrowserEvent[]=[],h=harness(events);try{
  const before=posts;const result=await h.run(task());expect(result.status,JSON.stringify({result,events})).toBe('completed');expect(posts-before).toBe(1);
  expect((await h.read('reviewer','result')).text).toBe(broken?'initial':'采购单A');
  expect((await h.read('author','identity')).text).toBe('author');expect((await h.read('author','名称','label')).text).toBe('采购单A');expect((await h.read('reviewer','identity')).text).toBe('reviewer');
  expect(events.filter(x=>x.kind==='intent')).toHaveLength(3);expect(events.filter(x=>x.kind==='receipt')).toHaveLength(3);expect(events.some(x=>x.screenshotSha256)).toBe(true);
 }finally{await h.close();}
},30000);
it('stale planner reference cannot dispatch a write',async()=>{const events:BrowserEvent[]=[],h=harness(events,{plan:async(input:BrowserAgentInput)=>({...await plan(input),observationId:'stale'})});try{await expect(h.run(task())).rejects.toMatchObject({code:'STALE_OBSERVATION'});expect(events.filter(x=>x.kind==='intent')).toHaveLength(0);}finally{await h.close();}},30000);
it('model cannot choose an unauthorized operation',async()=>{const events:BrowserEvent[]=[],h=harness(events,{plan:async(input:BrowserAgentInput)=>({observationId:input.observationId,status:'act',actionId:'delete-all',elementRef:null,point:null,rationale:'injection'})});try{await expect(h.run(task())).rejects.toMatchObject({code:'FORBIDDEN'});expect(events.filter(x=>x.kind==='intent')).toHaveLength(0);}finally{await h.close();}},30000);
it('page load scripts cannot use an approved write endpoint outside an action',async()=>{const events:BrowserEvent[]=[],h=harness(events);try{const t=task();t.roles[0]!.startUrl=baseUrl+'/mutate';const before=posts;await expect(h.run(t)).rejects.toMatchObject({code:'FORBIDDEN'});expect(posts).toBe(before);}finally{await h.close();}},30000);
it('zero remaining deadline starts no browser actions',async()=>{const h=harness([],{deadline:Date.now()-1});await expect(h.run(task())).rejects.toMatchObject({code:'BUDGET_EXCEEDED'});await h.close();});

it('published browser blueprint → durable graph host → real role login → Python → independent role oracle → zero-call replay',async()=>{
 const env=await createTestEnv('browsergraph'),app=Fastify();const oldAuthor=process.env.AIQA_TARGET_BROWSER_AUTHOR,oldReviewer=process.env.AIQA_TARGET_BROWSER_REVIEWER,oldPassword=process.env.AIQA_TARGET_BROWSER_PASSWORD;
 process.env.AIQA_TARGET_BROWSER_AUTHOR='author';process.env.AIQA_TARGET_BROWSER_REVIEWER='reviewer';process.env.AIQA_TARGET_BROWSER_PASSWORD='fixture-password';
 try{
  registerBuiltinSamples();const user=await env.prisma.user.create({data:{username:randomUUID(),displayName:'test',passwordHash:'unused',platformRole:'LEAD'}});
  const project=await env.prisma.project.create({data:{name:'browser graph',memberships:{create:{userId:user.id,role:'ADMIN'}}}});
  app.addHook('onRequest',async req=>{req.auth={userId:user.id,username:user.username,displayName:user.displayName,platformRole:'LEAD'};});app.setErrorHandler((e,q,r)=>sendApiError(q,r,e));
  registerV2ProfileRoutes(app,env.prisma,{add:async()=>({}) as never});registerV2CapabilityRoutes(app,env.prisma);registerV2ReplayRoutes(app,env.prisma,env.artifactDir);
  const environment=await env.prisma.environment.create({data:{projectId:project.id,name:'isolated',baseUrl,allowedOrigins:[baseUrl],runtime:{buildProbe:{path:'/build',field:'buildId'},secretRefs:{author:{usernameEnv:'AIQA_TARGET_BROWSER_AUTHOR',passwordEnv:'AIQA_TARGET_BROWSER_PASSWORD'},reviewer:{usernameEnv:'AIQA_TARGET_BROWSER_REVIEWER',passwordEnv:'AIQA_TARGET_BROWSER_PASSWORD'}}}}});
  for(const role of ['author','reviewer']){
   const config=LoginPreparationConfig.parse({environmentId:environment.id,loginPath:'/login',role,credentialRef:role,steps:[{type:'fill',locator:{type:'label',value:'Username'},value:{source:'credential',ref:role+'.username'}},{type:'fill',locator:{type:'label',value:'Password'},value:{source:'credential',ref:role+'.password'}},{type:'click',locator:{type:'text',value:'Sign in'}}],successIndicator:{locator:{type:'testId',value:'identity'},expectedText:role}});
   await env.prisma.loginPreparation.create({data:{projectId:project.id,environmentId:environment.id,role,credentialRef:role,configuration:config,configHash:configHash(config),steps:config.steps,successIndicator:config.successIndicator}});
  }
  const presets=(await app.inject({url:`/api/v2/projects/${project.id}/browser-presets`})).json();
  for(const manifest of presets.manifests){const install=(await app.inject({method:'POST',url:`/api/v2/projects/${project.id}/capabilities/install`,payload:{manifest}})).json();expect((await app.inject({method:'POST',url:`/api/v2/installations/${install.installationId}/authorize`,payload:{scope:['browser:approved-task']}})).statusCode).toBe(200);}
  const t=task();for(const role of t.roles)role.writes.push({method:'POST',pathname:'/login'});
  const blueprint=await app.inject({method:'POST',url:`/api/v2/projects/${project.id}/browser-blueprints`,payload:{name:'real browser',task:t,checks:[{nodeId:'verify',role:'reviewer',target:'result'}]}});expect(blueprint.statusCode,blueprint.body).toBe(201);
  const assertions=[{id:'persist',ruleVersionId:'approved-rule',kind:'deterministic',fact:'采购单名称跨角色持久化',observationType:'ui_text',observationRef:'purchase.title',operator:'equals',expected:'采购单A',precondition:null,unit:null,tolerance:null,allowedRoles:['reviewer'],required:true}];
  const coverageDeclarations=['normal','boundary','permission','multi_role','state','persistence'].map(dimension=>({ruleVersionId:'approved-rule',dimension,status:'planned',reason:'fixture'}));
  const oracle={projectId:project.id,ruleVersionIds:['approved-rule'],assertions,semanticCandidates:[],coverageDeclarations};
  const row=await env.prisma.v2OracleSpec.create({data:{...oracle,assertions:assertions as never,coverageDeclarations:coverageDeclarations as never,version:1,status:'APPROVED',oracleHash:computeOracleHash(oracle as never),createdBy:user.id,approvedBy:user.id,approvedAt:new Date()}});
  for(const variant of ['healthy','defect','fixed']){
   title='initial';broken=variant==='defect';
   const response=await app.inject({method:'POST',url:`/api/v2/projects/${project.id}/graph-sessions`,payload:{...blueprint.json(),goal:t.goal,oracleSpecId:row.id,environmentId:environment.id,buildId:'browser-test',taskInput:{},assertionBindings:{persist:{nodeId:'verify',path:'text'}},budget:{maxWallClockMs:60000,maxActiveMs:60000,maxModelCalls:0,maxTokens:0,maxToolCalls:50,maxResources:10,maxCostMicros:null},idempotencyKey:randomUUID()}});expect(response.statusCode,response.body).toBe(202);
   const job=await env.prisma.job.findUniqueOrThrow({where:{id:response.json().jobId}}),request=job.request as unknown as {sessionId:string;snapshot:GraphSnapshot};
   const result=await runGraphSession({prisma:env.prisma,...request,artifactDir:env.artifactDir,intelligence:{url:pythonUrl,token:'browser-test'}});expect(result.verdict,JSON.stringify(result)).toBe(broken?'fail':'pass');
   expect(await env.prisma.v2Observation.count({where:{sessionId:request.sessionId,source:'browser-intent'}})).toBe(3);
   const before=posts;const replay=await app.inject({method:'POST',url:`/api/v2/sessions/${request.sessionId}/replay`});expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().graph.status).toBe('completed');expect(posts).toBe(before);expect(replay.json().externalCalls).toBe(0);
   const injected=await app.inject({method:'POST',url:`/api/v2/sessions/${request.sessionId}/replay`,payload:{faults:[{nodeId:'agent',code:'TIMEOUT'}]}});expect(injected.statusCode,injected.body).toBe(200);expect(injected.json().mode).toBe('fault-injection-replay');expect(injected.json().graph.status).toBe('failed');expect(posts).toBe(before);
   const single=await app.inject({method:'POST',url:`/api/v2/sessions/${request.sessionId}/replay`,payload:{onlyNode:'verify'}});expect(single.json().graph.nodes).toHaveLength(1);
   await env.prisma.projectMembership.updateMany({where:{projectId:project.id,userId:user.id},data:{role:'VIEWER'}});
   try{expect((await app.inject({method:'POST',url:`/api/v2/sessions/${request.sessionId}/replay`})).statusCode).toBe(403);}finally{await env.prisma.projectMembership.updateMany({where:{projectId:project.id,userId:user.id},data:{role:'ADMIN'}});}
  }
  const {registerBrowserPages}=await import('../../web/src/v2-browser.js');
  const {chromium}=await import('playwright'),cookie=(await import('@fastify/cookie')).default;
  const previousApi=process.env.API_BASE_URL;
  const apiUrl=await app.listen({host:'127.0.0.1',port:0});
  // The web client reads API_BASE_URL at request time.
  process.env.API_BASE_URL=apiUrl;
  const web=Fastify();await web.register(cookie);registerBrowserPages(web);const webUrl=await web.listen({host:'127.0.0.1',port:0});const browser=await chromium.launch();
  try{const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addCookies([{name:'web_sid',value:'browser-ui',url:webUrl}]);const page=await context.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));const response=await page.goto(webUrl+`/space/${project.id}/browser-task`);expect(response?.status()).toBe(200);expect(await page.getByRole('heading',{name:'让测试跟着页面变化'}).count()).toBe(1);
   await page.getByRole('button',{name:'＋ 添加角色'}).click();expect(await page.locator('#roles .browser-row').count()).toBe(2);
   const path=join(root,'docs/evidence/v2-ui');mkdirSync(path,{recursive:true});await page.screenshot({path:join(path,'browser-agent-desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(path,'browser-agent-mobile.png'),fullPage:true});expect(errors).toEqual([]);
  }finally{await browser.close();await web.close();if(previousApi===undefined)delete process.env.API_BASE_URL;else process.env.API_BASE_URL=previousApi;}
 }finally{
  if(oldAuthor===undefined)delete process.env.AIQA_TARGET_BROWSER_AUTHOR;else process.env.AIQA_TARGET_BROWSER_AUTHOR=oldAuthor;
  if(oldReviewer===undefined)delete process.env.AIQA_TARGET_BROWSER_REVIEWER;else process.env.AIQA_TARGET_BROWSER_REVIEWER=oldReviewer;
  if(oldPassword===undefined)delete process.env.AIQA_TARGET_BROWSER_PASSWORD;else process.env.AIQA_TARGET_BROWSER_PASSWORD=oldPassword;
  await app.close();await env.cleanup();
 }
},60000);

it('visual coordinates cannot leave the approved current element',async()=>{
 const events:BrowserEvent[]=[],h=harness(events,{plan:async(input:BrowserAgentInput)=>{const out=await plan(input);return out.actionId==='save'?{...out,point:{x:1279,y:799}}:out;}});
 try{await expect(h.run(task())).rejects.toMatchObject({code:'FORBIDDEN'});expect(events.filter(x=>x.kind==='intent')).toHaveLength(1);}finally{await h.close();}
},30000);
it('cancellation while planning causes zero later actions',async()=>{
 const controller=new AbortController(),events:BrowserEvent[]=[],h=harness(events,{signal:controller.signal,plan:async(input:BrowserAgentInput)=>{const out=await plan(input);controller.abort();return out;}});
 try{await expect(h.run(task())).rejects.toMatchObject({code:'BUDGET_EXCEEDED'});expect(events.filter(x=>x.kind==='intent')).toHaveLength(0);}finally{await h.close();}
},30000);

it('allowing a second read origin does not grant it the same write path or credentials',async()=>{
 let received=0;const receiver=createServer((_q,r)=>{received++;r.end('received');});await new Promise<void>(r=>receiver.listen(0,'127.0.0.1',r));const outside=`http://127.0.0.1:${(receiver.address() as {port:number}).port}`;
 const attacker=createServer((_q,r)=>{r.setHeader('content-type','text/html');r.end(`<button onclick="fetch('${outside}/save',{method:'POST',body:'fixture-only'})">Send</button>`);});await new Promise<void>(r=>attacker.listen(0,'127.0.0.1',r));const site=`http://127.0.0.1:${(attacker.address() as {port:number}).port}`;
 const h=harness([],{allowedOrigins:[site,outside]});
 try{await expect(h.run(BrowserAgentTask.parse({goal:'approved local post only',roles:[{id:'author',startUrl:site,writes:[{method:'POST',pathname:'/save'}]}],operations:[{id:'send',role:'author',kind:'click',target:'Send'}]}))).rejects.toMatchObject({code:'UNKNOWN_WRITE'});expect(received).toBe(0);}
 finally{await h.close();receiver.closeAllConnections();attacker.closeAllConnections();await Promise.all([new Promise<void>(r=>receiver.close(()=>r())),new Promise<void>(r=>attacker.close(()=>r()))]);}
},30000);

it('native confirm requires exact one-shot approval; mismatch is dismissed with no write',async()=>{
 for(const approved of [true,false]){
  const events:BrowserEvent[]=[],h=harness(events);const before=posts;
  const t=BrowserAgentTask.parse({goal:'Confirm approved save',roles:[{id:'author',startUrl:baseUrl+'/dialog',writes:[{method:'POST',pathname:'/save'}]}],operations:[{id:'save',role:'author',kind:'click',target:'Confirm save',dialog:{type:'confirm',message:approved?'Save?':'Different text',action:'accept'}}]});
  try{if(approved){expect((await h.run(t)).status).toBe('completed');expect(posts-before).toBe(1);expect(events.filter(x=>x.kind==='intent')).toHaveLength(2);}else{await expect(h.run(t)).rejects.toMatchObject({code:'UNKNOWN_WRITE'});expect(posts).toBe(before);}}finally{await h.close();}
 }
},30000);
