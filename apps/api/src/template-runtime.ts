import {capabilityValidator} from './capability-schema.js';
import type {Prisma,PrismaClient} from '@prisma/client';
import {TemplateNodeDefinition,WorkflowTemplateVersion,canonicalStringify} from '@ai-qa/contracts';
import {ApiError} from './errors.js';
import {z} from 'zod';
export const HANDLERS:Record<string,string>={
 'document-parse':'document_parse','rule-extract':'rule_suggest','rule-approval-gate':'rule_approval_gate','case-generate':'case_suggest','case-approval-gate':'case_approval_gate','page-observe':'page_observation','plan-approval-gate':'plan_proposal_gate','login-check':'preparation_check','browser-execute':'execution','evaluate':'evaluation','code-check':'code_check',
};
export type Node=z.infer<typeof TemplateNodeDefinition>;
const outputs:Record<string,Record<string,string>>={document_parse:{documentVersionIds:'ids'},rule_suggest:{ruleVersionIds:'ids',clarificationIds:'ids'},rule_approval_gate:{ruleVersionIds:'ids'},case_suggest:{caseVersionIds:'ids'},case_approval_gate:{caseVersionIds:'ids'},page_observation:{artifactId:'id'},plan_proposal_gate:{pinnedPlans:'plans'},preparation_check:{checkedRoleCount:'number'},execution:{runId:'id'},evaluation:{runId:'id',acceptanceStatus:'string'},code_check:{checkId:'id',verdict:'string'}};
const inputs:Record<string,string>={documentVersionIds:'ids',baselineId:'id',buildId:'string',caseVersionIds:'ids',ruleVersionIds:'ids',observationId:'id',pinnedPlans:'plans',runId:'id'};
const allowed:Record<string,string[]>={document_parse:['documentVersionIds'],rule_suggest:['documentVersionIds'],rule_approval_gate:['ruleVersionIds'],case_suggest:['ruleVersionIds'],case_approval_gate:['caseVersionIds'],page_observation:['caseVersionIds'],plan_proposal_gate:['caseVersionIds','observationId'],preparation_check:['caseVersionIds'],execution:['caseVersionIds','ruleVersionIds','pinnedPlans'],evaluation:['runId'],code_check:[]};
export function ancestors(nodes:Node[],key:string):Set<string>{const seen=new Set<string>();const visit=(k:string)=>{for(const d of nodes.find(n=>n.key===k)?.dependsOn??[])if(!seen.has(d)){seen.add(d);visit(d);}};visit(key);return seen;}
export function referenceType(ref:string,node:Node,nodes:Node[]){
 const [root,key,field,...extra]=ref.split('.');
 if(extra.length || ['__proto__','prototype','constructor'].some(p=>ref.split('.').includes(p)))return undefined;
 if(root==='input' && !field)return inputs[key!];
 if(root!=='nodes'||!field||!ancestors(nodes,node.key).has(key!))return undefined;
 const source=nodes.find(n=>n.key===key);return outputs[HANDLERS[source?.capabilityKey??'']??'']?.[field];
}
export function validateExecutableGraph(raw:unknown):Node[]{
 const nodes=z.array(TemplateNodeDefinition).min(1).max(64).parse(raw);
 WorkflowTemplateVersion.parse({id:'validation',key:'validation',version:1,name:'validation',nodes,defaultBudget:{},createdBy:'platform',createdAt:new Date().toISOString()});
 const used=new Set<string>();
 for(const n of nodes){
   if(used.has(n.capabilityKey)&&n.capabilityKey!=='code-check')throw new ApiError('VALIDATION_ERROR','首版业务模板每种能力只可使用一次，避免隐式来源歧义');
   used.add(n.capabilityKey);
   const handler=HANDLERS[n.capabilityKey];
   if(!handler||n.capabilityVersion!==1)throw new ApiError('VALIDATION_ERROR',`能力 ${n.capabilityKey}@${n.capabilityVersion} 没有对应执行器`);
   const gate=handler.endsWith('_gate');
   if(n.isApprovalGate!==gate)throw new ApiError('VALIDATION_ERROR',`节点 ${n.key} 的人工门声明与真实能力不符`);
   if(n.condition && (gate || handler==='preparation_check'))throw new ApiError('VALIDATION_ERROR','人工批准门和账号准备检查不能设置跳过条件');
   for(const [field,ref] of Object.entries(n.inputMapping))if(!allowed[handler]?.includes(field)||referenceType(ref,n,nodes)!==inputs[field])throw new ApiError('VALIDATION_ERROR',`节点 ${n.key} 输入映射类型不符或不是前序引用：${field}`);
   if(n.condition && ['gt','lt'].includes(n.condition.operator) && (referenceType(n.condition.variable,n,nodes)!=='number'||typeof n.condition.value!=='number'))throw new ApiError('VALIDATION_ERROR','数值条件必须比较数字');
   if(n.condition && !referenceType(n.condition.variable,n,nodes))throw new ApiError('VALIDATION_ERROR','条件必须引用已声明的输入或前序输出');
   const predecessor=ancestors(nodes,n.key), prior=nodes.filter(x=>predecessor.has(x.key));
   const needs=handler==='case_suggest'?['rule-approval-gate']:handler==='execution'?['plan-approval-gate','login-check']:handler==='evaluation'?['browser-execute']:[];
   for(const k of needs)if(!prior.some(p=>p.capabilityKey===k))throw new ApiError('VALIDATION_ERROR',`节点 ${n.key} 缺少必要前序 ${k}`);
 }
 return nodes;
}
export async function freezeExecutableTemplate(db:PrismaClient|Prisma.TransactionClient,projectId:string,raw:unknown){
 const nodes=validateExecutableGraph(raw), capabilities=[];
 for(const n of nodes){
  const cap=await db.capabilityCatalog.findUnique({where:{projectId_key_version:{projectId,key:n.capabilityKey,version:n.capabilityVersion}}});
  if(!cap?.enabled)throw new ApiError('VALIDATION_ERROR',`能力 ${n.capabilityKey} 已禁用或不存在`);
  const writes=['browser-execute','code-check'].includes(n.capabilityKey);
  if(writes&&(!cap.effects.includes('WRITE')||!cap.cleanupResponsibility))throw new ApiError('VALIDATION_ERROR','写入能力必须声明 WRITE 与清理责任');
  if(!cap.inputSchema||typeof cap.inputSchema!=='object'||!cap.outputSchema||typeof cap.outputSchema!=='object')throw new ApiError('VALIDATION_ERROR','能力需要输入输出对象 Schema');
  capabilityValidator(cap.inputSchema);capabilityValidator(cap.outputSchema);
  capabilities.push({id:cap.id,key:cap.key,version:cap.version,effects:cap.effects,requiredRoles:cap.requiredRoles,cleanupResponsibility:cap.cleanupResponsibility,inputSchema:cap.inputSchema,outputSchema:cap.outputSchema});
 }
 return {nodes,capabilities};
}
export function readReference(ref:string,input:Record<string,unknown>,nodes:Array<{nodeKey:string;outputRef:unknown}>){
 const [root,key,field]=ref.split('.');
 if(root==='input')return Object.hasOwn(input,key!)?input[key!]:undefined;
 const output=nodes.find(n=>n.nodeKey===key)?.outputRef as Record<string,unknown>|null;
 return output&&Object.hasOwn(output,field!)?output[field!]:undefined;
}
export const BUILTIN_TEMPLATES=[
 {key:'release-acceptance',name:'发布验收',keys:['document-parse','rule-extract','rule-approval-gate','case-generate','case-approval-gate','page-observe','plan-approval-gate','login-check','browser-execute','evaluate']},
 {key:'baseline-retest',name:'原标准复测',keys:['plan-approval-gate','login-check','browser-execute','evaluate']},
 {key:'engineering-check',name:'工程体检',keys:['code-check']},
];
export async function installBuiltinTemplates(tx:Prisma.TransactionClient,projectId:string,actor:string){
 const templates=[];
 for(const key of Object.keys(HANDLERS)){
  const writes=['browser-execute','code-check'].includes(key);
  await tx.capabilityCatalog.upsert({where:{projectId_key_version:{projectId,key,version:1}},create:{projectId,key,version:1,name:key,inputSchema:{type:'object'},outputSchema:{type:'object'},effects:writes?['READ','WRITE']:['READ'],requiresEnvironment:key!=='code-check',idempotencyStrategy:writes?'write_uncertain':'idempotent',recoveryStrategy:writes?'manual':'read_only',cleanupResponsibility:writes?'执行器管理隔离资源；未知写入进入核对，不自动重放':null,createdBy:actor},update:{}});
 }
 for(const t of BUILTIN_TEMPLATES){
  const nodes=t.keys.map((key,i)=>({key,capabilityKey:key,capabilityVersion:1,dependsOn:i?[t.keys[i-1]!]:[],isApprovalGate:key.endsWith('-gate'),inputMapping:{}}));
  await freezeExecutableTemplate(tx,projectId,nodes);
  templates.push(await tx.workflowTemplate.upsert({where:{projectId_key_version:{projectId,key:t.key,version:1}},create:{projectId,key:t.key,version:1,name:t.name,nodes,defaultBudget:{maxWallClockMs:3600000,maxModelCalls:50,maxToolCalls:200,maxTokens:2000000},defaultParallelism:1,status:'PUBLISHED',publishedAt:new Date(),createdBy:actor},update:{}}));
 }
 return templates;
}
