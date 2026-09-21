import { parseDataDefinition, validateDataParameters } from './data-plugin-service.js';
import { loginFresh } from './preparation-service.js';
import type { PrismaClient } from '@prisma/client';
import { EnvironmentRuntime, TestPlanV1 } from '@ai-qa/contracts';
import { ApiError } from './errors.js';

/** Configuration checks, never a claim that login or business preconditions have been tested. */
export async function missionReadiness(prisma:PrismaClient,mission:{projectId:string;baselineId:string;environmentId:string}) {
  const [env,baseline]=await Promise.all([
    prisma.environment.findFirst({where:{id:mission.environmentId,projectId:mission.projectId}}),
    prisma.baseline.findFirst({where:{id:mission.baselineId,projectId:mission.projectId}}),
  ]);
  if(!env||!baseline)throw new ApiError('NOT_FOUND','任务环境或基线不存在');
  const runtime=EnvironmentRuntime.parse(env.runtime??{});
  const blockers:string[]=[];const notices:string[]=[];
  if(env.isProduction)blockers.push('不允许对生产环境执行');
  if(!baseline.caseVersionIds.length)blockers.push('验收基线没有用例');
  if(!runtime.buildProbe)notices.push('尚未配置构建查询：允许诊断执行，但整体不能判为通过');
  const cases=await prisma.testCaseVersion.findMany({where:{projectId:mission.projectId,id:{in:baseline.caseVersionIds}},include:{plans:{orderBy:{version:'desc'},take:1}}});
  if(cases.length!==baseline.caseVersionIds.length)blockers.push('基线含不可用用例');
  for(const c of cases){
    if(c.approvalStatus!=='APPROVED')blockers.push(`${c.title}：用例尚未批准`);
    const p=c.plans[0];
    if(!p){blockers.push(`${c.title}：尚未绑定执行计划`);continue;}
    if(p.environmentId&&(p.environmentId!==env.id||p.environmentRevision!==env.revision))blockers.push(`${c.title}：环境配置已变化，需要重新观察和批准计划`);
    const parsed=TestPlanV1.safeParse(p.plan);
    if(!parsed.success){blockers.push(`${c.title}：计划结构无效`);continue;}
    for(const a of parsed.data.actions){
      if('value' in a&&a.value.source==='credential'){
        const [role,field]=a.value.ref.split('.');
        const refs=runtime.secretRefs[role!];
        if(runtime.fixture!=='demo'&&!(field==='username'?refs?.usernameEnv:refs?.passwordEnv))blockers.push(`${c.title}：角色 ${role} 缺少${field==='username'?'用户名':'密码'}配置`);
      }
    }
    const data=c.dataSpec as {strategy:string;fixtureId?:string;params?:unknown};const cleanup=c.cleanup as {strategy:string;note?:string};
    let pluginReady=false;
    if(data.strategy==='fixture'){
      const plugin=await prisma.dataPlugin.findFirst({where:{id:data.fixtureId??'',projectId:mission.projectId,environmentId:env.id,environmentRevision:env.revision,enabled:true}});
      try{if(!plugin)throw new Error();parseDataDefinition(plugin.definition);validateDataParameters(plugin.paramSchema,data.params??{});pluginReady=true;}catch{blockers.push(`${c.title}：业务数据插件未配置或参数不合法`);}
    }
    for(const role of c.roles){if(runtime.secretRefs[role]){const prep=await prisma.loginPreparation.findFirst({where:{projectId:mission.projectId,environmentId:env.id,role}});if(!prep||!loginFresh(prep,env.revision))blockers.push(`${c.title}：角色 ${role} 尚无有效登录检查，请到准备中心检查`);}}
    if(cleanup.strategy!=='manual'&&runtime.fixture!=='demo'&&!pluginReady)blockers.push(`${c.title}：尚未配置自动清理能力，请明确人工清理流程后重新批准`);
    for(const condition of c.preconditions as string[])notices.push(`${c.title} · 前置条件：${condition}`);
    if(cleanup.strategy==='manual')notices.push(`${c.title} · 人工清理：${cleanup.note||'尚未填写处理说明'}`);
  }
  return {configurationReady:blockers.length===0,blockers:[...new Set(blockers)],notices:[...new Set(notices)],environment:{id:env.id,name:env.name,revision:env.revision},cases:cases.map(c=>({id:c.id,title:c.title})),credentialCheck:'仅核对引用配置，实际凭据由执行器验证'};
}
