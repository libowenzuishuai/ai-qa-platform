import type {PrismaClient} from '@prisma/client';
import type {ArtifactStore} from '@ai-qa/artifact-store';
import {EvidenceRetentionPolicy} from '@ai-qa/contracts';

/** Project lock serializes policy edits and sweeps. Files are single-key deletions, never directory globs.
 * Audit + expiresAt are retained as tombstones. After a crash between unlink and commit, the next sweep
 * observes the missing file and completes the audit; reporting independently verifies existence. */
export async function sweepProjectEvidence(db:PrismaClient,store:ArtifactStore,projectId:string,now=new Date()){
 return db.$transaction(async tx=>{
  await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;
  const project=await tx.project.findUniqueOrThrow({where:{id:projectId}});
  const parsed=EvidenceRetentionPolicy.safeParse((project.settings as any).evidenceRetention??{});
  if(!parsed.success||!parsed.data.enabled)return {deleted:0,skipped:0};
  const policy=parsed.data,day=86400000;
  // Exclude completed audit entries in SQL, so old tombstones cannot starve later batches.
  const candidates=await tx.$queryRaw<Array<{id:string}>>`
    SELECT a.id FROM "Artifact" a
    JOIN "CaseAttempt" c ON c.id=a."attemptId" AND c."projectId"=a."projectId"
    JOIN "Run" r ON r.id=c."runId" AND r."projectId"=a."projectId"
    WHERE a."projectId"=${projectId} AND r.lifecycle IN ('FINISHED','ERROR','CANCELLED')
    AND c.lifecycle='FINISHED'
    AND ((a."expiresAt" IS NOT NULL AND a."expiresAt"<=${now}) OR
      (a."expiresAt" IS NULL AND a."createdAt"<=CASE WHEN a.sensitivity='RESTRICTED_RAW' THEN ${new Date(now.getTime()-policy.restrictedDays*day)} ELSE ${new Date(now.getTime()-policy.normalDays*day)} END))
    AND NOT EXISTS (SELECT 1 FROM "AuditEvent" e WHERE e."entityId"=a.id AND e.action='artifact.expired')
    ORDER BY a."createdAt",a.id LIMIT 100`;
  let deleted=0,skipped=0;
  for(const {id} of candidates){
   const artifact=await tx.artifact.findUniqueOrThrow({where:{id}});
   // Shared storage could belong to another project or a retained source. Never unlink it.
   if(await tx.artifact.count({where:{storageKey:artifact.storageKey,id:{not:id}}}) || await tx.documentVersion.count({where:{OR:[{storageKey:artifact.storageKey},{bundleStorageKey:artifact.storageKey}]}})){skipped++;continue;}
   try{store.remove(artifact.storageKey);}catch{skipped++;continue;}
   await tx.artifact.update({where:{id},data:{expiresAt:artifact.expiresAt??now}});
   await tx.auditEvent.create({data:{actorId:'system:evidence-retention',action:'artifact.expired',entityType:'Artifact',entityId:id,metadata:{projectId,checksum:artifact.checksum,policy,expiredAt:now.toISOString()}}});
   deleted++;
  }
  return {deleted,skipped};
 },{timeout:15000});
}
