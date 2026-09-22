import type {Prisma,PrismaClient} from '@prisma/client';
import {ChunkBudgetState,ChunkProcessingBudget} from '@ai-qa/contracts';

export async function reserveChunkCall(tx:Prisma.TransactionClient,documentVersionId:string,projectId:string,jobId:string,mode:'real'|'mock'){
 await tx.$queryRaw`SELECT id FROM "DocumentVersion" WHERE id=${documentVersionId} FOR UPDATE`;
 const doc=await tx.documentVersion.findUniqueOrThrow({where:{id:documentVersionId}});
 const budget=doc.chunkBudget?ChunkBudgetState.parse(doc.chunkBudget):ChunkBudgetState.parse({limits:ChunkProcessingBudget.parse({}),usedCalls:0,reservedTokens:0,deadline:new Date(Date.now()+3600000).toISOString(),mode,updatedBy:'system-default'});
 const fail=(message:string):never=>{throw Object.assign(new Error(message),{code:'BUDGET_EXCEEDED'});};
 if(mode!==budget.mode)throw Object.assign(new Error('分块调用模式不能混用'),{code:'CONFLICT'});
 if(Date.parse(budget.deadline)<=Date.now())fail('全文预算已到期');
 if(budget.usedCalls+1>budget.limits.maxModelCalls||budget.reservedTokens+budget.limits.perCallTokenLimit>budget.limits.maxReservedTokens)fail('全文累计调用或 token 保留预算已耗尽；未知调用不自动退回额度');
 budget.usedCalls++;budget.reservedTokens+=budget.limits.perCallTokenLimit;
 await tx.documentVersion.update({where:{id:documentVersionId},data:{chunkBudget:budget}});
 const invocation=await tx.modelInvocation.create({data:{projectId,provider:'unknown',model:'unknown',requestId:jobId,outcome:'UNKNOWN_RESERVED',usage:{reservedTokens:budget.limits.perCallTokenLimit,accounting:'upper-bound reservation; not billed cost'}}});
 return {maxModelCalls:1,maxTokens:budget.limits.perCallTokenLimit,deadline:Date.parse(budget.deadline),invocationId:invocation.id};
}
