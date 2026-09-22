import type {PrismaClient} from '@prisma/client';
import type {ArtifactStore} from '@ai-qa/artifact-store';
import {ApiError} from './errors.js';

/** Memory is a time-limited hint, never a substitute for approved requirements. */
export async function memoryInvalidReason(db:PrismaClient,store:ArtifactStore,projectId:string,m:{source:any;context:any;validUntil?:Date|null}){
 if(!m.validUntil||m.validUntil<=new Date())return '记忆已过期或没有有效期';
 const source=m.source,context=m.context;
 if(source.kind!=='manual'&&!source.referenceId&&!source.sourceSpanId)return '记忆缺少可验证来源';
 if(source.sourceSpanId){
  const span=await db.sourceSpan.findFirst({where:{id:source.sourceSpanId,documentVersion:{document:{projectId}}},include:{documentVersion:true}});
  if(!span||span.extractionQuality!=='GOOD'||span.documentVersion.parseStatus!=='PARSED')return '来源片段不可用';
  if(context.documentVersionId!==span.documentVersionId)return '片段与资料版本不一致';
 }
 if(source.referenceId){
  if(source.kind==='observation'){
   const artifact=await db.artifact.findFirst({where:{id:source.referenceId,projectId}});
   if(!artifact||!artifact.checksum||artifact.expiresAt&&artifact.expiresAt<=new Date()||!store.verify(artifact.storageKey,artifact.checksum))return '观察证据不存在、过期或校验失败';
  }else if(source.kind==='execution'){
   const run=await db.run.findFirst({where:{id:source.referenceId,projectId,lifecycle:{in:['FINISHED','ERROR','CANCELLED']}}});
   if(!run)return '执行来源不存在或尚未结束';
  }else if(source.kind==='diagnosis'){
   if(!await db.diagnosisEntry.findFirst({where:{id:source.referenceId,projectId}}))return '诊断来源不存在';
  }else return '人工记忆不得冒用执行来源';
 }
 if(context.documentVersionId){
  const doc=await db.documentVersion.findFirst({where:{id:context.documentVersionId,document:{projectId},parseStatus:'PARSED'}});
  if(!doc)return '资料版本不可用';
  if(await db.documentVersion.count({where:{documentId:doc.documentId,version:{gt:doc.version}}}))return '资料已有新版本';
  if(!store.verify(doc.storageKey,doc.checksum))return '资料原文校验失败';
 }
 if(context.environmentRevision!==undefined||context.buildId!==undefined||context.environmentId){
  if(!context.environmentId||context.environmentRevision===undefined)return '环境上下文不完整';
  const environment=await db.environment.findFirst({where:{id:context.environmentId,projectId,revision:context.environmentRevision,isProduction:false}});
  if(!environment)return '环境版本已变化';
  if(context.buildId!==undefined&&(environment.buildMetadata as any).buildId!==context.buildId)return '目标构建已变化';
 }
 return null;
}
export async function assertMemorySource(db:PrismaClient,store:ArtifactStore,projectId:string,m:{source:any;context:any;validUntil:Date}){
 if(m.validUntil.getTime()>Date.now()+90*86400000)throw new ApiError('VALIDATION_ERROR','记忆有效期最多 90 天');
 const reason=await memoryInvalidReason(db,store,projectId,m);if(reason)throw new ApiError('VALIDATION_ERROR',reason);
}
export async function refreshMemories(db:PrismaClient,store:ArtifactStore,projectId:string){
 // Cursor batches bound memory even for projects with many historical records.
 let cursor:string|undefined;
 while(true){
  const rows=await db.projectMemory.findMany({where:{projectId,invalidated:false},orderBy:{id:'asc'},take:100,...(cursor?{cursor:{id:cursor},skip:1}:{})});
  for(const row of rows){const reason=await memoryInvalidReason(db,store,projectId,row);if(reason)await db.projectMemory.updateMany({where:{id:row.id,invalidated:false},data:{invalidated:true,invalidatedReason:reason}});}
  if(rows.length<100)break;cursor=rows.at(-1)!.id;
 }
}
