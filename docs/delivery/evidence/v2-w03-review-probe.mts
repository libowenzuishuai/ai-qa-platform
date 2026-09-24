import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
const root=process.argv[2];
const imp=(p:string)=>import(pathToFileURL(`${root}/${p}`).href);
const {computeManifestHash}=await imp('packages/contracts/src/index.ts') as any;
const realHash=(m:any)=>computeManifestHash(m);
const {WorkflowDefinitionContent}=await imp('packages/contracts/src/v2/graph.ts');
const {executeGraph}=await imp('apps/worker/src/v2/graph-executor.ts');
const {registerLocalAdapter}=await imp('apps/worker/src/v2/capability-registry.ts');
const {invokeCapability}=await imp('apps/worker/src/v2/capability-invoker.ts');
const {HttpReadManifest}=await imp('packages/adapter-sdk/src/samples/http-checker.ts');
const {selfCheckSchema,validateAgainstSchema}=await imp('packages/adapter-sdk/src/index.ts');
const out:any={method:'Actual source functions; in-memory Prisma stub, not DB integration; local HTTP servers for redirect only',probes:{}};
const mk=(id:string,execute:any)=>{const manifest={...HttpReadManifest,id,inputSchema:{type:'object',properties:{item:{type:'integer'}},additionalProperties:false},outputSchema:{type:'object',properties:{done:{type:'boolean'}},required:['done'],additionalProperties:false}};registerLocalAdapter({manifest,execute});return manifest};
const db=(manifest:any,endpoint?:string,manifestHash?:string)=>{
  const store={v2AdapterInstallation:{findFirst:async()=>({id:'install',projectId:'proj',status:'AUTHORIZED',manifestHash:manifestHash??'same',endpoint,authorization:{scope:['read:http']}}),findUniqueOrThrow:async()=>({id:'install',projectId:'proj',status:'AUTHORIZED',manifestHash:manifestHash??'same',endpoint,authorization:{scope:['read:http']}})},v2CapabilityManifest:{findUnique:async()=>({manifest,manifestHash:manifestHash??'same'})}};
  // R0.1 修复引入锁内复核（$transaction+$queryRaw）——替身透传。
  const tx={...store,$queryRaw:async()=>[]};
  return {...store,$queryRaw:async()=>[],$transaction:async(fn:any)=>fn(tx)};
};
const ok=()=>({status:'SUCCEEDED',output:{done:true},resourceKeys:[],retryable:false});
const fail=()=>({status:'FAILED',output:null,resourceKeys:[],retryable:false,error:{code:'TRANSIENT',message:'first failure'}});
const base=(manifest:any,node:any,taskInput:any={})=>({prisma:db(manifest,undefined,realHash(manifest)),projectId:'proj',definition:{name:'Review graph',description:'',maxSubflowDepth:4,nodes:[{nodeId:'n',capabilityId:manifest.id,capabilityVersion:'1.0.0',dependsOn:[],bindings:{},onFailure:'fail',...node}]},taskInput,deadline:Date.now()+5000,signal:new AbortController().signal,allowedOrigins:[],executionKey:'review-exec'});
let calls=0;
let m=mk('review.retry',async()=>++calls===1?fail():ok());
let r=await executeGraph(base(m,{retry:{maxAttempts:2,retryableErrorClasses:['TRANSIENT'],totalDeadlineMs:1000}}));
out.probes.retryFalse={calls,status:r.status,firstFailure:r.firstFailure,attempts:r.nodes[0].attempts};
calls=0;m=mk('review.repeat',async()=>{calls++;return ok()});
r=await executeGraph(base(m,{repeat:{maxIterations:3,exitWhen:{left:{source:'node',nodeId:'n',path:'done',type:'boolean'},operator:'eq',right:{source:'constant',value:true,type:'boolean'},onUnknown:'require_human'}}}));
out.probes.repeatCurrentOutput={calls,status:r.status};
calls=0;m=mk('review.map',async()=>{calls++;return calls===1?fail():ok()});
r=await executeGraph(base(m,{map:{inputSet:{source:'input',path:'items',type:'json'},maxItems:5,maxConcurrency:2}},{items:[0,1]}));
out.probes.mapAccounting={actualCalls:calls,recordedItems:r.nodes[0].items.length,status:r.status};
calls=0;m=mk('review.expired',async()=>{calls++;return ok()});
r=await executeGraph({...base(m,{}),deadline:Date.now()-1000});
out.probes.expiredDeadline={calls,status:r.status};
const badSchema={type:'string',pattern:'['};
out.probes.invalidPattern={selfCheck:selfCheckSchema(badSchema)};
try{out.probes.invalidPattern.validation=validateAgainstSchema('a',badSchema)}catch(e:any){out.probes.invalidPattern.thrown=e.name}
let received=0,receivedValue=false;
const receiver=createServer((req,res)=>{received++;let text='';req.on('data',c=>text+=c);req.on('end',()=>{receivedValue=text.includes('synthetic-private-input');res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(ok()))})});
const listen=(s:any)=>new Promise<void>(resolve=>s.listen(0,'127.0.0.1',resolve));
await listen(receiver);const receiverUrl=`http://127.0.0.1:${(receiver.address() as any).port}`;
const redirect=createServer((_req,res)=>{res.writeHead(307,{location:receiverUrl+'/outside'});res.end()});
await listen(redirect);const endpoint=`http://127.0.0.1:${(redirect.address() as any).port}`;
try{
const remote={...HttpReadManifest,id:'review.remote',protocol:'remote-http',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false},outputSchema:{type:'object',properties:{done:{type:'boolean'}},required:['done'],additionalProperties:false}};
await invokeCapability({prisma:db(remote,endpoint,realHash(remote)),projectId:'proj',capabilityId:remote.id,capabilityVersion:'1.0.0',input:{value:'synthetic-private-input'},deadline:Date.now()+3000,idempotencyKey:'review-key',signal:new AbortController().signal,allowedOrigins:[endpoint],invocationId:'review-invocation'});
out.probes.remoteRedirect={secondReceiverRequests:received,syntheticInputReceived:receivedValue};
}finally{redirect.closeAllConnections();receiver.closeAllConnections();await Promise.all([new Promise<void>(r=>redirect.close(()=>r())),new Promise<void>(r=>receiver.close(()=>r()))])}
out.probes.bindingShape={ordinaryPath:WorkflowDefinitionContent.safeParse(base(m,{map:{inputSet:{source:'input',path:'items',type:'json'},maxItems:5,maxConcurrency:2}},{items:[0,1]}).definition).success};
console.log(JSON.stringify(out,null,2));
