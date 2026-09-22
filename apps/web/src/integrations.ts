import type {FastifyInstance} from 'fastify';
import {api,ApiError} from './api.js';
import {layout,errorPage} from './pages.js';
const e=(x:unknown)=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const u=(x:unknown)=>encodeURIComponent(String(x));
const state:Record<string,string>={ACTIVE:'已连接',REVOKED:'已撤销',QUEUED:'等待处理',RUNNING:'正在处理',WAITING:'测试执行中',COMPLETED:'已回传',IGNORED:'未执行',FAILED:'处理失败',WRITE_UNCERTAIN:'回传结果待核对'};
export function registerIntegrationPages(app:FastifyInstance){
 app.get('/projects/:id/integrations',async(req,reply)=>{
  const sid=req.cookies.web_sid;if(!sid)return reply.redirect('/login');const id=(req.params as any).id,page=Math.max(1,Number((req.query as any).page)||1);
  try{
   const [status,templates]=await Promise.all([api<any>(`/api/projects/${u(id)}/github?page=${page}`,{sid}),api<any>(`/api/projects/${u(id)}/workflow-templates`,{sid})]);
   const d=status.data,choices=templates.data.templates.filter((t:any)=>t.status==='PUBLISHED'&&t.nodes.length===1&&t.nodes[0].capabilityKey==='code-check');
   return reply.type('text/html').send(layout('GitHub 集成',`<header class="page-heading"><div><span class="eyebrow">CONNECTED DELIVERY</span><h1>从一次提交，到可追溯的检查。</h1><p>仓库授权、固定版本和检查回传在同一项目内管理。</p></div><a href="/projects/${u(id)}/delivery">交付中心 →</a></header><section class="card"><h2>连接 GitHub 仓库</h2>${d.configured?`<form method="post" action="/projects/${u(id)}/integrations/connect"><label>仓库名称<input name="repository" required placeholder="团队/仓库" pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"></label><button>前往 GitHub 授权</button></form><p>由仓库管理员授权；请先在 GitHub 为此仓库安装本平台的 App。</p>`:'<p class="empty-state">GitHub App 尚未配置。平台管理员完成服务端配置后，这里会开放授权入口。</p>'}</section>
   ${d.integrations.map((i:any)=>`<section class="card"><h2>${e(i.repository)} <small>${state[i.status]??e(i.status)}</small></h2>${i.status==='ACTIVE'?`<form method="post" action="/projects/${u(id)}/integrations/${u(i.id)}/ci"><label><input type="checkbox" name="enabled" ${i.ci?.enabled?'checked':''}> 开启自动工程检查</label><label>分支<input name="branch" value="${e(i.ci?.branch??'main')}" required></label><label>已发布模板<select name="templateId" required>${choices.map((t:any)=>`<option value="${e(t.id)}" ${i.ci?.templateId===t.id?'selected':''}>${e(t.name)} · 第 ${t.version} 版</option>`).join('')}</select></label><label>检查类型<select name="kind">${[['NODE_TEST','Node 原生测试'],['NODE_VITEST','Vitest'],['NODE_JEST','Jest'],['NODE_PLAYWRIGHT','Playwright'],['NODE_LINT','代码规范'],['NODE_TYPECHECK','类型检查'],['NODE_BUILD','项目构建'],['PYTHON_TEST','Python 测试']].map(([k,n])=>`<option value="${k}" ${i.ci?.kind===k?'selected':''}>${n}</option>`).join('')}</select></label><label>项目子目录<input name="subdirectory" value="${e(i.ci?.subdirectory??'')}"></label><label>超时（秒）<input type="number" name="timeoutSeconds" min="10" max="1800" value="${i.ci?.timeoutSeconds??300}" required></label><label><input type="checkbox" name="installDependencies" ${i.ci?.installDependencies?'checked':''}> 按锁文件安装依赖（需运行器已配置受限安装网络）</label><button ${choices.length?'':'disabled'}>保存检查范围</button></form><p>只处理所选分支及同仓库 PR。fork PR 不执行；本检查不替代业务需求验收。</p><form method="post" action="/projects/${u(id)}/integrations/${u(i.id)}/revoke"><button class="secondary">撤销此项目授权</button></form>`:'<p>重新连接后需再次配置检查范围。</p>'}</section>`).join('')}
   <section class="card"><h2>事件记录 <small>${d.total} 条</small></h2>${d.deliveries.map((v:any)=>`<article style="padding:16px 0;border-bottom:1px solid #dce6e0"><b>${e(state[v.status]??v.status)}</b> · ${e(v.event)}<p>${e(v.detail??'已登记等待处理')}</p>${v.workflowId?`<a href="/workflows/${u(v.workflowId)}">查看实际测试 →</a>`:''}${['FAILED','WRITE_UNCERTAIN'].includes(v.status)?`<form method="post" action="/projects/${u(id)}/integrations/events/${u(v.id)}/retry"><button>核对并重试</button></form>`:''}</article>`).join('')||'<p class="empty-state">尚无提交事件。</p>'}<nav>${page>1?`<a href="?page=${page-1}">上一页</a>`:''} ${page*30<d.total?`<a href="?page=${page+1}">下一页</a>`:''}</nav></section>`,{projectId:id}));
  }catch(error){return reply.code(error instanceof ApiError?error.status:500).type('text/html').send(errorPage(e(error instanceof Error?error.message:'加载失败')));}
 });
 app.post('/projects/:id/integrations/connect',async(req,reply)=>{
  const sid=req.cookies.web_sid;if(!sid)return reply.redirect('/login');const id=(req.params as any).id;
  try{const result=await api<any>(`/api/projects/${u(id)}/github/connect`,{sid,method:'POST',body:req.body});return reply.redirect(result.data.authorizationUrl);}catch(err){return reply.code(err instanceof ApiError?err.status:500).type('text/html').send(errorPage(e((err as Error).message)));}
 });
 app.get('/github/callback',{logLevel:'silent'},async(req,reply)=>{
  const sid=req.cookies.web_sid;if(!sid)return reply.redirect('/login');const q=req.query as any;
  try{const result=await api<any>('/api/github/callback',{sid,method:'POST',body:{code:q.code,state:q.state}});return reply.redirect(`/projects/${u(result.data.projectId)}/integrations`);}catch{return reply.code(400).type('text/html').send(errorPage('GitHub 授权未完成或已过期。返回项目集成页面重新连接。'));}
 });
 app.post('/projects/:id/integrations/:integrationId/:action',async(req,reply)=>{
  const sid=req.cookies.web_sid;if(!sid)return reply.redirect('/login');const {id,integrationId,action}=req.params as any,b=req.body as any;
  try{if(!['ci','revoke'].includes(action))throw new Error('不支持的操作');await api(`/api/github/${u(integrationId)}/${action}`,{sid,method:action==='ci'?'PUT':'POST',...(action==='ci'?{body:{enabled:b.enabled==='on',installDependencies:b.installDependencies==='on',branch:b.branch,templateId:b.templateId,kind:b.kind,subdirectory:b.subdirectory??'',timeoutSeconds:Number(b.timeoutSeconds)}}:{})});return reply.redirect(`/projects/${u(id)}/integrations`);}catch(err){return reply.code(err instanceof ApiError?err.status:500).type('text/html').send(errorPage(e((err as Error).message)));}
 });
 app.post('/projects/:id/integrations/events/:eventId/retry',async(req,reply)=>{
  const sid=req.cookies.web_sid;if(!sid)return reply.redirect('/login');const {id,eventId}=req.params as any;
  try{await api(`/api/github/deliveries/${u(eventId)}/retry`,{sid,method:'POST',body:{}});return reply.redirect(`/projects/${u(id)}/integrations`);}catch(err){return reply.code(err instanceof ApiError?err.status:500).type('text/html').send(errorPage(e((err as Error).message)));}
 });
}
