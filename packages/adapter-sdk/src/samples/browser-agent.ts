import type {CapabilityManifest} from '@ai-qa/contracts';
import type {CapabilityAdapter,CapabilityContext,CapabilityResult} from '../index.js';
const base={version:'1.0.0',protocolVersion:'aiqa.capability/2',protocol:'local-ts',entrypointRef:'@ai-qa/adapter-sdk/samples/browser-agent',permissions:{network:'environment-allowlist',declaredOrigins:[],secrets:'none',secretRefs:[]},cancel:'cooperative',timeoutMsMax:600000} as const;
export const BrowserAgentManifest:CapabilityManifest={...base,id:'platform.browser-agent',permissions:{...base.permissions,declaredOrigins:[],secretRefs:[]},effectClass:'WRITE',idempotency:'unsafe_retry',recovery:'unsafe_retry',humanName:'网站自主操作',description:'根据最新页面观察选择批准动作；独立角色、iframe、标签页；结果需由观察能力复核。',
 inputSchema:{type:'object',additionalProperties:false,required:['taskJson'],properties:{taskJson:{type:'string',minLength:2,maxLength:100000}}},
 outputSchema:{type:'object',additionalProperties:false,required:['status','completed','rounds','browserRef'],properties:{browserRef:{type:'string'},status:{type:'string',enum:['completed','blocked']},completed:{type:'array',items:{type:'string'}},rounds:{type:'integer',minimum:0},reason:{type:'string'}}}};
export const BrowserReadManifest:CapabilityManifest={...base,version:'1.1.0',id:'platform.browser-read',permissions:{...base.permissions,declaredOrigins:[],secretRefs:[]},effectClass:'READ',idempotency:'read_only',recovery:'read_only',humanName:'角色页面复核',description:'在同会话的指定角色中重新读取真实页面，不使用规划器的结论。',
 inputSchema:{type:'object',additionalProperties:false,required:['role','target','browserRef'],properties:{locatorKind:{type:'string',enum:['testId','label','text','role','download']},elementRole:{type:'string',enum:['heading','status','alert','textbox','button','link','cell','row']},browserRef:{type:'string',minLength:1,maxLength:500},role:{type:'string',minLength:1,maxLength:80},target:{type:'string',minLength:1,maxLength:200}}},
 outputSchema:{type:'object',additionalProperties:false,required:['text','visible','role','url'],properties:{text:{type:'string',nullable:true},visible:{type:'boolean'},role:{type:'string'},url:{type:'string'}}}};
export class BrowserAgentAdapter implements CapabilityAdapter{
 readonly manifest=BrowserAgentManifest;
 async execute(input:unknown,ctx:CapabilityContext):Promise<CapabilityResult>{
  if(!ctx.browser)return {status:'FAILED',output:null,resourceKeys:[],retryable:false,error:{code:'CONFIG_MISSING',message:'缺少持久化浏览器宿主'}};
  try{const result=await ctx.browser.run(JSON.parse((input as {taskJson:string}).taskJson));return {status:result.status==='completed'?'SUCCEEDED':'FAILED',output:{...result,browserRef:ctx.idempotencyKey},resourceKeys:[],retryable:false,...(result.status==='blocked'?{error:{code:'PLANNING_BLOCKED',message:result.reason!}}:{})};}
  catch(error){const code=(error as {code?:string}).code??'BROWSER_ERROR';return {status:code==='UNKNOWN_WRITE'?'UNKNOWN':'FAILED',output:null,resourceKeys:[],retryable:false,error:{code,message:'浏览器执行未完成：'+code}};}
 }
}
export const LegacyBrowserReadManifest:CapabilityManifest={...BrowserReadManifest,version:'1.0.0',inputSchema:{...BrowserReadManifest.inputSchema,properties:{...BrowserReadManifest.inputSchema.properties,locatorKind:{type:'string',enum:['testId','label','text','role']}}}};
export class BrowserReadAdapter implements CapabilityAdapter{
 constructor(readonly manifest:CapabilityManifest=BrowserReadManifest){}
 async execute(input:unknown,ctx:CapabilityContext):Promise<CapabilityResult>{
  if(!ctx.browser)throw new Error('浏览器会话不存在');const value=input as {role:string;target:string;locatorKind?:string;elementRole?:string};
  return {status:'SUCCEEDED',output:await ctx.browser.read(value.role,value.target,value.locatorKind,value.elementRole),resourceKeys:[],retryable:false};
 }
}
