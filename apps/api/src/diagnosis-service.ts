import type {PrismaClient} from '@prisma/client';
import type {ArtifactStore} from '@ai-qa/artifact-store';
import {buildRunReport} from '@ai-qa/reporting';
import {contentHash} from './change-review-service.js';
import {ApiError} from './errors.js';

export async function diagnoseRun(db:PrismaClient,store:ArtifactStore,projectId:string,runId:string,actor:string){
 const run=await db.run.findFirst({where:{id:runId,projectId,lifecycle:{in:['FINISHED','ERROR','CANCELLED']}}});
 if(!run)throw new ApiError('CONFLICT','运行不存在或尚未结束');
 const report=await buildRunReport(db,store,runId);
 const snapshot={run:report.run,metrics:report.metrics,cases:report.cases.map(c=>({caseVersionId:c.caseVersionId,verdict:c.verdict,reasonCode:c.reasonCode,downgradeReasons:c.downgradeReasons,assertions:c.assertions.map(a=>({assertionId:a.assertionId,result:a.result,evidence:a.evidence.map(e=>({artifactId:e.artifactId,exists:e.exists,integrityOk:e.integrityOk,belongsToAttempt:e.belongsToAttempt}))}))}))};
 if(report.metrics.acceptanceStatus==='PASS')throw new ApiError('CONFLICT','当前报告通过，没有需要诊断的失败或阻塞');
 const sourceKey='run-report:'+runId+':'+contentHash(snapshot);
 const old=await db.diagnosisEntry.findUnique({where:{projectId_sourceKey:{projectId,sourceKey}}});if(old)return old;
 const uncertain=report.cases.some(c=>c.evidenceDowngraded||c.verdict==='REVIEW');
 const reasons=report.cases.map(c=>c.reasonCode).join(' ');
 const category=uncertain?'EVIDENCE_GAP':/AUTH|CREDENTIAL/.test(reasons)?'ACCOUNT':/ENV|NETWORK|TIMEOUT/.test(reasons)?'ENVIRONMENT':/MODEL/.test(reasons)?'MODEL':/LOCATOR|SCRIPT/.test(reasons)?'SCRIPT':report.cases.some(c=>c.verdict==='FAIL')?'PRODUCT_FAILURE':'EVIDENCE_GAP';
 const file=store.put({runId:'diagnosis-'+runId,attemptId:'report',filename:contentHash(snapshot)+'.json',data:Buffer.from(JSON.stringify(snapshot))});
 return db.$transaction(async tx=>{
  await tx.$queryRaw`SELECT id FROM "Run" WHERE id=${runId} FOR UPDATE`;
  const existing=await tx.diagnosisEntry.findUnique({where:{projectId_sourceKey:{projectId,sourceKey}}});if(existing)return existing;
  const evidence=await tx.artifact.create({data:{projectId,type:'DIAGNOSIS_SOURCE',sensitivity:'RESTRICTED_RAW',storageKey:file.storageKey,checksum:file.checksum}});
  const facts=[{text:`运行报告判定：${report.metrics.acceptanceStatus}；已选用例 ${report.metrics.totalSelected} 项。`,evidenceId:evidence.id},...report.cases.filter(c=>c.verdict!=='PASS').map(c=>({text:`${c.title}：${c.verdict}（${c.reasonCode}）${c.downgradeReasons.length?'；'+c.downgradeReasons.join('；'):''}`,evidenceId:evidence.id}))];
  return tx.diagnosisEntry.create({data:{projectId,runId,sourceKey,category,facts,confidence:'high',hypotheses:[],suggestions:[{text:uncertain?'先补齐有效执行证据，再评估业务结论。':category==='PRODUCT_FAILURE'?'结合失败断言的期望、实际值和证据检查业务实现；修复后按原标准复测。':category==='ACCOUNT'?'核对账号准备结果与角色权限，再重试。':report.metrics.acceptanceStatus==='PASS'?'当前报告通过；继续保留证据，诊断不证明不存在其他缺陷。':'先处理报告中列出的阻塞条件，再重新执行。',riskNote:'基于运行记录的确定性归类；尚未推断根因，不会自动修改业务或测试结论。'}],createdBy:actor}});
 });
}
