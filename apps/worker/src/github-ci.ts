import {cancelWorkflowChildren,emitWorkflowEvent} from '@ai-qa/run-events';
import type {PrismaClient} from '@prisma/client';
import type {ArtifactStore} from '@ai-qa/artifact-store';
import {GitHubCiConfig} from '@ai-qa/contracts';
import {GitHubApp,githubConfig} from '../../api/src/github-app.js';
import {createWorkflow} from '../../api/src/routes-workflow.js';
import {ApiError} from '../../api/src/errors.js';
/** Database outbox: provider writes enter WRITE_UNCERTAIN before network I/O. Unknown writes require
 * explicit retry, which searches external_id first. No model/user-supplied report text reaches Checks. */
export async function advanceGitHubDelivery(db:PrismaClient,store:ArtifactStore,id:string,provider=new GitHubApp(githubConfig())){
 const lease=new Date(Date.now()+60000);
 const claimed=await db.githubDelivery.updateMany({where:{id,status:{in:['QUEUED','WAITING']}},data:{status:'RUNNING',leaseExpiresAt:lease,attempts:{increment:1}}});if(!claimed.count)return;
 const row=await db.githubDelivery.findUniqueOrThrow({where:{id}}),guard={id,status:'RUNNING',leaseExpiresAt:lease};
 const set=(status:string,detail:string)=>db.githubDelivery.updateMany({where:guard,data:{status,detail,leaseExpiresAt:null}});
 try{
  const i=await db.githubIntegration.findFirst({where:{id:row.integrationId??'',projectId:row.projectId??'',status:'ACTIVE',revision:row.integrationRevision??-1}});
  if(!i){await set('IGNORED','授权或配置版本已变化');return;}
  const ci=GitHubCiConfig.parse(i.ci);if(!ci.enabled){await set('IGNORED','CI 已关闭');return;}
  const member=await db.projectMembership.findFirst({where:{projectId:i.projectId,userId:i.configuredBy,role:{in:['LEAD','ADMIN']}}});if(!member)throw new ApiError('FORBIDDEN','连接负责人已无项目执行权限');
  const payload=row.payload as any,sha=payload.sha;
  if(!/^[a-f0-9]{40}$/.test(sha)||/^0+$/.test(sha))throw new ApiError('VALIDATION_ERROR','事件缺少有效固定版本');
  const token=await provider.scopedToken(i.installationId,i.repositoryId,true);
  const actual=await provider.json('/repos/'+i.repository,token);if(String(actual.id)!==i.repositoryId)throw new ApiError('FORBIDDEN','仓库身份不一致');
  if(row.event==='push'){
   const ref=await provider.json(`/repos/${i.repository}/git/ref/heads/${encodeURIComponent(ci.branch)}`,token);
   if(ref.object?.sha!==sha){await set('IGNORED','乱序事件：已不是分支当前提交');return;}
  }else{
   if(!Number.isInteger(payload.number)||payload.number<1)throw new ApiError('VALIDATION_ERROR','PR 编号无效');
   const pr=await provider.json(`/repos/${i.repository}/pulls/${payload.number}`,token);
   if(String(pr.head?.repo?.id)!==i.repositoryId||String(pr.base?.repo?.id)!==i.repositoryId||pr.head?.sha!==sha||pr.base?.ref!==ci.branch||pr.state!=='open'){await set('IGNORED','PR 已变化、关闭或来自 fork');return;}
  }
  let workflowId=row.workflowId;
  if(!workflowId){
   const wf=await createWorkflow(db,i.projectId,{templateId:ci.templateId,idempotencyKey:'github:'+row.id,inputs:{codeCheck:{repositoryUrl:'https://github.com/'+i.repository,commitSha:sha,kind:ci.kind,subdirectory:ci.subdirectory,timeoutSeconds:ci.timeoutSeconds,installDependencies:ci.installDependencies}}},i.configuredBy);
   workflowId=wf.id;
   const retained=await db.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM "GithubIntegration" WHERE id=${i.id} FOR UPDATE`;
    const current=await tx.githubIntegration.findFirst({where:{id:i.id,status:'ACTIVE',revision:i.revision}});
    if(current){const linked=await tx.githubDelivery.updateMany({where:guard,data:{workflowId}});if(linked.count)return true;}
    await tx.workflowRun.updateMany({where:{id:wf.id,status:{in:['QUEUED','RUNNING','WAITING_HUMAN']}},data:{status:'CANCELLED',cancelRequestedAt:new Date()}});
    await cancelWorkflowChildren(tx,wf.id);await emitWorkflowEvent(tx,wf.id,'workflow.cancelled',{reason:'GitHub 配置或授权已变化'});return false;
   });if(!retained){await set('IGNORED','启动期间授权已变化');return;}
  }
  const wf=await db.workflowRun.findUniqueOrThrow({where:{id:workflowId},include:{nodes:true}});
  if(!['COMPLETED','FAILED','CANCELLED','BUDGET_EXCEEDED'].includes(wf.status)){await set('WAITING','等待批准模板的实际工程检查');return;}
  const checkIds=wf.nodes.flatMap(n=>{const out=n.outputRef as any;return out?.checkId?[out.checkId]:[];});
  const checks=await db.codeCheck.findMany({where:{id:{in:checkIds},projectId:i.projectId}});
  let conclusion='action_required';
  if(wf.status==='CANCELLED')conclusion='cancelled';
  else if(checks.some(c=>c.verdict==='FAIL'))conclusion='failure';
  else if(wf.status==='COMPLETED'&&checks.length>0&&checks.length===checkIds.length&&checks.every(c=>c.status==='FINISHED'&&c.verdict==='PASS')){
   let verified=true;for(const check of checks){const artifact=await db.artifact.findFirst({where:{id:check.evidenceId??'',projectId:i.projectId}});if(!artifact||!store.verify(artifact.storageKey,artifact.checksum)||artifact.expiresAt&&artifact.expiresAt<=new Date())verified=false;}
   if(verified)conclusion='success';
  }
  // Explicit retry of unknown write reconciles provider state before creating anything.
  let remoteId:string|undefined,exhausted=true;
  for(let page=1;page<=10;page++){
   const list=await provider.json(`/repos/${i.repository}/commits/${sha}/check-runs?check_name=AIQA&filter=all&per_page=100&page=${page}`,token);
   if(!Array.isArray(list.check_runs))throw new ApiError('DEPENDENCY_UNAVAILABLE','Checks 列表无效');
   const found=list.check_runs.find((c:any)=>c.external_id===row.id);if(found){if(found.head_sha!==sha)throw new ApiError('CONFLICT','回传版本不符');remoteId=String(found.id);break;}
   if(list.check_runs.length<100){exhausted=false;break;}
  }
  if(!remoteId&&exhausted)throw new ApiError('BUDGET_EXCEEDED','Checks 超过对账页数上限，需人工核对');
  if(!await db.githubIntegration.findFirst({where:{id:i.id,status:'ACTIVE',revision:i.revision}})){await set('IGNORED','回传前授权已变化');return;}
  if(!remoteId){
   const writing=await db.githubDelivery.updateMany({where:guard,data:{status:'WRITE_UNCERTAIN',detail:'Checks 回传已开始，未知结果必须核对'}});if(!writing.count)return;
   const result=await provider.json(`/repos/${i.repository}/check-runs`,token,'POST',{name:'AIQA',head_sha:sha,external_id:row.id,status:'completed',conclusion,completed_at:new Date().toISOString(),output:{title:'AIQA 工程检查',summary:`固定提交 ${sha}；工程检查 ${checks.length} 项；结论 ${conclusion}。此结果不代表业务需求验收。`}});
   if(!Number.isInteger(result.id))throw new ApiError('DEPENDENCY_UNAVAILABLE','Checks 回传编号缺失');remoteId=String(result.id);
  }
  await db.githubDelivery.updateMany({where:{id,leaseExpiresAt:lease,status:{in:['RUNNING','WRITE_UNCERTAIN']}},data:{status:'COMPLETED',detail:'工程检查结果已回传',remoteCheckId:remoteId,leaseExpiresAt:null}});
 }catch(error){await set('FAILED',error instanceof ApiError?error.message:'GitHub 集成执行失败');}
}
export async function reconcileGitHubDeliveries(db:PrismaClient,store:ArtifactStore,providerFactory=()=>new GitHubApp(githubConfig())){
 await db.githubDelivery.updateMany({where:{status:'RUNNING',leaseExpiresAt:{lt:new Date()}},data:{status:'FAILED',detail:'处理进程失联，请显式重试'}});
 const rows=await db.githubDelivery.findMany({where:{status:{in:['QUEUED','WAITING']}},orderBy:{updatedAt:'asc'},take:10});
 for(const row of rows)await advanceGitHubDelivery(db,store,row.id,providerFactory());
}
