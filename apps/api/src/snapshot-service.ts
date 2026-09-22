import type { Prisma, PrismaClient } from '@prisma/client';
import type { ArtifactStore } from '@ai-qa/artifact-store';
import { z } from 'zod';
import { SnapshotDiffInput, SnapshotDiffReport, RepositorySnapshotManifest, validateSnapshotDiff, DocumentFormat, MultiFileChangeReport } from '@ai-qa/contracts';
import { ApiError } from './errors.js';
import { contentHash, loadReviewBundle } from './change-review-service.js';

type DB = PrismaClient | Prisma.TransactionClient;
const inventorySchema = z.object({policyVersion:z.literal('repository-candidates-v1'), enumerationStatus:z.enum(['COMPLETE','PARTIAL','FAILED']), enumerationReason:z.string().nullable(), entries:z.array(z.object({path:z.string(),fetchStatus:z.enum(['OK','NOT_FETCHED','FETCH_FAILED'])})).max(200)});
const storedFiles = z.array(z.object({path:z.string(),checksum:z.string(),storageKey:z.string(),size:z.number().int(),format:DocumentFormat})).max(200);

/** Only server-created discovery records can attest enumeration. Historical snapshots have no such proof. */
export async function freezeSnapshotInput(db:DB, store:ArtifactStore, projectId:string, oldId:string, newId:string) {
  const bundles: Record<string, any> = {}; let mock=false;
  const load = async (id:string) => {
    const snapshot = await db.contextSnapshot.findFirst({where:{id,projectId},include:{sources:{include:{documentVersion:{include:{document:true}}}}}});
    if(!snapshot) throw new ApiError('VALIDATION_ERROR','仓库快照不存在或不属于本项目');
    const inventory = inventorySchema.safeParse(snapshot.inventory);
    if(!inventory.success) throw new ApiError('VALIDATION_ERROR','快照缺少可信扫描清单或超过 200 文件上限，请按较小范围重新发现仓库');
    const files=storedFiles.parse(snapshot.files), byPath=new Map(files.map(f=>[f.path,f]));
    if(byPath.size!==files.length || inventory.data.entries.filter(e=>e.fetchStatus==='OK').length!==files.length)
      throw new ApiError('CONFLICT','扫描清单与存储文件不一致');
    const entries=[];
    for(const e of inventory.data.entries){
      const file=byPath.get(e.path),source=snapshot.sources.find(s=>s.path===e.path);
      if(e.fetchStatus!=='OK'){
        if(file||source)throw new ApiError('CONFLICT','未获取文件包含虚构来源');
        entries.push({...e,checksum:null,sizeBytes:null,documentVersionId:null,format:null,parseStatus:null});continue;
      }
      if(!file || !store.verify(file.storageKey,file.checksum) || store.read(file.storageKey).length!==file.size)
        throw new ApiError('CONFLICT','仓库原文件缺失或校验和不符');
      const version=source?.documentVersion;
      if(version && (version.document.projectId!==projectId || version.checksum!==file.checksum || !store.verify(version.storageKey,version.checksum)))
        throw new ApiError('CONFLICT','资料版本与仓库文件不符');
      if(version && ['PARSED','NEEDS_OCR'].includes(version.parseStatus)) {
        const loaded=await loadReviewBundle(db,store,projectId,version.id);
        bundles[version.id]=loaded.bundle;
        mock ||= version.mode==='mock';
      }
      entries.push({path:e.path,fetchStatus:e.fetchStatus,checksum:file.checksum,sizeBytes:file.size,format:version?.format??file.format,documentVersionId:version?.id??null,parseStatus:version?.parseStatus??null});
    }
    return RepositorySnapshotManifest.parse({snapshotId:id,repositoryId:`repo-${contentHash(snapshot.repositoryUrl.toLowerCase())}`,commitSha:snapshot.commitSha,
      scope:{root:snapshot.subdirectory,include:['**'],exclude:[],policyVersion:inventory.data.policyVersion},
      enumerationStatus:inventory.data.enumerationStatus,enumerationReason:inventory.data.enumerationReason,entries});
  };
  const oldSnapshot=await load(oldId),newSnapshot=await load(newId);
  return {input:SnapshotDiffInput.parse({oldSnapshot,newSnapshot,bundles}),mode:mock?'mock' as const:'real' as const};
}
export function validateSnapshotOutput(input:unknown, output:unknown){
  try {
    const i=SnapshotDiffInput.parse(input), o=SnapshotDiffReport.parse(output);
    const check=validateSnapshotDiff(i,o);
    if(!check.ok)throw new Error(check.problems.join('; '));
    return o;
  }catch{throw new ApiError('CONFLICT','快照报告与冻结输入不符');}
}
/** Presentation compatibility only; all production decisions use the jointly validated canonical report. */
export function snapshotReportView(raw:unknown){
  const canonical=SnapshotDiffReport.safeParse(raw);
  if(!canonical.success)return MultiFileChangeReport.parse(raw);
  const r=canonical.data;
  const outcomes=r.fileChanges.map(c=>({kind:c.kind,oldPath:c.old?.path??null,newPath:c.new?.path??null,contentHash:c.new?.checksum??c.old?.checksum??null,fragmentReport:c.spanReport,reason:c.reason}));
  return {outcomes,totals:{oldFiles:r.coverage.oldFiles,newFiles:r.coverage.newFiles,...Object.fromEntries(['unchanged','modified','added','removed','renamed','uncertain'].map(k=>[k,outcomes.filter(c=>c.kind===k).length]))},excludedPaths:[],exclusionsChanged:false,truncated:!r.complete};
}
export function assertSnapshotIntegrity(row:{input:unknown;inputHash:string;output:unknown;outputHash:string|null}){
  if(contentHash(row.input)!==row.inputHash || (row.output && contentHash(row.output)!==row.outputHash))throw new ApiError('CONFLICT','快照校验失败');
  if(row.output)validateSnapshotOutput(row.input,row.output);
}
