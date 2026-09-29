import type {Page} from 'playwright';
import {LoginPreparationConfig,EnvironmentRuntime} from '@ai-qa/contracts';
import {loginLocator} from '../login-check-job.js';
import {makeCredentialResolver} from '../credentials.js';
export async function prepareBrowserRole(page:Page,configuration:unknown,runtime:unknown,baseUrl:string,allowedOrigins:string[],deadline:number,beforeStep:()=>Promise<void>,takeover?:()=>Promise<void>){
 const config=LoginPreparationConfig.parse(configuration),env=EnvironmentRuntime.parse(runtime),resolve=makeCredentialResolver(env.secretRefs);
 const url=new URL(config.loginPath,baseUrl);if(!allowedOrigins.includes(url.origin))throw Object.assign(new Error('AUTH_ORIGIN_FORBIDDEN'),{code:'AUTH_ORIGIN_FORBIDDEN'});
 let handedOff=false;const handoff=async()=>{if(!takeover||handedOff)throw Object.assign(new Error("INTERACTIVE_AUTH_REQUIRED"),{code:"INTERACTIVE_AUTH_REQUIRED"});handedOff=true;await takeover();};
 const timeout=()=>Math.max(1,Math.min(5000,deadline-Date.now()));
 for(const step of config.steps)if(step.type==='fill'&&!resolve(step.value.ref))throw Object.assign(new Error('AUTH_CREDENTIAL_MISSING'),{code:'AUTH_CREDENTIAL_MISSING'});
 await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:timeout()});
 for(const step of config.steps){
  await beforeStep();
  if(Date.now()>=deadline)throw Object.assign(new Error('AUTH_TIMEOUT'),{code:'AUTH_TIMEOUT'});
  if(config.interactiveIndicator&&await loginLocator(page,config.interactiveIndicator).isVisible()){await handoff();break;}
  const locator=loginLocator(page,step.locator);await locator.waitFor({state:'visible',timeout:timeout()});
  if(await locator.count()!==1)throw Object.assign(new Error('AUTH_AMBIGUOUS'),{code:'AUTH_AMBIGUOUS'});
  if(step.type==='fill')await locator.fill(resolve(step.value.ref)!,{timeout:timeout()});else await locator.click({timeout:timeout()});
 }
 const success=loginLocator(page,config.successIndicator.locator);const observeUntil=Date.now()+timeout();
 while(!await success.isVisible()&&Date.now()<observeUntil){if(config.interactiveIndicator&&await loginLocator(page,config.interactiveIndicator).isVisible()){await handoff();break;}await new Promise(r=>setTimeout(r,100));}
 await success.waitFor({state:'visible',timeout:timeout()});
 if(await success.count()!==1||config.successIndicator.expectedText!==undefined&&(await success.textContent())!==config.successIndicator.expectedText||config.successIndicator.expectedUrl&&new URL(page.url()).pathname!==config.successIndicator.expectedUrl)throw Object.assign(new Error('AUTH_NOT_VERIFIED'),{code:'AUTH_NOT_VERIFIED'});
}
