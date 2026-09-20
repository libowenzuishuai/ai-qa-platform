import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { api, ApiError } from './api.js';
import { layout, errorPage } from './pages.js';
const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const options=(rows:any[],label=(r:any)=>r.name??r.title??r.id)=>rows.map(r=>`<option value="${esc(r.id)}">${esc(label(r))}</option>`).join('');
const field=(name:string,label:string,value='',type='text')=>`<label>${label}</label><input type="${type}" name="${name}" value="${esc(value)}" required>`;
const select=(name:string,label:string,rows:any[],fn?:((r:any)=>string))=>`<label>${label}</label><select name="${name}" required>${options(rows,fn)}</select>`;
const list=(v:unknown)=>Array.isArray(v)?v.map(String):v?[String(v)]:[];
const detail=(v:unknown)=>`<details><summary>技术详情</summary><pre style="white-space:pre-wrap">${esc(JSON.stringify(v,null,2))}</pre></details>`;
const tabs=[['overview','工作台'],['projects','项目空间'],['context','产品上下文'],['missions','测试任务'],['execution','执行中心'],['assessment','交付评估'],['integrations','能力与集成']];

export function registerProductPages(app:FastifyInstance){
  app.post('/projects/new',async(req,reply)=>{
    const sid=req.cookies.web_sid;if(!sid)return reply.redirect('/login');
    try{const {data}=await api<any>('/api/projects',{sid,method:'POST',body:req.body});return reply.redirect(`/space/${data.id}`);}catch(e){return fail(reply,e);}
  });
  app.get('/space/:id',async(req,reply)=>{
    const sid=req.cookies.web_sid;if(!sid)return reply.redirect('/login');
    const {id}=req.params as {id:string}; const tab=String((req.query as any).tab??'overview');
    try{
      const {data:d}=await api<any>(`/api/projects/${encodeURIComponent(id)}/workspace`,{sid});
      const base=`/space/${encodeURIComponent(id)}`;
      const form=(action:string,body:string,button:string)=>`<form method="post" action="${base}/${action}">${body}<button>${button}</button></form>`;
      const envSelect=()=>select('environmentId','测试环境',d.environments);
      let body='';
      if(tab==='overview')body=`<h1>${esc(d.project.name)}</h1><p>接入项目、确认验收依据，查看每次交付的实际证据。</p><div class="card"><h2>待办</h2><p>${d.cases.filter((c:any)=>c.approvalStatus==='DRAFT').length} 个用例待批准 · ${d.cases.filter((c:any)=>!c.plans.length).length} 个用例待绑定 · ${d.defects.filter((f:any)=>f.status!=='VERIFIED').length} 个缺陷待处理</p><a href="${base}?tab=missions">准备测试任务 →</a></div><h2>最近运行</h2>${runList(d.executions)}`;
      if(tab==='projects')body=`<h1>项目空间</h1><section class="card"><h2>连接 GitHub 仓库</h2><p>固定提交，只读发现资料和运行线索。当前支持公共仓库。</p>${form('repository',field('url','仓库地址','https://github.com/')+field('ref','分支或提交','HEAD'),'发现仓库资料')}</section><section class="card"><h2>登记测试环境</h2>${form('environment',field('name','环境名称')+field('baseUrl','测试网址'),'登记环境')}</section>${d.environments.map((e:any)=>`<article class="card"><h3>${esc(e.name)}</h3><p>${esc(e.baseUrl)} · 配置版本 ${e.revision}</p><a href="${base}?tab=integrations">配置账号与构建核验</a></article>`).join('')}`;
      if(tab==='context')body=`<h1>产品上下文</h1><p><a href="/projects/${esc(id)}/review">上传资料、提取规则与处理澄清 →</a></p>${d.snapshots.map((s:any)=>{const prev=d.snapshots.find((p:any)=>p.id===s.previousId);const changed=s.files.filter((f:any)=>!prev?.files.some((p:any)=>p.path===f.path&&p.blobHash===f.blobHash));return `<section class="card"><h2>${esc(s.repositoryUrl)}</h2><p>提交 ${esc(s.commitSha)} · ${changed.length} 个新增或修改文件 · ${prev?prev.files.filter((p:any)=>!s.files.some((f:any)=>f.path===p.path)).length:0} 个删除文件</p><p>资料变化需要重新审阅；旧任务继续使用原来的资料与计划。</p>${form('import',`<input type="hidden" name="snapshotId" value="${esc(s.id)}">`+s.files.map((f:any)=>`<label><input type="checkbox" name="paths" value="${esc(f.path)}" ${f.category!=='BUSINESS_CANDIDATE'?'disabled':''}>${esc(f.path)} · ${esc(f.category)}</label>`).join(''),'确认选中资料并解析')}${detail({skipped:s.skipped})}</section>`}).join('')||'<p>尚未发现仓库资料，可先上传文件。</p>'}`;
      if(tab==='missions')body=`<h1>测试任务</h1><p>先确认用例与执行计划，再建立可复用的验收基线。</p><a href="/projects/${esc(id)}/review">从需求生成用例 →</a>
      <section class="card"><h2>1. 用例审阅</h2>${d.cases.map((c:any)=>`<article><h3><a href="/cases/${esc(c.id)}">${esc(c.title)}</a></h3><p>${esc(c.approvalStatus)} · ${c.plans.length?'已绑定计划':'等待执行计划'}</p>${c.approvalStatus==='DRAFT'?form('approve-case',`<input type="hidden" name="caseId" value="${esc(c.id)}">`,'批准用例'):''}</article>`).join('')}</section>
      <section class="card"><h2>2. 观察真实页面</h2>${form('observe',envSelect()+field('role','业务角色','visitor')+field('paths','页面路径（逗号分隔）','/')+'<details><summary>登录或准备操作（高级设置）</summary><p>支持 fill/click 和凭据引用；仅执行负责人明确批准的准备动作。</p><textarea name="setup" rows="5" style="width:100%">[]</textarea></details><label><input type="checkbox" name="allowWrites" value="true">允许上述准备操作写入测试环境</label>','开始观察')}</section>
      <section class="card"><h2>3. 生成并确认执行计划</h2>${form('propose',select('caseId','已批准用例',d.cases.filter((c:any)=>c.approvalStatus==='APPROVED'))+select('observationId','页面观察',d.observations,(o:any)=>`${o.createdAt} · ${o.id}`),'生成计划建议')}${d.proposals.map((p:any)=>`<article><a href="/proposals/${esc(p.id)}">检查计划 ${esc(p.id)}</a> · ${esc(p.mode)}</article>`).join('')}</section>
      <section class="card"><h2>4. 建立验收基线</h2>${form('baseline',field('name','基线名称')+d.cases.filter((c:any)=>c.approvalStatus==='APPROVED'&&c.plans.length).map((c:any)=>`<label><input type="checkbox" name="caseVersionIds" value="${esc(c.id)}">${esc(c.title)}</label>`).join(''),'保存基线')}</section>
      <section class="card"><h2>5. 创建任务</h2>${form('mission',field('title','任务名称')+field('goal','验收目标')+'<label>任务类型</label><select name="template"><option value="RELEASE">发布验收</option><option value="REGRESSION">变更回归</option><option value="HEALTH">项目体检</option></select>'+envSelect()+select('baselineId','批准基线',d.baselines),'创建任务')}</section>
      ${d.missions.map((m:any)=>`<section class="card"><h3>${esc(m.title)}</h3><p>${esc(m.goal)}</p>${form('start',`<input type="hidden" name="missionId" value="${esc(m.id)}">`+field('buildId','本次目标构建版本'),'开始测试')}</section>`).join('')}`;
      if(tab==='execution')body=`<h1>执行中心</h1><p>打开运行可查看步骤、实时事件、取消与证据。</p>${runList(d.executions)}`;
      if(tab==='assessment')body=`<h1>交付评估</h1>${d.executions.map((r:any)=>`<section class="card"><h3>${esc(r.buildId??'未声明版本')} · ${esc(r.acceptanceStatus)}</h3><a href="/runs/${esc(r.id)}/report">证据与报告</a>${['FINISHED','ERROR','CANCELLED'].includes(r.lifecycle)?form('retest',`<input type="hidden" name="runId" value="${esc(r.id)}">`+field('buildId','修复后的新构建版本'),'沿用原标准复测'):''}</section>`).join('')}<h2>缺陷跟踪</h2>${d.defects.map((f:any)=>`<section class="card"><h3>${esc(f.title)}</h3><p>${esc(f.status)} · 负责人 ${esc(f.assignedTo??'未分配')} · ${f.occurrences.length} 次出现</p><pre>${esc(f.description)}</pre>${form('defect-update',`<input type="hidden" name="defectId" value="${esc(f.id)}"><select name="status"><option>CONFIRMED</option><option>FIX_PENDING</option><option>READY_FOR_RETEST</option><option>REJECTED</option></select>`+field('reason','处理说明')+'<label>负责人用户 ID（可选）</label><input name="assignedTo" type="text">','更新处理状态')}${form('defect-verify',`<input type="hidden" name="defectId" value="${esc(f.id)}">`+select('runId','用于确认修复的运行',d.executions,(r:any)=>`${r.buildId} · ${r.acceptanceStatus}`),'核验并确认修复')}</section>`).join('')}`;
      if(tab==='integrations')body=`<h1>能力与集成</h1><section class="card"><h2>测试环境配置</h2><p>账号保存在运行器环境变量中，平台只登记引用。版本查询接口应由部署系统提供实际构建标识。当前项目凭据变量前缀：<code>${esc(d.secretPrefix)}</code>。</p>${form('runtime',envSelect()+field('role','账号角色','visitor')+'<label>用户名变量（可选，AIQA_TARGET_ 开头）</label><input type="text" name="usernameEnv"><label>密码变量（可选，AIQA_TARGET_ 开头）</label><input type="text" name="passwordEnv">'+field('buildPath','版本查询路径','/build')+field('buildField','版本字段','buildId'),'保存配置（原计划需重新观察）')}</section><section class="card"><h2>执行能力</h2><p>浏览器：已接入通用观察与计划建议。其他执行方式以实际配置及运行结果为准。</p><a href="/projects/${esc(id)}">兼容运行入口</a></section>`;
      if(tab==='integrations') {
        const {data:code}=await api<any>(`/api/projects/${encodeURIComponent(id)}/code-checks`,{sid});
        body+=`<section class="card"><h2>注册自有运行器</h2><p>运行器只接收此项目的任务，凭据可撤销。测试在独立容器执行。</p>${form('runner',field('name','运行器名称','团队测试机'),'注册运行器')}</section>
        ${code.runners.map((r:any)=>`<section class="card"><h3>${esc(r.name)}</h3><p>${esc(r.capabilities.join('、'))} · ${r.revokedAt?'已撤销':'已注册'}</p>${!r.revokedAt?form('revoke-runner',`<input type="hidden" name="runnerId" value="${esc(r.id)}">`,'撤销凭据'):''}</section>`).join('')}
        <section class="card"><h2>运行仓库现有测试或构建</h2><p>这类结果属于工程健康检查，不能替代业务验收。</p>${form('code-check',field('repositoryUrl','公共 GitHub 仓库')+field('commitSha','固定提交（完整 40 位 SHA）')+'<label>仓库内子目录（可选）</label><input type="text" name="subdirectory"><label>执行方式</label><select name="kind"><option value="NODE_TEST">Node 内置测试</option><option value="PYTHON_TEST">Python pytest</option><option value="NODE_BUILD">Node 构建</option></select><label><input type="checkbox" name="installDependencies" value="true">允许在隔离准备容器中安装依赖</label>','创建工程检查')}</section>
        ${code.checks.map((c:any)=>`<section class="card"><h3>${esc(c.request.kind)} · ${esc(c.status)}</h3><p>工程检查：${esc(c.verdict)} · ${esc(c.request.commitSha)}</p>${c.evidenceId?`<a href="/artifacts/${esc(c.evidenceId)}">下载受限结果证据</a>`:''}${['QUEUED','RUNNING'].includes(c.status)?form('cancel-check',`<input type="hidden" name="checkId" value="${esc(c.id)}">`,'取消'):''}</section>`).join('')}`;
      }
      if(tab==='missions')body+=`<section class="card"><h2>登记接口测试</h2><p>选择已有的接口断言用例，登记请求模板，再批准执行计划。预期取自批准用例。</p>${form('api-template',select('caseId','接口用例',d.cases.filter((c:any)=>c.approvalStatus==='APPROVED'&&c.assertions.length===1&&c.assertions[0].kind==='api.response'))+envSelect()+field('path','接口路径','/api/status')+'<label>请求方式</label><select name="method"><option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option></select>'+field('responseField','检查字段（status 或 body.字段）','status'),'登记并生成待批准计划')}</section>`;
      return reply.type('text/html').send(layout('项目验收',`<nav style="display:flex;gap:18px;flex-wrap:wrap">${tabs.map(([key,title])=>`<a href="${base}?tab=${key}" style="${key===tab?'font-weight:700;color:#2457d6':''}">${title}</a>`).join('')}</nav>${body}`));
    }catch(e){return fail(reply,e);}
  });
  for(const action of ['repository','environment','import','approve-case','observe','propose','baseline','mission','start','runtime','retest','defect-update','defect-verify','runner','revoke-runner','code-check','cancel-check','api-template'])app.post(`/space/:id/${action}`,async(req,reply)=>{
    const sid=req.cookies.web_sid;if(!sid)return reply.redirect('/login');
    const {id}=req.params as {id:string};const b=req.body as any;
    try{
      let path='',body:any={};let tab='missions';
      if(action==='repository'){path=`/api/projects/${id}/repositories`;body={url:b.url,ref:b.ref};tab='context';}
      if(action==='environment'){path=`/api/projects/${id}/environments`;body={name:b.name,baseUrl:b.baseUrl,allowedOrigins:[new URL(b.baseUrl).origin]};tab='projects';}
      if(action==='import'){path=`/api/context/${b.snapshotId}/import`;body={paths:list(b.paths)};tab='context';}
      if(action==='approve-case')path=`/api/case-versions/${b.caseId}/approve`;
      if(action==='observe'){path=`/api/projects/${id}/observations`;body={environmentId:b.environmentId,allowWrites:b.allowWrites==='true',pages:String(b.paths).split(',').map(path=>({role:b.role,path:path.trim(),setup:JSON.parse(b.setup||'[]')}))};}
      if(action==='propose'){path=`/api/case-versions/${b.caseId}/propose-plan`;body={observationId:b.observationId,mode:'real'};}
      if(action==='baseline'){path=`/api/projects/${id}/baselines`;body={name:b.name,caseVersionIds:list(b.caseVersionIds)};}
      if(action==='mission'){path=`/api/projects/${id}/missions`;body={title:b.title,goal:b.goal,template:b.template,baselineId:b.baselineId,environmentId:b.environmentId};}
      if(action==='start'){path=`/api/missions/${b.missionId}/start`;body={buildId:b.buildId,idempotencyKey:randomUUID()};}
      if(action==='runtime'){path=`/api/environments/${b.environmentId}/runtime`;body={secretRefs:b.usernameEnv||b.passwordEnv?{[b.role]:{...(b.usernameEnv?{usernameEnv:b.usernameEnv}:{}),...(b.passwordEnv?{passwordEnv:b.passwordEnv}:{})}}:{},buildProbe:{path:b.buildPath,field:b.buildField}};tab='integrations';}
      if(action==='retest'){path=`/api/runs/${b.runId}/retest`;body={buildId:b.buildId,idempotencyKey:randomUUID()};}
      if(action==='defect-update'){path=`/api/defects/${b.defectId}/update`;body={status:b.status,reason:b.reason,...(b.assignedTo?{assignedTo:b.assignedTo}:{})};tab='assessment';}
      if(action==='defect-verify'){path=`/api/defects/${b.defectId}/verify`;body={runId:b.runId};tab='assessment';}
      if(action==='runner'){path=`/api/projects/${id}/runners`;body={name:b.name,capabilities:['NODE_TEST','PYTHON_TEST','NODE_BUILD']};tab='integrations';}
      if(action==='revoke-runner'){path=`/api/runners/${b.runnerId}/revoke`;tab='integrations';}
      if(action==='code-check'){path=`/api/projects/${id}/code-checks`;body={repositoryUrl:b.repositoryUrl,commitSha:b.commitSha,subdirectory:b.subdirectory??'',kind:b.kind,installDependencies:b.installDependencies==='true'};tab='integrations';}
      if(action==='cancel-check'){path=`/api/code-checks/${b.checkId}/cancel`;tab='integrations';}
      if(action==='api-template'){
        const {data:t}=await api<any>(`/api/projects/${id}/api-templates`,{sid,method:'POST',body:{environmentId:b.environmentId,request:{name:'接口检查',method:b.method,path:b.path,responseField:b.responseField}}});
        const {data:p}=await api<any>(`/api/case-versions/${b.caseId}/api-plan`,{sid,method:'POST',body:{templateId:t.id}});
        return reply.redirect(`/proposals/${p.id}`);
      }
      const {data}=await api<any>(path,{sid,method:'POST',body});
      if(action==='runner')return reply.type('text/html').header('cache-control','no-store').send(layout('保存运行器凭据',`<h1>运行器已注册</h1><p>此凭据只显示一次，请保存到运行器的 AIQA_RUNNER_TOKEN 环境变量，不要提交到仓库。</p><code>${esc(data.token)}</code><p>配置 AIQA_PLATFORM_URL 后启动 tools/self-hosted-runner/runner.py。</p><a href="/space/${esc(id)}?tab=integrations">返回能力与集成</a>`));
      return reply.redirect(data.jobId?`/jobs/${data.jobId}`:data.runId?`/runs/${data.runId}`:`/space/${id}?tab=${tab}`);
    }catch(e){return fail(reply,e);}
  });
  app.get('/cases/:id',async(req,reply)=>{
    const sid=req.cookies.web_sid;if(!sid)return reply.redirect('/login');const {id}=req.params as {id:string};
    try{const {data:c}=await api<any>(`/api/case-versions/${id}`,{sid});return reply.type('text/html').send(layout('审阅用例',`<h1>${esc(c.title)}</h1><p>${esc(c.approvalStatus)} · 修改会创建新草稿，旧验收标准保持不变。</p><form method="post" action="/cases/${esc(id)}/revise">${field('title','用例名称',c.title)}<label>操作步骤（每行一个；保持原角色）</label><textarea name="steps" rows="8" style="width:100%">${esc(c.steps.map((s:any)=>s.action).join('\n'))}</textarea><h2>验收预期</h2>${c.assertions.map((a:any)=>`<p>${esc(a.description)} · ${esc(a.operator)} · ${esc(a.expected)}</p>`).join('')}<button>保存为新版本</button></form>${detail(c)}<a href="/space/${esc(c.projectId)}?tab=missions">返回任务</a>`));}catch(e){return fail(reply,e);}
  });
  app.post('/cases/:id/revise',async(req,reply)=>{
    const sid=req.cookies.web_sid;if(!sid)return reply.redirect('/login');const {id}=req.params as {id:string};
    try{const {data:c}=await api<any>(`/api/case-versions/${id}`,{sid});const b=req.body as any;const lines=String(b.steps).split('\n').filter(Boolean);const {data}=await api<any>(`/api/case-versions/${id}/revise`,{sid,method:'POST',body:{title:b.title,description:c.description??'',preconditions:c.preconditions,dataSpec:c.dataSpec,steps:lines.map((action,i)=>({id:`step-${i+1}`,role:c.steps[i]?.role??c.roles[0],action})),assertions:c.assertions,cleanup:c.cleanup,roles:c.roles,ruleVersionIds:c.ruleVersionIds}});return reply.redirect(`/cases/${data.id}`);}catch(e){return fail(reply,e);}
  });
  app.get('/proposals/:id',async(req,reply)=>{
    const sid=req.cookies.web_sid;if(!sid)return reply.redirect('/login');const {id}=req.params as {id:string};
    try{const {data:p}=await api<any>(`/api/plan-proposals/${id}`,{sid});return reply.type('text/html').send(layout('确认执行计划',`<h1>确认执行计划</h1><p>模式：${esc(p.mode)}。检查业务步骤、写入操作与断言对应后再批准。</p><ol>${p.plan.actions.map((a:any)=>`<li>${esc(a.effect)} · ${esc(a.type)} · ${esc(a.path??a.targetRef??a.assertionId??a.role)}</li>`).join('')}</ol>${detail(p.plan)}<form method="post" action="/proposals/${esc(id)}/approve"><button>批准并冻结计划</button></form>`));}catch(e){return fail(reply,e);}
  });
  app.post('/proposals/:id/approve',async(req,reply)=>{
    const sid=req.cookies.web_sid;if(!sid)return reply.redirect('/login');const {id}=req.params as {id:string};
    try{const {data:p}=await api<any>(`/api/plan-proposals/${id}`,{sid});await api(`/api/plan-proposals/${id}/approve`,{sid,method:'POST',body:{}});return reply.redirect(`/space/${p.projectId}?tab=missions`);}catch(e){return fail(reply,e);}
  });
}
function runList(rows:any[]){return `<table><tr><th>目标版本</th><th>状态</th><th>验收结论</th><th>证据</th></tr>${rows.map(r=>`<tr><td>${esc(r.buildId??'未声明')}</td><td>${esc(r.lifecycle)}</td><td>${esc(r.acceptanceStatus)}</td><td><a href="/runs/${esc(r.id)}">执行详情</a> · <a href="/runs/${esc(r.id)}/report">报告</a></td></tr>`).join('')}</table>`;}
function fail(reply:import('fastify').FastifyReply,error:unknown){return reply.code(error instanceof ApiError?error.status:400).type('text/html').send(errorPage(esc(error instanceof Error?error.message:error)));}
