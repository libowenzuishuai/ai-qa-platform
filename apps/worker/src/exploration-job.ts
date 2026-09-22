/// <reference lib="dom" />
import type {PrismaClient,Prisma} from '@prisma/client';
import type {ArtifactStore} from '@ai-qa/artifact-store';
import {ExplorationRequest,ExplorationResult} from '@ai-qa/contracts';
import {checkDestination} from '@ai-qa/test-runtime';
import {chromium} from 'playwright';
import {createHash} from 'node:crypto';
type Job={id:string;projectId:string;request:unknown;startedAt:Date|null};
const fail=(message:string,code='VALIDATION_ERROR')=>Object.assign(new Error(message),{code});
/** Approved GET-only entry points, anonymous context, scripts and browser networking disabled.
 * Links are recorded as unverified candidates; no inferred requirement or action is approved here. */
export async function runExploration(db:PrismaClient,store:ArtifactStore,job:Job,signal:AbortSignal|undefined,commit:(db:PrismaClient,job:Job,persist:(tx:Prisma.TransactionClient)=>Promise<void>)=>Promise<void>){
 const {environmentRevision,createdBy,...body}=job.request as any;
 delete body.bodyHash;const input=ExplorationRequest.parse(body);
 const environment=await db.environment.findFirst({where:{id:input.environmentId,projectId:job.projectId,revision:environmentRevision,isProduction:false}});
 if(!environment)throw fail('环境已变化','CONFLICT');
 const member=await db.projectMembership.findFirst({where:{projectId:job.projectId,userId:createdBy,role:{in:['LEAD','ADMIN']}}});if(!member)throw fail('执行权限已撤销','FORBIDDEN');
 const approved=new Set(input.paths.map(path=>new URL(path,environment.baseUrl).href));
 const policy={allowedOrigins:environment.allowedOrigins,dependencyOrigins:[]};
 for(const url of approved)if(new URL(url).origin!==new URL(environment.baseUrl).origin||!checkDestination(url,policy).allowed)throw fail('入口不在本环境白名单');
 const timeout=AbortSignal.timeout(input.maxDurationMs),control=AbortSignal.any([timeout,...signal?[signal]:[]]);
 const browser=await chromium.launch({headless:true});
 const abort=()=>{void browser.close().catch(()=>undefined);};control.addEventListener('abort',abort,{once:true});
 const pages:any[]=[],files:Array<{type:string;storageKey:string;checksum:string}>=[],seen=new Set<string>();let stopReason:ReturnType<typeof ExplorationResult.parse>['stopReason']='COMPLETED',duplicates=0;
 try{
  const context=await browser.newContext({javaScriptEnabled:false,serviceWorkers:'block',acceptDownloads:false});
  await context.route('**/*',route=>route.abort());
  for(const initial of approved){
   if(control.aborted){if(signal?.aborted)throw fail('探索已取消','CONFLICT');stopReason='BUDGET_EXCEEDED';break;}
   let url=initial,response:Response|undefined;
   for(let redirects=0;redirects<=3;redirects++){
    if(!approved.has(url)||!checkDestination(url,policy).allowed){stopReason='SCOPE_BLOCKED';break;}
    response=await fetch(url,{method:'GET',redirect:'manual',signal:control,headers:{accept:'text/html'}});
    if([301,302,303,307,308].includes(response.status)){
     const location=response.headers.get('location');await response.body?.cancel();response=undefined;
     if(!location||redirects===3){stopReason='SCOPE_BLOCKED';break;}
     url=new URL(location,url).href;continue;
    }
    break;
   }
   if(stopReason!=='COMPLETED'||!response)break;
   if([401,403].includes(response.status)){await response.body?.cancel();stopReason='AUTH_REQUIRED';break;}
   if(!response.ok||!response.headers.get('content-type')?.includes('text/html')){await response.body?.cancel();throw fail('入口未返回可观察 HTML');}
   const reader=response.body!.getReader(),chunks:Uint8Array[]=[];let size=0;
   try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>2*1024*1024)throw fail('页面超过 2MB 探索预算','BUDGET_EXCEEDED');chunks.push(part.value);}}finally{await reader.cancel();}
   const charset=/charset=([^;\s]+)/i.exec(response.headers.get('content-type')??'')?.[1]?.replace(/["']/g,'').toLowerCase();
   if(charset&&!['utf-8','utf8','us-ascii'].includes(charset))throw fail('探索首版只支持 UTF-8 HTML');
   const html=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)),page=await context.newPage();
   // Render captured bytes without executing the target's JavaScript or issuing subrequests.
   await page.route(url,route=>route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:html,headers:{'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; sandbox"}}),{times:1});
   await page.goto(url,{waitUntil:'domcontentloaded',timeout:Math.min(10000,input.maxDurationMs)});
   const text=(await page.locator('body').innerText()).slice(0,20000),hash=createHash('sha256').update(text).digest('hex');
   if(seen.has(hash))duplicates++;else{seen.add(hash);duplicates=0;}
   const links=await page.locator('a[href]').evaluateAll(els=>els.slice(0,100).map(el=>({text:(el.textContent??'').trim().slice(0,200),href:el.getAttribute('href')})));
   const candidates=links.flatMap(link=>{try{const candidate=new URL(link.href??'',url);return candidate.origin===new URL(environment.baseUrl).origin?[{text:link.text,path:candidate.pathname,approved:false}]:[];}catch{return [];}});
   const shot=store.put({runId:'explore-'+job.id,attemptId:'anonymous',filename:pages.length+'.png',data:await page.screenshot()});files.push({type:'EXPLORATION_SCREENSHOT',storageKey:shot.storageKey,checksum:shot.checksum});
   pages.push({url,title:await page.title(),text,hash,candidates,screenshotIndex:files.length-1});
   const login=await page.locator('input[type=password]').count();await page.close();
   if(login){stopReason='AUTH_REQUIRED';break;}if(duplicates>=2){stopReason='NO_PROGRESS';break;}
  }
 }catch(error){if(signal?.aborted)throw fail('探索已取消','CONFLICT');if(timeout.aborted)stopReason='BUDGET_EXCEEDED';else throw error;}
 finally{control.removeEventListener('abort',abort);await browser.close();}
 await commit(db,job,async tx=>{
  if(!await tx.environment.findFirst({where:{id:environment.id,projectId:job.projectId,revision:environmentRevision}}))throw fail('探索期间环境已变化','CONFLICT');
  const artifactIds=[];for(const file of files)artifactIds.push((await tx.artifact.create({data:{projectId:job.projectId,sensitivity:'RESTRICTED_RAW',...file}})).id);
  const captured=store.put({runId:'explore-'+job.id,attemptId:'summary',filename:'exploration.json',data:Buffer.from(JSON.stringify({environmentId:environment.id,environmentRevision,pages,artifactIds,stopReason,mode:'anonymous-static',notice:'观察与候选入口，不是批准规则；脚本、子资源和交互未执行，不能据此声称业务通过。'}))});
  const artifact=await tx.artifact.create({data:{projectId:job.projectId,type:'EXPLORATION_BUNDLE',sensitivity:'RESTRICTED_RAW',storageKey:captured.storageKey,checksum:captured.checksum}});
  await tx.job.update({where:{id:job.id},data:{status:'SUCCEEDED',finishedAt:new Date(),result:ExplorationResult.parse({artifactId:artifact.id,pageCount:pages.length,stopReason})}});
 });
}
