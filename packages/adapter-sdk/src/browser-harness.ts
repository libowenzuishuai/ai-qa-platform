import {chromium,type Browser,type BrowserContext,type Page,type ElementHandle,type Dialog,type Download} from 'playwright';
import {startPolicyProxy,type PolicyProxy} from '@ai-qa/test-runtime';
import {BrowserAgentTask,BrowserAgentOutput,type BrowserAgentInput,type BrowserElement} from '@ai-qa/contracts';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';

export type BrowserEvent={kind:'observation'|'intent'|'receipt'|'blocked'|'network'|'auth-intent'|'download'|'console';data:unknown;screenshotPath?:string;screenshotSha256?:string;filePath?:string;fileSha256?:string};
export interface BrowserHost {
 headless?:boolean;
 allowedOrigins:string[];artifactDir:string;deadline:number;signal:AbortSignal;
 upload?(artifactId:string):Promise<{name:string;mimeType:string;buffer:Buffer}>;
 prepareRole?(role:string,page:Page):Promise<void>;
 plan(input:BrowserAgentInput,strategy:'semantic-v1'|'model-v1'):Promise<BrowserAgentOutput>;
 /** Durable host must commit intent and reserve budget before a side effect. */
 event(event:BrowserEvent):Promise<void>;
}
const failure=(code:string,message:string)=>Object.assign(new Error(message),{code});
/** One instance per execution. Cookie jars, tabs and references never cross sessions or roles. */
export class BrowserHarness {
 private browser?:Browser; private proxy?:PolicyProxy;
 private roles=new Map<string,{context:BrowserContext;page:Page;writes:Array<{method:string;pathname:string;origin?:string}>}>();
 private refs=new Map<string,{handle:ElementHandle;fingerprint:string;page:Page;element:BrowserElement}>();
 private consoleRecords:Array<{role:string;level:string;message:string}>=[];
 private network:Array<{status:number;role:string;method:string;pathname:string}>=[];private images=new Map<string,string>();private currentId='';private blocked=false;private writing:string|null=null;private networkClock=new Map<string,{active:Set<unknown>;last:number}>();private timer?:ReturnType<typeof setTimeout>;
 private downloads=new Map<string,{sha256:string;url:string}>();private downloadTask:Promise<void>=Promise.resolve();private downloadCount=0;private transferError?:Error;
 private activeOperation?:BrowserAgentTask['operations'][number];private dialogTask:Promise<void>=Promise.resolve();private dialogError?:Error;private dialogCount=0;
 constructor(private host:BrowserHost){}
 private guard(){if(this.transferError)throw this.transferError;if(this.dialogError)throw this.dialogError;if(this.host.signal.aborted||Date.now()>=this.host.deadline)throw failure('BUDGET_EXCEEDED','浏览器任务已停止');if(this.blocked||this.proxy&&Object.keys(this.proxy.stats().blocked).length)throw failure('FORBIDDEN','页面触发未批准网络请求');}
 private async event(event:BrowserEvent){this.guard();await this.host.event(event);this.guard();}
 private stop=()=>{void this.close();};
 async close(){if(this.timer)clearTimeout(this.timer);this.host.signal.removeEventListener('abort',this.stop);await this.browser?.close().catch(()=>undefined);await this.proxy?.close();this.browser=undefined;this.roles.clear();this.refs.clear();}
 private onDialog(role:string,dialog:Dialog){
  const operation=this.activeOperation,policy=operation?.dialog;
  const handle=async()=>{
   if(this.writing!==role||operation?.role!==role||!policy||++this.dialogCount>1||dialog.type()!==policy.type||dialog.message()!==policy.message){
    await dialog.dismiss();throw failure('INTERACTIVE_AUTH_REQUIRED','弹窗未批准、重复出现或内容变化，需要人工确认');
   }
   // Persist authority and charge another tool call before accepting a browser-native prompt.
   await this.event({kind:'intent',data:{operationId:operation.id,role,dialog:{type:policy.type,message:policy.message,action:policy.action}}});
   if(policy.action==='accept')await dialog.accept(policy.promptText);else await dialog.dismiss();
   await this.event({kind:'receipt',data:{operationId:operation.id,role,dialog:policy.type,status:'SUCCEEDED'}});
  };
  this.dialogTask=handle().catch(async error=>{this.dialogError=error;await dialog.dismiss().catch(()=>undefined);});
 }
 private onDownload(role:string,download:Download){
  const op=this.activeOperation;
  this.downloadTask=(async()=>{
   if(this.writing!==role||op?.role!==role||op.kind!=='download'||!op.download||++this.downloadCount>1||download.suggestedFilename()!==op.download.filename)throw failure('FORBIDDEN','下载不符合批准文件策略');
   const stream=await download.createReadStream();if(!stream)throw failure('DOWNLOAD_FAILED','下载流不可读');const chunks:Buffer[]=[];let size=0;
   for await(const chunk of stream){this.guard();size+=chunk.length;if(size>op.download.maxBytes)throw failure('BUDGET_EXCEEDED','下载文件超过上限');chunks.push(Buffer.from(chunk));}
   const bytes=Buffer.concat(chunks),sha256=createHash('sha256').update(bytes).digest('hex');mkdirSync(this.host.artifactDir,{recursive:true});
   const path=join(this.host.artifactDir,'download-'+randomUUID()+'.bin');writeFileSync(path,bytes);
   try{await this.event({kind:'download',data:{role,operationId:op.id,filename:op.download.filename,bytes:size,sha256,url:download.url()},filePath:path,fileSha256:sha256});}finally{rmSync(path,{force:true});}
   this.downloads.set(role+':'+op.id,{sha256,url:download.url()});
  })().catch(async error=>{this.transferError=error;await download.cancel().catch(()=>undefined);});
 }
 async start(task:BrowserAgentTask){
  this.guard();if(this.browser)throw failure('BROWSER_ALREADY_STARTED','一个会话只能启动一个浏览器自主节点');
  this.proxy=await startPolicyProxy({allowedOrigins:this.host.allowedOrigins,dependencyOrigins:[]});
  this.browser=await chromium.launch({headless:this.host.headless??true,proxy:{server:'per-context'}});
  this.host.signal.addEventListener('abort',this.stop,{once:true});
  this.timer=setTimeout(this.stop,Math.max(1,this.host.deadline-Date.now()));
  for(const role of task.roles){
   const url=new URL(role.startUrl);if(!this.host.allowedOrigins.includes(url.origin)||url.username||url.password)throw failure('FORBIDDEN','角色入口不在批准环境');
   const clock={active:new Set<unknown>(),last:Date.now()};this.networkClock.set(role.id,clock);
   const context=await this.browser.newContext({proxy:{server:this.proxy.url},serviceWorkers:'block',viewport:{width:1280,height:800},acceptDownloads:true});
   // Restrict browser-side writes as well as redirects/subresources. No WebSocket side channel.
   await context.route('**/*',async route=>{
    const request=route.request(),target=new URL(request.url());
    if(!this.host.allowedOrigins.includes(target.origin)||!['GET','HEAD','OPTIONS'].includes(request.method())&&(this.writing!==role.id||!role.writes.some(x=>x.method===request.method()&&x.pathname===target.pathname&&(x.origin??new URL(role.startUrl).origin)===target.origin))){
     this.blocked=true;return route.abort('blockedbyclient');
    }return route.continue();
   });
   context.on('request',request=>{clock.active.add(request);clock.last=Date.now();});
   const finished=(request:import('playwright').Request)=>{clock.active.delete(request);clock.last=Date.now();};
   context.on('requestfinished',finished);context.on('requestfailed',finished);
   context.on('response',response=>{if(this.network.length<100&&response.status()>=400)this.network.push({status:response.status(),role:role.id,method:response.request().method(),pathname:new URL(response.url()).pathname});});
   await context.routeWebSocket('**/*',socket=>socket.close());
   context.on('page',page=>{page.on('dialog',dialog=>this.onDialog(role.id,dialog));page.on('download',download=>this.onDownload(role.id,download));page.on('console',message=>{if(['error','warning'].includes(message.type())&&this.consoleRecords.length<100)this.consoleRecords.push({role:role.id,level:message.type(),message:message.text().slice(0,2000)});});});
   const page=await context.newPage();page.setDefaultTimeout(4000);
   this.roles.set(role.id,{context,page,writes:role.writes});
   if(role.authenticate){if(!this.host.prepareRole)throw failure('AUTH_REQUIRED','宿主未配置角色登录');this.writing=role.id;try{await this.host.prepareRole(role.id,page);await this.settle(role.id);}finally{this.writing=null;}}
   await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:Math.max(1,Math.min(15000,this.host.deadline-Date.now()))});
   this.guard();
  }
 }
 async settle(role:string){
  const clock=this.networkClock.get(role)!;clock.last=Date.now();const stopAt=Math.min(this.host.deadline,Date.now()+4000);
  // A previous load's networkidle event is not proof that this action has settled.
  while(clock.active.size||Date.now()-clock.last<500){this.guard();if(Date.now()>=stopAt)throw failure('ACTION_TIMEOUT','本次动作的网络请求未在期限内稳定');await new Promise(resolve=>setTimeout(resolve,25));}
 }
 async observe(){
  this.guard();for(const ref of this.refs.values())await ref.handle.dispose().catch(()=>undefined);this.refs.clear();
  const observationId=randomUUID(),elements:BrowserElement[]=[],summaries:NonNullable<BrowserAgentInput['pages']>=[];
  for(const [role,state]of this.roles){
   const pages=state.context.pages();if(pages.length>8)throw failure('BUDGET_EXCEEDED','标签页数量超过上限');
   for(const [tab,page]of pages.entries()){
    if(page.isClosed())continue;
    for(const [frameIndex,frame]of page.frames().entries()){
     if(frame.url()!=='about:blank'&&!this.host.allowedOrigins.includes(new URL(frame.url()).origin))throw failure('FORBIDDEN','iframe 不在批准环境');
     const handles=await frame.locator('button,input,textarea,select,a,[role],[contenteditable=true],[data-testid],canvas').elementHandles();
     for(const handle of handles){
      if(elements.length>=800){await handle.dispose();continue;}
      if(!await handle.isVisible()){await handle.dispose();continue;}
      const info=await handle.evaluate((el:any)=>({tag:el.tagName.toLowerCase(),type:el.getAttribute('type')??'',name:(el.getAttribute('aria-label')||el.labels?.[0]?.innerText||el.innerText||el.getAttribute('placeholder')||el.getAttribute('data-testid')||'').trim().slice(0,300),fingerprint:[el.tagName,el.getAttribute('type'),el.getAttribute('name'),el.getAttribute('aria-label'),el.getAttribute('href'),el.innerText,el.form?.action].join('|')}));
      // Password, OTP and file inputs require separately authorized preparation; never expose contents.
      const ref=`${observationId}:${elements.length}`,element={ref,role,tab,frame:frameIndex,tag:info.tag,type:info.type,name:info.name,enabled:await handle.isEnabled(),box:await handle.boundingBox()};
      elements.push(element);this.refs.set(ref,{handle,fingerprint:info.fingerprint,page,element});
     }
    }
   }
   summaries.push({role,url:state.page.url(),title:(await state.page.title()).slice(0,500),text:(await state.page.locator('body').innerText()).slice(0,8000)});
   const screenshot=await state.page.screenshot({mask:state.page.frames().map(frame=>frame.locator('input,textarea')),timeout:4000});
   mkdirSync(this.host.artifactDir,{recursive:true});const path=join(this.host.artifactDir,`browser-${observationId}-${role}.png`);writeFileSync(path,screenshot);this.images.set(role,createHash('sha256').update(screenshot).digest('hex'));
   try{await this.event({kind:'observation',data:{observationId,role,tab:state.context.pages().indexOf(state.page),url:state.page.url(),elements:elements.filter(x=>x.role===role)},screenshotPath:path,screenshotSha256:createHash('sha256').update(screenshot).digest('hex')});}finally{rmSync(path,{force:true});}
  }
  for(const record of this.consoleRecords.splice(0))await this.event({kind:'console',data:record});
  for(const record of this.network.splice(0))await this.event({kind:'network',data:record});
  this.currentId=observationId;return {observationId,elements,pages:summaries};
 }
 async act(task:BrowserAgentTask,decision:BrowserAgentOutput,completed:Set<string>){
  this.guard();if(decision.observationId!==this.currentId)throw failure('STALE_OBSERVATION','规划引用过期观察');
  const op=task.operations.find(x=>x.id===decision.actionId);
  if(!op||op.after.some(x=>!completed.has(x)))throw failure('FORBIDDEN','操作未批准或前置步骤未完成');
  const state=this.roles.get(op.role)!;
  const target=decision.elementRef?this.refs.get(decision.elementRef):undefined;
  if(['click','fill','select','hover','check','uncheck','press','upload','download'].includes(op.kind)){
   if(!target||target.element.role!==op.role||!target.element.enabled)throw failure('STALE_OBSERVATION','角色或元素引用不符');
   if((target.element.type==='password'||target.element.type==='file'&&op.kind!=='upload')||/otp|验证码|one.time/i.test(target.element.name))throw failure('INTERACTIVE_AUTH_REQUIRED','敏感输入需准备中心或人工认证');
   const fingerprint=await target.handle.evaluate((el:any)=>[el.tagName,el.getAttribute('type'),el.getAttribute('name'),el.getAttribute('aria-label'),el.getAttribute('href'),el.innerText,el.form?.action].join('|'));
   if(fingerprint!==target.fingerprint||!await target.handle.isVisible())throw failure('STALE_OBSERVATION','元素已变化，需重新观察');
   // The model cannot redirect an approved operation to a differently named control.
   if([...this.refs.values()].filter(x=>x.element.role===op.role&&x.element.name===op.target&&x.element.enabled).length!==1)throw failure('AMBIGUOUS_MATCH','操作目标存在歧义');
   if(target.element.name!==op.target)throw failure('FORBIDDEN','目标不符合批准操作');
  }
  if(op.visual&&decision.point){
   if(!target||target.page!==state.page)throw failure('STALE_OBSERVATION','视觉动作必须对应当前角色截图');
   const fresh=await state.page.screenshot({mask:state.page.frames().map(frame=>frame.locator('input,textarea')),timeout:3000});
   if(createHash('sha256').update(fresh).digest('hex')!==this.images.get(op.role))throw failure('STALE_OBSERVATION','截图已变化，需要重新观察');
   const box=target.element.box,p=decision.point;if(!box||p.x<=box.x||p.x>=box.x+box.width||p.y<=box.y||p.y>=box.y+box.height)throw failure('FORBIDDEN','视觉坐标超出批准元素');
  }
  if(op.kind==='navigate'){
   const url=new URL(op.value!,state.page.url());if(url.username||url.password||!this.host.allowedOrigins.includes(url.origin))throw failure('FORBIDDEN','导航越界');
  }
  await this.event({kind:'intent',data:{observationId:this.currentId,operation:op,elementRef:decision.elementRef}});
  // Invalidate BEFORE dispatch: a failed click never reuses the old reference.
  this.currentId='';this.writing=op.role;this.activeOperation=op;this.dialogCount=0;this.downloadCount=0;
  try{
   if(op.kind==='fill')await target!.handle.fill(op.value!);
   else if(op.kind==='select')await target!.handle.selectOption(op.value!);
   else if(op.kind==='upload'){
    if(target!.element.type!=='file'||!this.host.upload)throw failure('UPLOAD_NOT_CONFIGURED','上传需要受控文件来源和文件输入框');
    const file=await this.host.upload(op.value!);if(file.buffer.length>8388608||/[\\/]/.test(file.name))throw failure('FORBIDDEN','上传文件不符合限制');await target!.handle.setInputFiles(file);
   }
   else if(op.kind==='hover')await target!.handle.hover();
   else if(op.kind==='check'||op.kind==='uncheck')await target!.handle.setChecked(op.kind==='check');
   else if(op.kind==='press')await target!.handle.press(op.value!);
   else if(op.kind==='scroll')await state.page.mouse.wheel(0,op.value==='up'?-600:600);
   else if(op.kind==='download'){await target!.handle.click({timeout:3000});state.page=target!.page;}
   else if(op.kind==='click'){
    if(op.visual){
     const box=await target!.handle.boundingBox();if(!box||box.width<=0||box.height<=0)throw failure('STALE_OBSERVATION','视觉区域不可用');
     // Playwright checks visible, stable and unobscured before the same bounded point is clicked.
     await target!.handle.click({trial:true,timeout:3000});await target!.handle.click({position:decision.point?{x:decision.point.x-box.x,y:decision.point.y-box.y}:{x:box.width/2,y:box.height/2},timeout:3000});
    }else await target!.handle.click({timeout:3000});
    state.page=target!.page;
   }
   else if(op.kind==='navigate')await state.page.goto(new URL(op.value!,state.page.url()).href,{waitUntil:'domcontentloaded'});
   else if(op.kind==='reload')await state.page.reload({waitUntil:'domcontentloaded'});
   else if(op.kind==='switch_tab'){
    const index=Number(op.target),pages=state.context.pages();if(!Number.isInteger(index)||!pages[index])throw failure('NOT_FOUND','标签页不存在');state.page=pages[index]!;
   }else await state.page.waitForTimeout(250);
   await this.settle(op.role);await this.dialogTask;await this.downloadTask;
   if(op.kind==='download'&&this.downloadCount!==1)throw failure('DOWNLOAD_NOT_OBSERVED','未观察到批准下载');
   if(op.dialog&&this.dialogCount!==1)throw failure('DIALOG_NOT_OBSERVED','未观察到批准的弹窗');
   this.guard();await this.event({kind:'receipt',data:{actionId:op.id,status:'SUCCEEDED'}});
  }catch(error){
   await this.host.event({kind:'receipt',data:{actionId:op.id,status:'UNKNOWN',code:(error as {code?:string}).code??'ACTION_INTERRUPTED'}});
   throw failure('UNKNOWN_WRITE','操作效果需重新核对，不自动重复');
  }finally{this.writing=null;this.activeOperation=undefined;}
 }
 async run(raw:unknown){
  const task=BrowserAgentTask.parse(raw);await this.start(task);
  const completed=new Set<string>(),counts=new Map<string,number>(),seen=new Set<string>();const history:NonNullable<BrowserAgentInput['history']>=[];let stale=0;
  for(let round=0;round<task.maxRounds;round++){
   const observation=await this.observe();
   const eligible=task.operations.filter(op=>!completed.has(op.id)&&(counts.get(op.id)??0)<op.maxUses&&op.after.every(x=>completed.has(x)));
   if(!eligible.length&&!task.exploration)return {status:'completed',completed:[...completed],rounds:round};
   if(eligible.some(op=>['fill','select'].includes(op.kind)&&observation.elements.some(e=>e.role===op.role&&e.name===op.target&&(['password','file'].includes(e.type)||/otp|验证码|one.time/i.test(e.name)))))throw failure('INTERACTIVE_AUTH_REQUIRED','敏感输入只允许准备中心处理');
   const input:BrowserAgentInput={images:[],hints:[],strategy:task.strategy,promptVersion:'browser-agent-v1',goal:task.goal,...observation,operations:eligible,completed:[...completed],history,...(task.exploration?{exploration:task.exploration}:{})};
   const decision=BrowserAgentOutput.parse(await this.host.plan(input,task.strategy));
   if(decision.status==='done'&&task.exploration&&task.operations.every(op=>completed.has(op.id)))return {status:'completed',completed:[...completed],rounds:round};
   if(decision.status!=='act')return {status:'blocked',completed:[...completed],rounds:round,reason:decision.rationale};
   let effectiveTask=task;let dynamicKey:string|undefined;
   if(decision.proposed){
    const scope=task.exploration,p=decision.proposed,target=decision.elementRef?this.refs.get(decision.elementRef):undefined;
    if(!scope||decision.actionId!==null||!scope.roles.includes(p.role)||!scope.kinds.includes(p.kind))throw failure('FORBIDDEN','探索动作超出批准范围');
    if(['click','fill','select'].includes(p.kind)&&(!target||target.element.role!==p.role||!target.element.enabled))throw failure('FORBIDDEN','探索目标不是本轮可用角色元素');
    if(['reload','wait'].includes(p.kind)&&decision.elementRef)throw failure('FORBIDDEN','非元素探索不得绑定元素');
    const value=p.valueRef?scope.values.find(v=>v.id===p.valueRef):undefined;
    if(['fill','select'].includes(p.kind)?!value:p.valueRef!==undefined)throw failure('FORBIDDEN','探索输入必须引用批准数据');
    if(decision.point)throw failure('FORBIDDEN','动态探索不允许未经批准的视觉坐标');
    const operation={id:`explore_${round}`,role:p.role,kind:p.kind,target:target?.element.name??'page',...(value?{value:value.value}:{}),after:[],maxUses:1,visual:false};
    const structure=observation.elements.map(({ref,...e})=>e);
    dynamicKey=createHash('sha256').update(JSON.stringify({operation:{...operation,id:undefined},structure,pages:observation.pages})).digest('hex');
    if(seen.has(dynamicKey))throw failure('EXPLORATION_STALLED','相同页面状态下重复相同动作，停止避免循环写入');
    effectiveTask={...task,operations:[operation]};decision.actionId=operation.id;
   }else if(!eligible.some(x=>x.id===decision.actionId))throw failure('FORBIDDEN','规划选择未批准或已耗尽操作');
   try{await this.act(effectiveTask,decision,completed);stale=0;}
   catch(error){if((error as {code?:string}).code==='STALE_OBSERVATION'&&++stale<=2)continue;throw error;}
   if(dynamicKey)seen.add(dynamicKey);const executed=effectiveTask.operations.find(x=>x.id===decision.actionId)!;history.push({id:executed.id,role:executed.role,kind:executed.kind,target:executed.target,status:'SUCCEEDED'});
   completed.add(decision.actionId!);counts.set(decision.actionId!,(counts.get(decision.actionId!)??0)+1);
  }
  if(!task.exploration&&task.operations.every(x=>completed.has(x.id)))return {status:'completed',completed:[...completed],rounds:task.maxRounds};
  return {status:'blocked',completed:[...completed],rounds:task.maxRounds,reason:'轮数预算耗尽'};
 }
 /** Independent fresh read, never a model verdict or click acknowledgement. */
 async read(role:string,target:string,kind='testId',elementRole='status'){
  this.guard();if(kind==='download'){const file=this.downloads.get(role+':'+target);return {text:file?.sha256??null,visible:!!file,role,url:file?.url??''};}const state=this.roles.get(role);if(!state)throw failure('NOT_FOUND','角色不存在');
  const matches=[];
  for(const frame of state.page.frames()){
   const locator=kind==='label'?frame.getByLabel(target,{exact:true}):kind==='text'?frame.getByText(target,{exact:true}):kind==='role'?frame.getByRole(elementRole as never,{name:target,exact:true}):frame.getByTestId(target);const count=await locator.count();for(let i=0;i<count;i++)matches.push(locator.nth(i));
  }
  if(matches.length>1)throw failure('AMBIGUOUS_MATCH','观察匹配多个元素');
  const locator=matches[0];return {text:locator?await locator.evaluate((element:any)=>['INPUT','TEXTAREA','SELECT'].includes(element.tagName)?element.value:element.textContent):null,visible:locator?await locator.isVisible():false,role,url:state.page.url()};
 }
}
