import type {FastifyInstance} from 'fastify';
import {randomUUID} from 'node:crypto';
import {api,ApiError} from './api.js';
import {layout} from './pages.js';
const embedded=(v:unknown)=>JSON.stringify(v).replace(/</g,'\\u003c');
const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function registerGraphRunnerPages(app:FastifyInstance){
 app.get('/space/:id/composer/run',async(req,reply)=>{
  const sid=req.cookies.web_sid;if(!sid)return reply.redirect('/login');const {id}=req.params as {id:string};
  try{
   const [definitions,profiles,oracles,environments,catalog]=await Promise.all([
    api<{definitions:Array<{id:string;name:string;version:number;status:string}>}>(`/api/v2/projects/${id}/definitions`,{sid}),
    api<{profiles:Array<{id:string;key:string;version:number;status:string}>}>(`/api/v2/projects/${id}/profiles`,{sid}),
    api<{oracleSpecs:Array<{id:string;version:number;status:string}>}>(`/api/v2/projects/${id}/oracle-specs`,{sid}),
    api<{environments:Array<{id:string;name:string;baseUrl:string}>}>(`/api/projects/${id}/environments`,{sid}),
    api<{installations:Array<{id:string;capabilityId:string;capabilityVersion:string;status:string}>}>(`/api/v2/projects/${id}/capabilities`,{sid}),
   ]);
   const query=req.query as {error?:string;profile?:string};
   const options=(rows:Array<{id:string;label:string}>)=>rows.map(r=>`<option value="${esc(r.id)}">${esc(r.label)}</option>`).join('');
   return reply.type('text/html').send(layout('运行测试组合',`
<style>.launch-grid{display:grid;grid-template-columns:1.5fr 1fr;gap:22px}.launch-grid label{display:block;margin:15px 0 6px}.launch-grid input,.launch-grid textarea,.launch-grid select{box-sizing:border-box;width:100%;padding:11px;border:1px solid #cbd8d5;border-radius:9px}.launch-grid textarea{min-height:100px;font:13px monospace}.launch-grid .cap-choice{display:flex;gap:10px;align-items:center}.launch-grid .cap-choice input{width:auto}@media(max-width:800px){.launch-grid{grid-template-columns:1fr}}</style>
<div class="page-heading"><div><span class="eyebrow">RUN YOUR HARNESS</span><h1>让组合真正跑起来</h1><p>选择标准、组合和测试环境。每一步保存证据，结果未知的写入会停下等待核对。</p></div></div>
${query.error?`<p class="error-box">${esc(query.error)}</p>`:''}${query.profile?'<p class="notice">运行配置已发布，可以选择它开始验收。</p>':''}
<div class="launch-grid"><section class="card"><h2>发起组合验收</h2><form id="graph-launch" method="post" action="/space/${esc(id)}/composer/run">
<label>验收目标<input name="goal" required maxlength="4000" placeholder="例如：检查采购申请保存后的状态和金额"></label>
<label>已发布组合<select name="definitionId" required>${options(definitions.data.definitions.filter(x=>x.status==='PUBLISHED').map(x=>({id:x.id,label:`${x.name} · v${x.version}`})))}</select></label>
<label>运行配置<select name="profileId" required>${options(profiles.data.profiles.filter(x=>x.status==='PUBLISHED').map(x=>({id:x.id,label:`${x.key} · v${x.version}`})))}</select></label>
<label>已批准验收标准<select name="oracleSpecId" required>${options(oracles.data.oracleSpecs.filter(x=>x.status==='APPROVED').map(x=>({id:x.id,label:`标准 v${x.version} · ${x.id}`})))}</select></label>
<label>测试环境<select name="environmentId" required>${options(environments.data.environments.map(x=>({id:x.id,label:x.name})))}</select></label>
<label>本次构建标识<input name="buildId" required placeholder="提交 SHA 或部署版本（当前仅记录声明）"></label>
<h3>任务参数</h3><div id="task-fields"></div><h3>业务标准与观察结果</h3><div id="assertion-fields"></div><p class="muted">选择每条标准对应的只读节点和结果字段。写入回执不能代替业务验收。</p>
<input type="hidden" name="taskInput"><input type="hidden" name="assertionBindings"><p id="launch-note" role="status"></p>
<label>时间预算（秒）<input type="number" name="seconds" min="10" max="1800" value="120" required></label><label>工具调用上限<input type="number" name="tools" min="1" max="1000" value="40" required></label><label>新增资源上限<input type="number" name="resources" min="0" max="100" value="0" required></label>
<input type="hidden" name="idempotencyKey" value="${randomUUID()}"><button type="submit">开始验收 →</button></form></section>
<aside class="card"><h2>发布运行配置</h2><p>固定能力版本与安装授权。配置发布后，新修改会形成新版本。</p><form method="post" action="/space/${esc(id)}/composer/profile"><label>配置名称<input name="key" pattern="[a-z][a-z0-9-]*" required placeholder="release-checks"></label>
${catalog.data.installations.filter(x=>x.status==='AUTHORIZED').map(x=>`<label class="cap-choice"><input type="checkbox" name="installation" value="${esc(x.id)}">${esc(x.capabilityId)} · ${esc(x.capabilityVersion)}</label>`).join('')||'<p>先安装并授权所需能力。</p>'}
<button type="submit">保存并发布配置</button></form><hr><h3>运行前确认</h3><p>使用独立测试环境和已批准的业务标准。当前组合入口运行已配置的工具图；目标自主规划仍通过独立会话入口使用。</p><a href="/space/${esc(id)}/composer">← 返回组合编辑</a></aside></div>
<script>
const project=${embedded(id)},catalog=${embedded(catalog.data.installations)},environments=${embedded(environments.data.environments)};
const form=document.getElementById('graph-launch'),note=document.getElementById('launch-note');let loading=0;
const inputRefs=[];const assertionRefs=[];
async function refresh(){const generation=++loading;const button=form.querySelector('button[type=submit]');button.disabled=true;for(const el of document.querySelectorAll('#task-fields input,#assertion-fields input,#assertion-fields select'))el.disabled=true;note.textContent='正在加载组合和业务标准';try{
const definitionId=form.elements.definitionId.value,oracleId=form.elements.oracleSpecId.value;if(!definitionId||!oracleId)throw Error('请先发布组合并批准业务标准');
const responses=await Promise.all([fetch('/space/'+project+'/composer/resource/definition/'+encodeURIComponent(definitionId)),fetch('/space/'+project+'/composer/resource/oracle/'+encodeURIComponent(oracleId))]);if(responses.some(r=>!r.ok))throw Error('无法加载标准或组合');const [definition,oracle]=await Promise.all(responses.map(r=>r.json()));if(generation!==loading)return;
const fields=document.getElementById('task-fields');fields.replaceChildren();inputRefs.length=0;const seen=new Set();
for(const node of definition.content.nodes)for(const binding of Object.values(node.bindings)){if(binding.source!=='input'||binding.path==='$item'||seen.has(binding.path))continue;seen.add(binding.path);const label=document.createElement('label');label.textContent=binding.path;const input=document.createElement('input');input.required=true;input.type=binding.type==='number'?'number':'text';if(binding.type==='number')input.step='any';input.setAttribute('aria-label','任务参数 '+binding.path);if(/baseUrl|url/i.test(binding.path))input.value=environments.find(e=>e.id===form.elements.environmentId.value)?.baseUrl||'';if(binding.type==='json'){input.placeholder='对象参数需要展开配置，当前请输入有效 JSON';}label.append(input);fields.append(label);inputRefs.push({binding,input});}
const assertions=document.getElementById('assertion-fields');assertions.replaceChildren();assertionRefs.length=0;
for(const assertion of oracle.assertions){const label=document.createElement('label');label.textContent=assertion.fact+' · '+assertion.operator+' '+String(assertion.expected??'');const node=document.createElement('select');node.required=true;node.setAttribute('aria-label',assertion.fact+' 观察节点');const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='选择只读观察节点';node.append(placeholder);for(const n of definition.content.nodes){const cap=catalog.find(c=>c.capabilityId===n.capabilityId&&c.capabilityVersion===n.capabilityVersion);if(cap?.effectClass!=='READ'||definition.content.nodes.some(other=>other.dependsOn.includes(n.nodeId)))continue;const o=document.createElement('option');o.value=n.nodeId;o.textContent=n.nodeId;node.append(o);}const path=document.createElement('input');path.required=true;path.placeholder='结果字段，例如 status 或 data.total';path.setAttribute('aria-label',assertion.fact+' 结果字段');if(assertion.observationType==='api_status')path.value='status';if(assertion.observationType==='ui_text')path.value='text';label.append(node,path);assertions.append(label);assertionRefs.push({assertion,node,path});}
button.disabled=false;note.textContent='运行将冻结上述配置，预算不会因暂停或恢复重置。';}catch(e){note.textContent=e.message;}}
for(const key of ['definitionId','oracleSpecId','environmentId'])form.elements[key].addEventListener('change',refresh);
form.addEventListener('submit',event=>{try{const input={};for(const {binding,input:field}of inputRefs){const parts=binding.path.split('.');if(parts.some(p=>['__proto__','prototype','constructor'].includes(p)))throw Error('参数路径非法');let cursor=input;for(const p of parts.slice(0,-1))cursor=cursor[p]??=( {} );cursor[parts.at(-1)]=binding.type==='number'?Number(field.value):binding.type==='boolean'?JSON.parse(field.value):binding.type==='json'?JSON.parse(field.value):field.value;}const bindings={};for(const {assertion,node,path}of assertionRefs)bindings[assertion.id]={nodeId:node.value,path:path.value};form.elements.taskInput.value=JSON.stringify(input);form.elements.assertionBindings.value=JSON.stringify(bindings);}catch(e){event.preventDefault();note.textContent='参数格式不正确：'+e.message;}});refresh();
</script>`,{projectId:id,projectName:'测试组合'}));
  }catch(e){return reply.code(e instanceof ApiError?e.status:500).send(esc((e as Error).message));}
 });
 app.get('/space/:id/composer/resource/:kind/:ref',async(req,reply)=>{
  const sid=req.cookies.web_sid;if(!sid)return reply.code(401).send({message:'请登录'});const {id,kind,ref}=req.params as {id:string;kind:string;ref:string};
  const prefix=kind==='definition'?'definitions':kind==='oracle'?'oracle-specs':null;if(!prefix)return reply.code(404).send({message:'未知资源'});
  try{const row=(await api<{projectId:string}>(`/api/v2/${prefix}/${encodeURIComponent(ref)}`,{sid})).data;if(row.projectId!==id)return reply.code(403).send({message:'资源不属于项目'});return row;}catch(e){return reply.code(e instanceof ApiError?e.status:500).send({message:(e as Error).message});}
 });
 app.post('/space/:id/composer/run',async(req,reply)=>{
  const sid=req.cookies.web_sid;if(!sid)return reply.redirect('/login');const {id}=req.params as {id:string};const form=req.body as Record<string,string>;
  try{
   const result=await api<{sessionId:string}>(`/api/v2/projects/${encodeURIComponent(id)}/graph-sessions`,{sid,method:'POST',body:{goal:form.goal,definitionId:form.definitionId,profileId:form.profileId,oracleSpecId:form.oracleSpecId,environmentId:form.environmentId,buildId:form.buildId,taskInput:JSON.parse(form.taskInput!),assertionBindings:JSON.parse(form.assertionBindings!),budget:{maxWallClockMs:Number(form.seconds)*1000,maxActiveMs:Number(form.seconds)*1000,maxToolCalls:Number(form.tools),maxResources:Number(form.resources),maxModelCalls:0,maxTokens:0,maxCostMicros:null},idempotencyKey:form.idempotencyKey}});
   return reply.redirect(`/v2/sessions/${encodeURIComponent(result.data.sessionId)}`);
  }catch(e){return reply.redirect(`/space/${encodeURIComponent(id)}/composer/run?error=${encodeURIComponent((e as Error).message)}`);}
 });
 app.post('/space/:id/composer/profile',async(req,reply)=>{
  const sid=req.cookies.web_sid;if(!sid)return reply.redirect('/login');const {id}=req.params as {id:string};const form=req.body as {key:string;installation?:string|string[]};
  try{
   const catalog=(await api<{installations:Array<{id:string;capabilityId:string;capabilityVersion:string;status:string}>}>(`/api/v2/projects/${encodeURIComponent(id)}/capabilities`,{sid})).data;
   const ids=Array.isArray(form.installation)?form.installation:form.installation?[form.installation]:[];
   const capabilities=ids.map(id=>{const x=catalog.installations.find(x=>x.id===id&&x.status==='AUTHORIZED');if(!x)throw Error('能力已被撤销或不属于本项目');return {capabilityId:x.capabilityId,version:x.capabilityVersion,installationId:x.id};});
   const profile=await api<{id:string}>(`/api/v2/projects/${encodeURIComponent(id)}/profiles`,{sid,method:'POST',body:{key:form.key,content:{capabilities,modelRoutes:{generator:'disabled',vision:'disabled',decision:'deterministic-v1'},verifierPolicy:'oracle-graph-v1',memoryPolicy:'none'}}});
   await api(`/api/v2/profiles/${encodeURIComponent(profile.data.id)}/publish`,{sid,method:'POST',body:{}});
   return reply.redirect(`/space/${encodeURIComponent(id)}/composer/run?profile=${encodeURIComponent(profile.data.id)}`);
  }catch(e){return reply.redirect(`/space/${encodeURIComponent(id)}/composer/run?error=${encodeURIComponent((e as Error).message)}`);}
 });
}
