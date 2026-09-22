import type {Prisma,PrismaClient} from '@prisma/client';
import {GoalProposalAgentInput} from '@ai-qa/contracts';
import {ApiError} from './errors.js';
import {HANDLERS} from './template-runtime.js';
import {contentHash} from './change-review-service.js';
export async function freezeGoalInput(db:PrismaClient|Prisma.TransactionClient,projectId:string,request:{goal:string;documentVersionIds:string[];environmentId?:string}){
 const docs=await db.documentVersion.findMany({where:{id:{in:request.documentVersionIds},document:{projectId},parseStatus:'PARSED'},select:{id:true,checksum:true,bundleChecksum:true,mode:true}});
 if(docs.length!==new Set(request.documentVersionIds).size)throw new ApiError('VALIDATION_ERROR','资料未解析或不属于本项目');
 const environment=request.environmentId?await db.environment.findFirst({where:{id:request.environmentId,projectId,isProduction:false},select:{id:true,revision:true}}):null;
 if(request.environmentId&&!environment)throw new ApiError('VALIDATION_ERROR','环境不可用');
 const all=await db.capabilityCatalog.findMany({where:{projectId,enabled:true,key:{in:Object.keys(HANDLERS)}},orderBy:[{key:'asc'},{version:'desc'}]});
 const unique=[...new Map(all.filter(c=>c.version===1).map(c=>[c.key,c])).values()];
 if(!unique.length)throw new ApiError('VALIDATION_ERROR','请先安装可执行能力模板');
 const input=GoalProposalAgentInput.parse({goal:request.goal,capabilities:unique.map(c=>({...c,description:c.description??undefined})),hasDocuments:docs.length>0,environmentConfigured:!!environment,promptVersion:'goal-v1'});
 const pins={documents:docs.sort((a,b)=>a.id.localeCompare(b.id)),environment,capabilities:unique.map(c=>({id:c.id,key:c.key,version:c.version,effects:c.effects}))};
 return {input,pins,hash:contentHash({input,pins})};
}
