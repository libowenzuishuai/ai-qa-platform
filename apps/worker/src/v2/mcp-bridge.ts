import {canonicalStringify,type CapabilityManifest} from '@ai-qa/contracts';
import type {CapabilityContext,CapabilityResult} from '@ai-qa/adapter-sdk';

const VERSION='2025-06-18';
const MAX_BYTES=4*1024*1024;
/** Selected-tool MCP bridge. Server descriptions and annotations never grant permissions. */
export async function invokeMcp(endpoint:string,manifest:CapabilityManifest,input:unknown,ctx:CapabilityContext,invocationId:string):Promise<CapabilityResult>{
 const url=new URL(endpoint);
 const failed=(code:string,message:string,status:CapabilityResult['status']='FAILED'):CapabilityResult=>({status,output:null,resourceKeys:[],retryable:false,error:{code,message}});
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash)return failed('VALIDATION_ERROR','MCP 地址必须是无内嵌凭据的 HTTP 地址');
 if(!/^[a-zA-Z0-9_.-]{1,128}$/.test(manifest.entrypointRef))return failed('VALIDATION_ERROR','MCP 工具名无效');
 let sessionId:string|undefined,sequence=0,dispatched=false,activeId:string|undefined;
 const headers:Record<string,string>={'content-type':'application/json',accept:'application/json, text/event-stream','MCP-Protocol-Version':VERSION};
 try{
  if(manifest.permissions.secrets==='declared-refs-only'){
   if(manifest.permissions.secretRefs.length!==1)return failed('CONFIG_MISSING','MCP 鉴权只允许一个已声明令牌引用');
   headers.authorization=`Bearer ${await ctx.resolveSecret(manifest.permissions.secretRefs[0]!)}`;
  }
  const signal=AbortSignal.any([ctx.signal,AbortSignal.timeout(Math.max(1,ctx.deadline-Date.now()))]);
  async function post(body:unknown,requestSignal=signal){
   const response=await fetch(url,{method:'POST',redirect:'error',headers:{...headers,...(sessionId?{'Mcp-Session-Id':sessionId}:{})},body:JSON.stringify(body),signal:requestSignal});
   if(!response.ok){await response.body?.cancel();throw Error(`MCP_HTTP_${response.status}`);}
   return response;
  }
  async function rpc(method:string,params:unknown){
   if(signal.aborted||Date.now()>=ctx.deadline)throw Error('MCP_STOPPED');
   const id=`${invocationId}-${++sequence}`;activeId=id;
   if(method==='tools/call')dispatched=true;
   const response=await post({jsonrpc:'2.0',id,method,params});
   if(method==='initialize'){
    const assigned=response.headers.get('mcp-session-id');
    if(assigned){if(!/^[\x21-\x7E]{1,512}$/.test(assigned))throw Error('MCP_SESSION_INVALID');sessionId=assigned;}
   }
   const reader=response.body?.getReader();if(!reader)throw Error('MCP_EMPTY_RESPONSE');
   const sse=(response.headers.get('content-type')??'').includes('text/event-stream');
   if(!sse&&!(response.headers.get('content-type')??'').includes('application/json')){await reader.cancel();throw Error('MCP_MEDIA_TYPE');}
   const decoder=new TextDecoder();let buffer='',bytes=0;
   const accept=(message:Record<string,unknown>)=>{
    if(message.jsonrpc!=='2.0')throw Error('MCP_PROTOCOL_INVALID');
    if('method' in message){if('id'in message)throw Error('MCP_SERVER_REQUEST_UNSUPPORTED');return undefined;}
    if(message.id!==id)throw Error('MCP_RESPONSE_ID_MISMATCH');
    if(message.error)throw Error('MCP_RPC_ERROR');
    if(!('result'in message))throw Error('MCP_MISSING_RESULT');return message.result;
   };
   try{
    while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>MAX_BYTES)throw Error('MCP_RESPONSE_TOO_LARGE');buffer+=decoder.decode(part.value,{stream:true});
     if(sse){buffer=buffer.replace(/\r\n/g,'\n');let end:number;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!data)continue;const value=accept(JSON.parse(data));if(value!==undefined)return value;}}
    }
    buffer+=decoder.decode();if(sse)throw Error('MCP_STREAM_INTERRUPTED');return accept(JSON.parse(buffer));
   }finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
  }
  const init=await rpc('initialize',{protocolVersion:VERSION,capabilities:{},clientInfo:{name:'aiqa-controlled-bridge',version:'2.0.0'}}) as {protocolVersion:string;capabilities?:{tools?:unknown}};
  if(init.protocolVersion!==VERSION||!init.capabilities?.tools)return failed('CONFLICT','MCP 版本或工具能力不匹配');
  const notification=await post({jsonrpc:'2.0',method:'notifications/initialized'});await notification.body?.cancel();
  // Never discover tools from a model-selected URL or automatically import all tools.
  let cursor:string|undefined,selected:{name:string;inputSchema:unknown;outputSchema?:unknown}|undefined;
  for(let page=0;page<10;page++){
   const listed=await rpc('tools/list',cursor?{cursor}:{}) as {tools?:Array<{name:string;inputSchema:unknown;outputSchema?:unknown}>;nextCursor?:string};
   if(!Array.isArray(listed.tools)||listed.tools.length>1000)throw Error('MCP_CATALOG_INVALID');
   const matches=listed.tools.filter(t=>t.name===manifest.entrypointRef);
   if(matches.length>1||selected&&matches.length)throw Error('MCP_TOOL_AMBIGUOUS');
   selected=matches[0]??selected;cursor=listed.nextCursor;
   if(!cursor)break;
   if(page===9)throw Error('MCP_CATALOG_LIMIT');
  }
  if(!selected)return failed('NOT_FOUND','安装所固定的 MCP 工具已不存在');
  if(canonicalStringify(selected.inputSchema)!==canonicalStringify(manifest.inputSchema)||canonicalStringify(selected.outputSchema??null)!==canonicalStringify(manifest.outputSchema))return failed('CONFLICT','MCP 输入或输出 Schema 已变化，需重新审核安装');
  const result=await rpc('tools/call',{name:manifest.entrypointRef,arguments:input,_meta:{'aiqa/idempotencyKey':ctx.idempotencyKey}}) as {isError?:boolean;structuredContent?:unknown};
  if(result.isError)return failed('DEPENDENCY_UNAVAILABLE','MCP 工具报告执行错误',manifest.effectClass==='READ'?'FAILED':'UNKNOWN');
  if(result.structuredContent===undefined)return failed('MODEL_OUTPUT_INVALID','MCP 缺少结构化输出',manifest.effectClass==='READ'?'FAILED':'UNKNOWN');
  return {status:'SUCCEEDED',output:result.structuredContent,resourceKeys:[],retryable:false};
 }catch{
  if(activeId&&(ctx.signal.aborted||Date.now()>=ctx.deadline)){
   void fetch(url,{method:'POST',redirect:'error',headers:{...headers,...(sessionId?{'Mcp-Session-Id':sessionId}:{})},body:JSON.stringify({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:activeId,reason:'Host cancelled or deadline exceeded'}}),signal:AbortSignal.timeout(1000)}).then(r=>r.body?.cancel()).catch(()=>undefined);
  }
  return failed(ctx.signal.aborted?'CANCELLED':'DEPENDENCY_UNAVAILABLE','MCP 调用未完成；写入结果需核对',dispatched&&manifest.effectClass!=='READ'?'UNKNOWN':ctx.signal.aborted?'CANCELLED':'FAILED');
 }finally{
  if(sessionId)void fetch(url,{method:'DELETE',redirect:'error',headers:{...headers,'Mcp-Session-Id':sessionId},signal:AbortSignal.timeout(1000)}).then(r=>r.body?.cancel()).catch(()=>undefined);
 }
}
