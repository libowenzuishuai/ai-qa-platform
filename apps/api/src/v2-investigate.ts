/** Evidence-only diagnosis: these are hypotheses, never source-code root-cause claims. */
export function investigateEvidence(records:Array<{id:string;source:string;body:unknown}>){
 const failures:string[]=[],successes:string[]=[],authentication:string[]=[],writes:string[]=[],reads:string[]=[];
 for(const record of records){
  const body=record.body as {status?:unknown;output?:{status?:unknown};data?:unknown;kind?:string}|null;
  const status=body?.output?.status??body?.status;
  if(typeof status==='number'&&status>=500)failures.push(record.id);
  if(status===401||status===403)authentication.push(record.id);
  if(typeof status==='number'&&status>=200&&status<300)successes.push(record.id);
  if(record.source==='browser-receipt'&&status==='SUCCEEDED')writes.push(record.id);
  if(['browser-observation','capability-read'].includes(record.source))reads.push(record.id);
 }
 const evidence=(ids:string[])=>ids.slice(0,50).map(ref=>({kind:'observation' as const,ref}));
 const hypotheses=[];
 if(authentication.length)hypotheses.push({text:'观察到认证或权限拒绝，需要核对角色、会话与权限规则；不直接归类为业务实现缺陷。',status:'supported' as const,supportingEvidence:evidence(authentication),contradictingEvidence:evidence(successes)});
 if(failures.length)hypotheses.push({text:'服务返回 5xx，可能是服务端处理或依赖故障；需要相同请求的服务日志进一步区分。',status:'supported' as const,supportingEvidence:evidence(failures),contradictingEvidence:evidence(successes)});
 if(writes.length&&reads.length)hypotheses.push({text:'操作回执与后续读取的业务断言不一致，候选方向为持久化、权限过滤或页面刷新；当前证据不足以确定哪一层。',status:'open' as const,supportingEvidence:evidence([...writes,...reads]),contradictingEvidence:evidence([...failures,...authentication])});
 if(!hypotheses.length)hypotheses.push({text:'现有证据仅能确认结果与标准不一致，尚不能定位到具体组件。需要业务读取、网络响应或服务日志。',status:'unknown' as const,supportingEvidence:evidence(records.map(x=>x.id)),contradictingEvidence:[]});
 return {version:'evidence-investigator-v1',hypotheses,limitations:['假设不是已证实根因','未执行新的写操作，也未宣称已完成最小复现'],nextChecks:authentication.length?['核对批准的角色与当前会话','在独立会话中复核相同权限断言']:failures.length?['按请求时间核对服务端与依赖日志','用相同构建和标准独立复测']:['增加持久化读取和界面结果的对照','用相同冻结标准复测健康、缺陷、修复构建']};
}
