import type {Prisma,PrismaClient} from '@prisma/client';
import {ChunkManifest,RuleExtractionOutput,chunkManifestPayload} from '@ai-qa/contracts';
import {contentHash} from './change-review-service.js';
import {chunkCoverage,mergeChunkExtractions} from './chunk-merge.js';
import {ApiError} from './errors.js';
export async function loadCompletedChunks(db:PrismaClient|Prisma.TransactionClient,projectId:string,documentVersionId:string,hash:string){
 const doc=await db.documentVersion.findFirst({where:{id:documentVersionId,document:{projectId}}});
 if(!doc?.chunkManifest||doc.chunkManifestHash!==hash||contentHash(chunkManifestPayload(doc.chunkManifest))!==hash)throw new ApiError('CONFLICT','分块清单缺失或已改变');
 const manifest=ChunkManifest.parse(doc.chunkManifest);
 const rows=await db.documentChunk.findMany({where:{documentVersionId,manifestHash:hash}});
 if(!chunkCoverage(manifest.chunks,rows).complete)throw new ApiError('CONFLICT','全部块完成后才能创建规则草稿');
 const modes=new Set(rows.map(r=>r.generationMode));
 if(modes.size!==1 || !['real','mock'].includes(String(rows[0]?.generationMode)))throw new ApiError('CONFLICT','块的生成模式不一致或未核验');
 const merged=mergeChunkExtractions(rows.map(r=>{
   if(!r.output||contentHash(r.output)!==r.outputHash)throw new ApiError('CONFLICT','块结果校验和不符');
   return {chunkId:r.chunkId,seq:r.seq,output:RuleExtractionOutput.parse(r.output)};
 }));
 return {merged,mode:rows[0]!.generationMode as 'real'|'mock'};
}
