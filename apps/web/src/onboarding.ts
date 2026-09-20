const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function onboarding(d:any) {
  const base=`/space/${encodeURIComponent(d.project.id)}`;
  const latest=[...new Map(d.cases.map((c:any)=>[c.caseId,c])).keys()].map(id=>d.cases.filter((c:any)=>c.caseId===id).sort((a:any,b:any)=>b.version-a.version)[0]);
  const approved=latest.filter(c=>c.approvalStatus==='APPROVED');
  const bound=approved.filter(c=>c.plans.some((p:any)=>p.environmentId&&d.environments.some((e:any)=>e.id===p.environmentId&&e.revision===p.environmentRevision)));
  const items=[
    {title:'登记测试环境',done:d.environments.length>0,detail:'选择允许测试的网址与业务角色',href:`${base}?tab=projects`},
    {title:'确认验收依据',done:d.sourceCounts?.parsed>0,detail:`已解析 ${d.sourceCounts?.parsed??0} 份资料；仓库说明仍需确认用途`,href:`/projects/${encodeURIComponent(d.project.id)}/review`},
    {title:'审阅规则与用例',done:approved.length>0,detail:`${approved.length} 个最新用例已批准；${latest.length-approved.length} 个待审阅`,href:`${base}?tab=missions#case-review`},
    {title:'观察页面并确认计划',done:bound.length>0,detail:`${bound.length} 个用例匹配当前环境；账号是否有效会在执行时验证`,href:`${base}?tab=missions#observe`},
    {title:'准备任务并开始验收',done:d.executions.some((r:any)=>r.lifecycle==='FINISHED'),detail:d.missions.length?'先检查账号、数据与清理要求，再开始测试':'选择批准基线，创建第一项测试任务',href:`${base}?tab=missions#create-mission`},
  ];
  const next=items.find(i=>!i.done);
  return `<section class="card onboarding-card"><span class="muted">项目接入进度 · ${items.filter(i=>i.done).length} / ${items.length}</span><h2>${next?`下一步：${esc(next.title)}`:'基础接入已完成，可开始下一次验收'}</h2><p>${esc(next?.detail??'查看交付评估中的失败与未验证范围。')}</p><p><a class="primary-link" href="${next?.href??`${base}?tab=assessment`}">${next?'继续准备':'查看交付评估'} →</a></p><div class="progress-line" aria-hidden="true"><span style="width:${items.filter(i=>i.done).length/items.length*100}%"></span></div><ol class="journey">${items.map(i=>`<li data-done="${i.done}"><span class="badge ${i.done?'PASS':'PENDING'}">${i.done?'已有记录':'待完成'}</span> <a href="${i.href}">${esc(i.title)}</a><p class="muted">${esc(i.detail)}</p></li>`).join('')}</ol><p class="muted">接入进度表示配置和资产记录，不代表业务已经通过。</p></section>`;
}
