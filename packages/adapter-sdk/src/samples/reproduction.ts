import {createHash} from 'node:crypto';
import type {CapabilityManifest} from '@ai-qa/contracts';
import type {CapabilityAdapter,CapabilityContext,CapabilityResult} from '../index.js';
/** The fixture service owns isolation/reset and runs a frozen oracle. No shell or arbitrary scripts. */
export const ReproductionManifest:CapabilityManifest={id:'platform.reproduction-minimize',version:'1.0.0',protocolVersion:'aiqa.capability/2',protocol:'local-ts',entrypointRef:'@ai-qa/adapter-sdk/samples/reproduction',effectClass:'WRITE',idempotency:'unsafe_retry',recovery:'unsafe_retry',cancel:'cooperative',timeoutMsMax:600000,permissions:{network:'environment-allowlist',declaredOrigins:[],secrets:'none',secretRefs:[]},humanName:'隔离复现缩减',description:'对已登记步骤做有界删减，每次先重置独立命名空间，固定构建与业务标准；清理失败保留残留。',inputSchema:{type:'object',additionalProperties:false,required:['baseUrl','buildId','oracleHash','failureKey','steps','maxTrials'],properties:{baseUrl:{type:'string',maxLength:500},buildId:{type:'string',minLength:1,maxLength:200},oracleHash:{type:'string',pattern:'^[a-f0-9]{64}$'},failureKey:{type:'string',minLength:1,maxLength:200},steps:{type:'array',items:{type:'string',minLength:1,maxLength:100},},maxTrials:{type:'integer',minimum:2,maximum:30}}},outputSchema:{type:'object',additionalProperties:false,required:['candidate','trials','minimal','verified','recordJson'],properties:{candidate:{type:'array',items:{type:'string'}},trials:{type:'integer'},minimal:{type:'boolean'},verified:{type:'boolean'},recordJson:{type:'string'}}}};
export class ReproductionAdapter implements CapabilityAdapter{
 readonly manifest=ReproductionManifest;
 async execute(raw:unknown,ctx:CapabilityContext):Promise<CapabilityResult>{
  const input=raw as {baseUrl:string;buildId:string;oracleHash:string;failureKey:string;steps:string[];maxTrials:number};
  const root=new URL(input.baseUrl);if(!ctx.allowedOrigins.includes(root.origin)||root.username||root.password||!['http:','https:'].includes(root.protocol))return {status:'FAILED',output:null,resourceKeys:[],retryable:false,error:{code:'FORBIDDEN',message:'复现服务未授权'}};
  if(!ctx.beforeEffect)return {status:'FAILED',output:null,resourceKeys:[],retryable:false,error:{code:'CONFIG_MISSING',message:'复现需持久宿主记录每次调用'}};
  const records:unknown[]=[],residual=new Set<string>();let trials=0;
  const scope=createHash('sha256').update(ctx.idempotencyKey).digest('hex').slice(0,24);
  const call=async(action:string,namespace:string,steps:string[])=>{
   await ctx.beforeEffect!({action:'reproduction:'+action,resourceKey:namespace,creates:action==='reset'});
   if(ctx.signal.aborted||Date.now()>=ctx.deadline)throw Error('BUDGET_EXCEEDED');
   const response=await fetch(new URL('/aiqa/reproduction/'+action,root),{method:'POST',redirect:'error',signal:AbortSignal.any([ctx.signal,AbortSignal.timeout(Math.max(1,Math.min(15000,ctx.deadline-Date.now())))]),headers:{'content-type':'application/json'},body:JSON.stringify({namespace,buildId:input.buildId,oracleHash:input.oracleHash,steps,idempotencyKey:namespace+':'+action})});
   if(!response.ok||!response.body)throw Error('FIXTURE_UNAVAILABLE');const reader=response.body.getReader(),chunks:Buffer[]=[];let bytes=0;try{while(true){const item=await reader.read();if(item.done)break;bytes+=item.value.byteLength;if(bytes>65536)throw Error('FIXTURE_OUTPUT_TOO_LARGE');chunks.push(Buffer.from(item.value));}}finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}const data=Buffer.concat(chunks).toString();
   const value=JSON.parse(data);if(value.namespace!==namespace||value.buildId!==input.buildId||value.oracleHash!==input.oracleHash)throw Error('FIXTURE_IDENTITY_MISMATCH');records.push({action,namespace,steps,response:value});await ctx.afterEffect?.({action:'reproduction:'+action,resourceKey:namespace,response:value});return value;
  };
  const trial=async(steps:string[])=>{
   const namespace=`aiqa-${scope}-${trials++}`;residual.add(namespace);
   try{const reset=await call('reset',namespace,[]);if(reset.clean!==true)throw Error('RESET_NOT_VERIFIED');const result=await call('trial',namespace,steps);if(!['pass','fail'].includes(result.verdict)||!Array.isArray(result.evidence)||!result.evidence.length)throw Error('TRIAL_NOT_VERIFIED');return result.verdict==='fail'&&result.failureKey===input.failureKey;}
   finally{try{const cleanup=await call('cleanup',namespace,[]);if(cleanup.clean!==true)throw Error('CLEANUP_NOT_VERIFIED');residual.delete(namespace);}catch(error){throw new Error('CLEANUP_REQUIRED',{cause:error});}}
  };
  try{
   let candidate=[...input.steps];if(!candidate.length||candidate.length>100||new Set(candidate).size!==candidate.length)throw Error('INVALID_STEPS');
   if(!await trial(candidate))throw Error('ORIGINAL_FAILURE_NOT_REPRODUCED');
   let index=0;while(index<candidate.length&&trials<input.maxTrials){const next=candidate.filter((_,i)=>i!==index);if(await trial(next)){candidate=next;index=0;}else index++;}
   return {status:'SUCCEEDED',output:{candidate,trials,minimal:index>=candidate.length,verified:true,recordJson:JSON.stringify(records)},resourceKeys:[],retryable:false};
  }catch(error){return {status:residual.size?'UNKNOWN':'FAILED',output:{candidate:input.steps,trials,minimal:false,verified:false,recordJson:JSON.stringify(records)},resourceKeys:[...residual],retryable:false,error:{code:(error as Error).message,message:'复现或清理未完成；保留原始失败，不自动重做未知写入'}};}
 }
}
