import { ApiRequestTemplate, type PlanAssertion } from '@ai-qa/contracts';
import { compareAssertion, type AssertionValue } from './assertions.js';
import { checkDestination, type NavigationPolicy } from './navigation-policy.js';
export async function checkApi(input: { template: unknown; assertion: PlanAssertion; baseUrl: string; policy: NavigationPolicy; resolveCredential: (ref:string)=>string|undefined; timeoutMs: number }) {
  const t=ApiRequestTemplate.parse(input.template);
  const url=new URL(t.path,input.baseUrl).href;
  if(!checkDestination(url,{allowedOrigins:input.policy.allowedOrigins,dependencyOrigins:[]}).allowed) throw new Error('API 目标不在授权范围');
  const secret=t.credentialRef?input.resolveCredential(t.credentialRef):undefined;
  if(t.credentialRef&&!secret)throw new Error('API 凭据缺失');
  const response=await fetch(url,{method:t.method,headers:{'content-type':'application/json',...(secret?{authorization:`Bearer ${secret}`}:{})},body:t.body?JSON.stringify(t.body):undefined,redirect:'manual',signal:AbortSignal.timeout(Math.max(1,Math.min(t.timeoutMs,input.timeoutMs)))});
  // No credentials or response payload are persisted. Retain only the observed field and status.
  let actual:unknown=response.status;
  if(t.responseField!=='status'){
    const reader=response.body!.getReader();const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>1024*1024)throw new Error('API 响应超限');chunks.push(part.value);}}finally{await reader.cancel();}
    actual=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    for(const key of t.responseField.split('.').slice(1)) actual=actual&&typeof actual==='object'?(actual as Record<string,unknown>)[key]:undefined;
  }else await response.body?.cancel();
  if(actual!==null&&!['string','number','boolean'].includes(typeof actual))return {actual:null,result:'REVIEW' as const,note:'接口字段不存在或不是可比较标量',status:response.status};
  if(typeof actual==='string'&&secret&&actual.includes(secret))return {actual:null,result:'REVIEW' as const,note:'目标字段含凭据，证据已阻止保存',status:response.status};
  const checked=compareAssertion(input.assertion.operator,input.assertion.expected??null,actual as AssertionValue);
  return {actual:actual as AssertionValue,...checked,status:response.status};
}
