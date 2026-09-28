import type {PrismaClient} from '@prisma/client';
import {ArtifactStore} from '@ai-qa/artifact-store';
import {ApiError} from './errors.js';
/** References are not proof: check ownership and stored bytes at the point of use. */
export async function requireV2Evidence(prisma:PrismaClient,projectId:string,ids:string[],artifactDir?:string){
 if(!ids.length)throw new ApiError('CONFLICT','缺少执行证据');
 const rows=await prisma.artifact.findMany({where:{projectId,id:{in:ids}}});
 const store=new ArtifactStore(artifactDir??process.env.AIQA_ARTIFACT_DIR??'data/artifacts');
 if(ids.some(id=>{const a=rows.find(x=>x.id===id);return !a||(a.expiresAt!==null&&a.expiresAt<=new Date())||!store.verify(a.storageKey,a.checksum);}))throw new ApiError('CONFLICT','证据缺失、跨项目或内容校验失败');
 return rows;
}
