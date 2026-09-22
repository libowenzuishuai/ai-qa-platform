import type {Prisma} from '@prisma/client';
import {cancelWorkflowChildren,emitWorkflowEvent} from '@ai-qa/run-events';

export async function cancelGithubWork(tx:Prisma.TransactionClient,integration:{id:string;projectId:string;repository:string},reason:string,includeManual=false){
 const deliveries=await tx.githubDelivery.findMany({where:{integrationId:integration.id,status:{in:['QUEUED','RUNNING','WAITING','WRITE_UNCERTAIN']}}});
 for(const d of deliveries)if(d.workflowId){
  const changed=await tx.workflowRun.updateMany({where:{id:d.workflowId,status:{in:['QUEUED','RUNNING','WAITING_HUMAN']}},data:{status:'CANCELLED',cancelRequestedAt:new Date()}});
  if(changed.count){await cancelWorkflowChildren(tx,d.workflowId);await emitWorkflowEvent(tx,d.workflowId,'workflow.cancelled',{reason});}
 }
 await tx.githubDelivery.updateMany({where:{id:{in:deliveries.map(d=>d.id)}},data:{status:'IGNORED',detail:reason,leaseExpiresAt:null}});
 if(includeManual){
  const checks=await tx.codeCheck.findMany({where:{projectId:integration.projectId,status:{in:['QUEUED','RUNNING']}}});
  const ids=checks.filter(c=>String((c.request as any).repositoryUrl).replace(/\/$/,'').replace(/\.git$/,'').toLowerCase()===('https://github.com/'+integration.repository).toLowerCase()).map(c=>c.id);
  await tx.codeCheck.updateMany({where:{id:{in:ids},status:'QUEUED'},data:{status:'CANCELLED'}});
  await tx.codeCheck.updateMany({where:{id:{in:ids},status:'RUNNING'},data:{status:'CANCEL_REQUESTED'}});
 }
}
