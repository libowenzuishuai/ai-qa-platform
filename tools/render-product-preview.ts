/** Offline design preview using the SAME renderers as apps/web. Never calls a model or API. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { layout } from '../apps/web/src/pages.js';
import { dashboard } from '../apps/web/src/dashboard.js';
import { caseEditor } from '../apps/web/src/case-editor.js';
const out=fileURLToPath(new URL('../docs/product/v1.1/preview/',import.meta.url));
mkdirSync(out,{recursive:true});
const data={
  project:{id:'design-example',name:'Northstar · 客户服务平台'},
  sourceCounts:{documents:3,parsed:3},
  environments:[{id:'staging',name:'测试环境',revision:2,isProduction:false}],
  cases:[{id:'case-example',caseId:'case-a',version:1,title:'升级后套餐与金额正确',approvalStatus:'APPROVED',plans:[{environmentId:'staging',environmentRevision:2}]},{caseId:'case-b',version:1,approvalStatus:'DRAFT',plans:[]},{caseId:'case-c',version:1,approvalStatus:'DRAFT',plans:[]}],
  defects:[{status:'CONFIRMED'}],missions:[{id:'mission-example'}],
  executions:[{id:'run-example-1',buildId:'release-2026.09.20',createdAt:'2026-09-20T10:32:00',lifecycle:'RUNNING',acceptanceStatus:'NOT_RUN'},{id:'run-example-2',buildId:'release-2026.09.19',createdAt:'2026-09-19T16:08:00',lifecycle:'FINISHED',acceptanceStatus:'FAIL'},{id:'run-example-3',buildId:'release-2026.09.18',createdAt:'2026-09-18T14:20:00',lifecycle:'FINISHED',acceptanceStatus:'PASS'}],
};
const exampleCase={id:'case-example',projectId:data.project.id,title:'升级后套餐与金额正确',version:2,approvalStatus:'DRAFT',priority:'P0',description:'检查用户从免费套餐升级后的展示结果。此内容仅用于界面预览。',roles:['付费用户'],preconditions:['已登录专用测试账号','使用测试支付方式'],ruleVersionIds:['rule-example'],availableRules:[{id:'rule-example',statement:'升级成功后，套餐名称显示为 Pro',version:1}],steps:[{id:'step-a',role:'付费用户',action:'打开套餐页并确认升级',expectedResult:'进入订单确认页面'}],assertions:[{id:'assertion-a',description:'显示新套餐名称',ruleVersionId:'rule-example',kind:'ui.text',operator:'equals',expected:'Pro',required:true}],dataSpec:{strategy:'create',note:'仅使用试点隔离账号创建测试订单'},cleanup:{strategy:'manual',note:'由测试负责人清理本次测试订单'}};
const banner=`<div class="preview-banner" style="padding:10px 16px;border:1px solid #d7dcc5;background:#fbf9e9;border-radius:8px;margin-bottom:24px;font-size:12px;color:#70693c"><b>设计预览 · 示例数据</b>　与真实前端共用渲染组件；这里不会调用模型或执行测试。<br><a href="index.html">工作台</a>　/　<a href="case.html">用例编辑</a>　/　<a href="capabilities.html">能力组合设计</a></div>`;
const previewScript=`<script>document.querySelectorAll('form').forEach(form=>form.addEventListener('submit',event=>{event.preventDefault();document.querySelector('#preview-notice').textContent='这是设计预览，未保存数据或启动测试。请在真实平台完成此操作。';document.querySelector('#preview-notice').scrollIntoView({block:'center'});}));document.querySelectorAll('a[href^="/"]').forEach(a=>a.addEventListener('click',event=>{event.preventDefault();document.querySelector('#preview-notice').textContent='此入口在真实平台可用。本页仅展示组件设计，可使用顶部导航切换预览。';document.querySelector('#preview-notice').scrollIntoView({block:'center'});}));</script>`;
function save(name:string,title:string,body:string,activeTab:string){
  writeFileSync(out+name,layout(title,banner+body+'<p id="preview-notice" role="status" aria-live="polite" class="section-note">所有统计、用例与运行均为示例。</p>'+previewScript,{projectId:data.project.id,projectName:data.project.name,activeTab}));
}
save('index.html','工作台',dashboard(data),'overview');
save('case.html','审阅用例',caseEditor(exampleCase),'missions');
save('capabilities.html','能力与集成',`<div class="page-heading"><div><span class="eyebrow">COMPOSABLE TESTING</span><h1>组装你的测试团队</h1><p>按任务选择能力，每一步都有明确输入、权限和交付结果。</p></div><span class="badge REVIEW">组合引擎 · 规划中</span></div><section class="mission-hero"><div><span class="eyebrow">RELEASE ACCEPTANCE</span><h2>一份要求，多种验证方式。</h2><p>用业务依据定义预期，用浏览器、接口和代码检查交叉验证。组合模板发布后固定版本，变更需要复核。</p></div><div class="hero-graphic" aria-hidden="true"><div class="orbit"><span class="orbit-center">⊞</span><span class="orbit-node">发布验收</span><span class="orbit-node bottom">版本化组合</span></div></div></section><section class="card"><div class="panel-title"><h2>发布验收流程</h2><span class="badge">建议模板</span></div><ol class="journey"><li><b>01　理解资料</b><p class="muted">解析来源 → 提取规则 → 人工批准</p></li><li><b>02　制定测试</b><p class="muted">生成用例 → 选择范围 → 确认计划与预算</p></li><li><b>03　执行与收集</b><p class="muted">浏览器验收 / HTTP 接口检查 / 已有工程测试</p></li><li><b>04　评估与复测</b><p class="muted">验证证据完整性 → 缺陷确认 → 原标准复测</p></li></ol></section><div class="project-list">${[['浏览器验收','已有基础能力','按批准计划操作真实页面，保留截图与断言证据。'],['接口检查','已有基础能力','使用登记的请求模板，验证状态与返回值。'],['代码检查','已有基础能力','固定 Git 提交，在运行器中执行受支持的测试。'],['组合与恢复','待开发','版本化能力目录、任务检查点、失败恢复与预算控制。'],['需求变更影响','待联合接线','来源差异、受影响规则与用例，进入复核后再选测。'],['决策路由','后续评测','可选 TypeSafe / 国内模型，先旁路评测再接入。']].map(([name,state,desc])=>`<article class="card"><span class="badge ${state==='已有基础能力'?'PASS':'REVIEW'}">${state}</span><h2 style="margin-top:18px">${name}</h2><p class="muted">${desc}</p></article>`).join('')}</div>`,'integrations');
console.log(out);
