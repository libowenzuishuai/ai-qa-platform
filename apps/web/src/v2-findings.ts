import type {FastifyInstance} from 'fastify';
import {api,ApiError} from './api.js';
import {layout} from './pages.js';
const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const labels:Record<string,string>={candidate:'待核实',investigating:'调查中',reproduced:'已复现',human_confirmed:'人工确认',fix_verified:'修复已验证',rejected:'已驳回'};
interface FindingRow{id:string;projectId:string;status:string;expected:string;actual:string;buildId:string;role:string|null;severity:{level:string;basis:string}|null;firstFailure:{sessionId:string|null;evidenceIds:string[];observedAt:string};hypotheses:Array<{text:string;status:string;supportingEvidence:unknown[];contradictingEvidence:unknown[]}>}
export function registerFindingPages(app:FastifyInstance){
 app.get('/space/:id/findings',async(req,reply)=>{
  const sid=req.cookies.web_sid;if(!sid)return reply.redirect('/login');const {id}=req.params as {id:string};
  try{const data=(await api<{findings:FindingRow[]}>(`/api/v2/projects/${encodeURIComponent(id)}/findings`,{sid})).data;
   return reply.type('text/html').send(layout('缺陷调查',`<div class="page-heading"><div><span class="eyebrow">FINDINGS & EVIDENCE</span><h1>每一个缺陷，都有独立依据</h1><p>先保留首次失败，再用同标准的独立运行复现和验证修复。定位故障与业务缺陷分开记录。</p></div></div><div class="grid">${data.findings.map(f=>`<section class="card"><span class="badge REVIEW">${esc(labels[f.status]??f.status)}</span><h2><a href="/v2/findings/${esc(f.id)}">${esc(f.expected.slice(0,100))}</a></h2><p><b>实际结果：</b>${esc(f.actual.slice(0,200))}</p><p class="muted">构建 ${esc(f.buildId)} · ${f.firstFailure.evidenceIds.length} 份首败证据</p></section>`).join('')||'<section class="card empty-state">还没有缺陷记录。没有记录不代表所有业务已被测试。</section>'}</div>`,{projectId:id,projectName:'缺陷调查'}));
  }catch(e){return reply.code(e instanceof ApiError?e.status:500).send(esc((e as Error).message));}
 });
 app.get('/v2/findings/:id',async(req,reply)=>{
  const sid=req.cookies.web_sid;if(!sid)return reply.redirect('/login');const {id}=req.params as {id:string};
  try{const d=(await api<{finding:FindingRow;evidenceComplete:boolean;comparisons:Array<{id:string;goal:string;buildId:string;result:{verdict?:string}|null}>;audit:Array<{action:string;createdAt:string;metadata:unknown}>}>(`/api/v2/findings/${encodeURIComponent(id)}`,{sid})).data,f=d.finding;
   const options=d.comparisons.filter(c=>c.id!==f.firstFailure.sessionId).map(c=>`<option value="${esc(c.id)}">${esc(c.goal)} · ${esc(c.buildId)} · ${esc(c.result?.verdict??'待判定')}</option>`).join('');
   return reply.type('text/html').send(layout('缺陷证据与复测',`<style>.finding-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.finding-grid>section{min-width:0}.finding-value{white-space:pre-wrap;overflow-wrap:anywhere}.finding-form label{display:block;margin:12px 0}.finding-form select,.finding-form textarea{width:100%;padding:10px;box-sizing:border-box}@media(max-width:700px){.finding-grid{grid-template-columns:1fr}}</style>
<div class="page-heading"><div><span class="eyebrow">DEFECT INVESTIGATION</span><h1>事实、假设与复测</h1><p><b>${esc(labels[f.status]??f.status)}</b> · 首败构建 ${esc(f.buildId)} · ${esc(f.role??'未限定角色')}</p></div></div>
${!d.evidenceComplete?'<p class="error-box">原始证据缺失或已失效，现阶段需要重新复核。</p>':''}
${(req.query as {error?:string}).error?`<p class="error-box">${esc((req.query as {error:string}).error)}</p>`:''}
<div class="finding-grid"><section class="card"><h2>批准的期望</h2><p class="finding-value">${esc(f.expected)}</p></section><section class="card"><h2>首次观察到的实际结果</h2><p class="finding-value">${esc(f.actual)}</p><p>${esc(f.firstFailure.observedAt)}</p>${f.firstFailure.sessionId?`<a href="/v2/sessions/${esc(f.firstFailure.sessionId)}">查看首次失败的运行与证据 →</a>`:''}</section></div>
<section class="card"><h2>根因假设</h2>${f.hypotheses.map(h=>`<article><h3>${esc(h.text)}</h3><p>状态 ${esc(h.status)} · 支持证据 ${h.supportingEvidence.length} · 反对证据 ${h.contradictingEvidence.length}</p></article>`).join('')||'<p class="muted">尚未形成根因假设，当前记录只说明结果不符合业务标准。</p>'}<p>${f.severity?`严重度：${esc(f.severity.level)}；依据：${esc(f.severity.basis)}`:'严重度尚未评定。'}</p></section>
<section class="card finding-form"><h2>用独立运行验证</h2><p>复现必须使用相同构建；验证修复必须使用不同构建。两次运行的标准、组合版本和环境必须一致，构建身份和证据需要真实核验。</p>${options?`<form method="post" action="/v2/findings/${esc(id)}/verify-session"><label>对照运行<select name="sessionId" required>${options}</select></label><label>目的<select name="purpose"><option value="reproduce">复现原始缺陷</option><option value="verify_fix">验证修复结果</option></select></label><button>核验运行与原始证据</button></form>`:'<p>目前没有可用于对照的独立运行。请先用相同组合和标准重新运行。</p>'}</section>
<section class="card finding-form"><h2>人工评审</h2><form method="post" action="/v2/findings/${esc(id)}/status"><label>评审结论<select name="status"><option value="investigating">继续调查</option><option value="human_confirmed">人工确认缺陷</option><option value="rejected">驳回候选</option></select></label><label>依据<textarea name="reason" required maxlength="2000"></textarea></label><button>保存评审记录</button></form></section>
<section class="card"><h2>状态审计</h2><ul>${d.audit.map(a=>`<li>${esc(a.createdAt)} · ${esc(a.action)}<details><summary>查看依据</summary><pre class="finding-value">${esc(JSON.stringify(a.metadata,null,2))}</pre></details></li>`).join('')||'<li>尚无人工变更。</li>'}</ul></section>`,{projectId:f.projectId,projectName:'缺陷调查'}));
  }catch(e){return reply.code(e instanceof ApiError?e.status:500).send(esc((e as Error).message));}
 });
 app.post('/v2/findings/:id/:action',async(req,reply)=>{
  const sid=req.cookies.web_sid;if(!sid)return reply.redirect('/login');const {id,action}=req.params as {id:string;action:string};if(!['status','verify-session'].includes(action))return reply.code(404).send('未知操作');
  const f=req.body as Record<string,string>;const body=action==='status'?{status:f.status,reason:f.reason}:{sessionId:f.sessionId,purpose:f.purpose};
  try{await api(`/api/v2/findings/${encodeURIComponent(id)}/${action}`,{sid,method:'POST',body});return reply.redirect(`/v2/findings/${encodeURIComponent(id)}`);}catch(e){return reply.redirect(`/v2/findings/${encodeURIComponent(id)}?error=${encodeURIComponent((e as Error).message)}`);}
 });
}
