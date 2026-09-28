import type {PrismaClient} from '@prisma/client';
import type {ArtifactStore} from '@ai-qa/artifact-store';
import {memoryInvalidReason} from '../../../api/src/memory-service.js';
/** Memory contributes navigation hints only; frozen Oracle remains the sole business standard. */
export async function selectSessionMemories(prisma:PrismaClient,store:ArtifactStore,session:{projectId:string;environmentId:string;oracleHash:string},slots:number){
 const rows=await prisma.projectMemory.findMany({where:{projectId:session.projectId},orderBy:{createdAt:'desc'},take:20});
 const decisions:Array<{memoryRecordId:string;decision:'used'|'rejected';reason:string;text?:string}>=[];
 for(const row of rows){
  const context=row.context as {oracleHash?:string;environmentId?:string};
  let reason=row.invalidated?'记忆已失效':row.environmentId&&row.environmentId!==session.environmentId||context.environmentId&&context.environmentId!==session.environmentId?'记忆来自不同环境':context.oracleHash&&context.oracleHash!==session.oracleHash?'记忆业务标准已变化':await memoryInvalidReason(prisma,store,session.projectId,row);
  if(!reason&&slots<=0)reason='本次请求的记忆上下文预算不足';
  if(reason){decisions.push({memoryRecordId:row.id,decision:'rejected',reason});continue;}
  slots--;decisions.push({memoryRecordId:row.id,decision:'used',reason:'作为不可信操作经验纳入规划请求，不能覆盖批准标准；未测量收益',text:row.content.slice(0,1500)});
 }
 return decisions;
}
