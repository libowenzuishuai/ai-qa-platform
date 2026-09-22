import type {PrismaClient,Prisma} from '@prisma/client';
import {GoalProposalAgentInput,GoalProposalAgentOutput,validateGoalProposal} from '@ai-qa/contracts';
import {freezeGoalInput} from '../../api/src/goal-service.js';
import {contentHash} from '../../api/src/change-review-service.js';
import {callIntelligence} from './intelligence-client.js';
import type {WorkerConfig} from './config.js';
type Job={id:string;projectId:string;request:unknown;startedAt:Date|null};
export async function runGoalProposal(db:PrismaClient,job:Job,config:WorkerConfig,commit:(db:PrismaClient,job:Job,persist:(tx:Prisma.TransactionClient)=>Promise<void>)=>Promise<void>){
 const r=job.request as any;
 const current=await freezeGoalInput(db,job.projectId,r);
 if(current.hash!==r.frozen.hash||contentHash({input:r.frozen.input,pins:r.frozen.pins})!==current.hash)throw Object.assign(new Error('目标规划上下文已改变，请重新发起'),{code:'CONFLICT'});
 const input=GoalProposalAgentInput.parse(current.input);
 const remote=await callIntelligence(config,'goal',job.id,r.mode,input);
 for(const i of remote.invocations)await db.modelInvocation.create({data:{projectId:job.projectId,provider:i.response.provider,model:i.response.model,promptVersion:i.promptVersion,requestId:job.id,usage:i.response.usage as never,outcome:i.response.outcome,latencyMs:i.response.latencyMs}});
 const output=GoalProposalAgentOutput.parse(remote.output),check=validateGoalProposal(input,output);
 if(!check.ok)throw Object.assign(new Error(check.problems.join('; ')),{code:'MODEL_OUTPUT_INVALID'});
 await commit(db,job,async tx=>{
   const fresh=await freezeGoalInput(tx,job.projectId,r);
   if(fresh.hash!==current.hash)throw Object.assign(new Error('规划期间上下文已改变'),{code:'CONFLICT'});
   const proposal=await tx.goalProposal.create({data:{projectId:job.projectId,goal:r.goal,suggestedTools:output.suggestedTools,suggestedBudget:output.suggestedBudget,blockers:output.blockers,suggestedScope:{documentVersionIds:r.documentVersionIds,environmentId:r.environmentId??null,sourceJobId:job.id,pins:current.pins,mode:r.mode,rationale:output.rationale},createdBy:r.createdBy}});
   await tx.job.update({where:{id:job.id},data:{status:'SUCCEEDED',finishedAt:new Date(),result:{proposalId:proposal.id}}});
 });
}
