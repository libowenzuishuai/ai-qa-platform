import {EnvironmentRuntime} from '@ai-qa/contracts';
export type FrozenBuildProbe = NonNullable<ReturnType<typeof EnvironmentRuntime.parse>['buildProbe']>;
/** A small, read-only identity request. Redirects, inherited properties and oversized payloads are rejected. */
export async function inspectBuild(input:{baseUrl:string;probe:FrozenBuildProbe;expected:string;allowedOrigins:string[];signal:AbortSignal;deadline:number}){
 const observedAt=new Date().toISOString();let observed:unknown=null;
 try{
  const target=new URL(input.probe.path,input.baseUrl);
  if(!['http:','https:'].includes(target.protocol)||target.username||target.password||!input.allowedOrigins.includes(target.origin))throw Error('构建查询地址不在授权范围');
  const response=await fetch(target,{redirect:'error',headers:{'cache-control':'no-cache'},signal:AbortSignal.any([input.signal,AbortSignal.timeout(Math.max(1,Math.min(5000,input.deadline-Date.now())))])});
  if(!response.ok||!response.body)throw Error('构建查询不可用');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
  try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>16384)throw Error('构建响应超限');chunks.push(part.value);}}finally{await reader.cancel();}
  observed=JSON.parse(Buffer.concat(chunks).toString());
  for(const key of input.probe.field.split('.'))observed=observed&&typeof observed==='object'&&Object.hasOwn(observed,key)?(observed as Record<string,unknown>)[key]:null;
  if(typeof observed!=='string'||observed.length>200)observed=null;
  return {verified:observed===input.expected,expected:input.expected,observed,observedAt,reason:observed===input.expected?'构建身份一致':'构建身份缺失或已变化'};
 }catch{return {verified:false,expected:input.expected,observed:null,observedAt,reason:'构建身份无法核验'};}
}
