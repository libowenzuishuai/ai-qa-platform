import type { FastifyInstance } from "fastify";
import { api, ApiError } from "./api.js";
import { layout } from "./pages.js";
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const embedded = (v:unknown) => JSON.stringify(v).replace(/</g,"\\u003c");

/** One AST for visual node editing, advanced form input and server validation. */
export function registerComposerPages(app: FastifyInstance) {
 app.post('/space/:id/composer/enable-reproduction',async(req,reply)=>{const sid=req.cookies.web_sid;if(!sid)return reply.redirect('/login');const {id}=req.params as {id:string};try{const list=(await api<{manifests:Array<{id:string}>}>(`/api/v2/projects/${encodeURIComponent(id)}/capabilities/builtins`,{sid})).data;const manifest=list.manifests.find(m=>m.id==='platform.reproduction-minimize');if(!manifest)throw Error('复现能力未配置');const install=(await api<{installationId:string}>(`/api/v2/projects/${encodeURIComponent(id)}/capabilities/install`,{sid,method:'POST',body:{manifest}})).data;await api(`/api/v2/installations/${encodeURIComponent(install.installationId)}/authorize`,{sid,method:'POST',body:{scope:['fixture:isolated-reproduction']}});return reply.redirect(`/space/${encodeURIComponent(id)}/composer`);}catch(e){return reply.code(422).send(esc((e as Error).message));}});

  app.get("/space/:id/composer", async(req,reply)=>{
    const sid=req.cookies.web_sid;
    if(!sid) return reply.redirect("/login");
    const {id}=req.params as {id:string};
    try {
      const [catalog,definitions]=await Promise.all([
        api<{installations:Array<{capabilityId:string;capabilityVersion:string;humanName:string;status:string}>}>(`/api/v2/projects/${encodeURIComponent(id)}/capabilities`,{sid}),
        api<{definitions:Array<{id:string;name:string;version:number;status:string}>}>(`/api/v2/projects/${encodeURIComponent(id)}/definitions`,{sid}),
      ]);
      const query=req.query as {definition?:string};
      let initial:unknown={name:"新的测试组合",description:"",nodes:[],maxSubflowDepth:4};
      if(query.definition){
        const row=(await api<{projectId:string;content:unknown}>(`/api/v2/definitions/${encodeURIComponent(query.definition)}`,{sid})).data;
        if(row.projectId!==id) return reply.code(403).send("组合不属于本项目");
        initial=row.content;
      }
      const capabilities=catalog.data.installations.filter(c=>c.status==="AUTHORIZED");
      return reply.type("text/html").send(layout("测试能力组合",`
<style>
.compose-grid{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(290px,1fr);gap:20px}.compose-canvas{min-height:320px;padding:22px;background:radial-gradient(#81909f45 1px,transparent 1px);background-size:20px 20px;border:1px solid #d6dce6;border-radius:16px;display:flex;flex-direction:column;align-items:stretch;gap:12px}.flow-node{text-align:left;display:block;background:#fff;color:#16233e;border:1px solid #b5c4dc;border-radius:12px;padding:16px;box-shadow:0 5px 18px #172b4d0d;cursor:pointer}.flow-node.selected{border:2px solid #376bd8}.flow-node small{display:block;color:#5b6c82;margin-top:7px}.compose-toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}.compose-editor label{display:block;margin:14px 0 6px}.compose-editor textarea,.compose-editor input,.compose-editor select{width:100%;box-sizing:border-box}.compose-editor input,.compose-editor textarea{padding:10px 12px;border:1px solid #cbd8d5;border-radius:8px;background:#fff;color:#173337}.compose-editor textarea{min-height:90px;font:13px monospace}.compose-status{padding:12px;border-radius:10px;background:#edf3ff;white-space:pre-wrap;overflow-wrap:anywhere}.compose-list{display:flex;gap:10px;flex-wrap:wrap}.compose-empty{padding:50px 20px;text-align:center;color:#68758c}@media(max-width:760px){.compose-grid{grid-template-columns:1fr}}
</style>
<div class="page-heading"><div><span class="eyebrow">HARNESS STUDIO</span><h1>把测试能力组合起来</h1><p>选择已授权能力、设置依赖与参数，保存为有版本的测试组合。画布与表单编辑的是同一份定义。</p></div></div>
<div class="compose-list">${definitions.data.definitions.map(d=>`<a href="?definition=${esc(d.id)}">${esc(d.name)} · v${d.version} · ${esc(d.status)}</a>`).join("")||"还没有保存的组合"}</div>
<section class="card compose-editor"><label for="flow-name">组合名称</label><input id="flow-name" maxlength="200"><label for="flow-description">用途</label><input id="flow-description" maxlength="2000">
<details class="card"><summary>隔离复现工具</summary><p>要求目标测试夹具提供独立命名空间、重置、执行和清理协议。每次删减保留相同构建、标准与失败签名；残留不会算清理成功。</p><form method="post" action="/space/${esc(id)}/composer/enable-reproduction"><button>启用并授权隔离复现缩减能力（管理员）</button></form></details><div class="compose-toolbar"><select id="capability" aria-label="已授权能力">${capabilities.map((c,i)=>`<option value="${i}">${esc(c.humanName)} · ${esc(c.capabilityVersion)}</option>`).join("")}</select><button id="add-node" ${capabilities.length?"":"disabled"}>添加能力</button><button id="validate-flow">检查组合</button><button id="save-flow">保存版本</button><button id="publish-flow" disabled>发布已保存版本</button></div>
<p class="muted">${capabilities.length?"点击节点编辑，拖动一个节点到另一节点上建立依赖。依赖决定执行次序；发布冻结当前版本。":"本项目尚无已授权能力。请先在能力目录完成安装和授权。"} 发布后可选择运行配置、环境和批准标准发起验收。 <a href="/space/${esc(id)}/composer/run">运行已发布组合 →</a></p>
<div class="compose-grid"><div id="canvas" class="compose-canvas" aria-label="组合画布"></div><div id="editor" class="compose-editor">
<p id="pick-node">选择一个节点查看配置</p><div id="node-fields" hidden><label for="node-id">节点标识</label><input id="node-id"><label for="depends">等待哪些节点（逗号分隔）</label><input id="depends" placeholder="check-login, create-data"><label for="failure">失败时</label><select id="failure"><option value="fail">停止组合</option><option value="require_human">请人处理</option><option value="skip">跳过</option></select>
<div id="parameter-fields"></div><details><summary>高级：参数绑定 JSON</summary><textarea id="bindings" spellcheck="false"></textarea></details><details><summary>高级：条件 / 重试 / 循环 / 子流程</summary><textarea id="policies" aria-label="高级策略 JSON" spellcheck="false"></textarea></details><div class="compose-toolbar"><button id="apply-node">应用节点设置</button><button id="delete-node" class="danger">删除节点</button></div></div></div></div>
<p id="compose-status" class="compose-status" role="status">尚未校验</p></section><p><a href="/space/${esc(id)}/autonomous">← 返回自主测试</a></p>
<script>
const catalog=${embedded(capabilities)}, ast=${embedded(initial)}, project=${embedded(id)};
let selected=-1,savedId=null,dirty=true,pending=false;
const $=id=>document.getElementById(id), note=text=>$('compose-status').textContent=text;
$('flow-name').value=ast.name;$('flow-description').value=ast.description;
function changed(){dirty=true;savedId=null;$('publish-flow').disabled=true;note('有未保存修改');}
function render(){const canvas=$('canvas');canvas.replaceChildren();if(!ast.nodes.length){const e=document.createElement('p');e.className='compose-empty';e.textContent='从上方添加第一个测试能力';canvas.append(e);}
ast.nodes.forEach((node,i)=>{const b=document.createElement('button');b.className='flow-node'+(i===selected?' selected':'');b.type='button';b.textContent=node.nodeId;const label=document.createElement('small');label.textContent=node.capabilityId+' @ '+node.capabilityVersion+' · '+(node.dependsOn.length?'等待 '+node.dependsOn.join(' → '):'起点');b.append(label);b.onclick=()=>select(i);b.draggable=true;b.ondragstart=e=>e.dataTransfer.setData('text/plain',node.nodeId);b.ondragover=e=>e.preventDefault();b.ondrop=e=>{e.preventDefault();const source=e.dataTransfer.getData('text/plain');if(source===node.nodeId||!ast.nodes.some(n=>n.nodeId===source))return;const reaches=(id,target,seen=new Set())=>{if(id===target)return true;if(seen.has(id))return false;seen.add(id);return (ast.nodes.find(n=>n.nodeId===id)?.dependsOn||[]).some(dep=>reaches(dep,target,seen));};if(reaches(source,node.nodeId)){note('这条依赖会形成循环，未连接');return;}if(!node.dependsOn.includes(source)){node.dependsOn.push(source);changed();select(i);note('已连接 '+source+' → '+node.nodeId+'，请保存版本');}};canvas.append(b);});}
function select(i){selected=i;render();$('pick-node').hidden=true;$('node-fields').hidden=false;const n=ast.nodes[i];$('node-id').value=n.nodeId;$('depends').value=n.dependsOn.join(', ');$('failure').value=n.onFailure;$('bindings').value=JSON.stringify(n.bindings,null,2);const p={};for(const k of ['condition','retry','repeat','map','subflow'])if(n[k]!==undefined)p[k]=n[k];$('policies').value=JSON.stringify(p,null,2);renderParameters(n);}
function renderParameters(n){const host=$('parameter-fields');host.replaceChildren();const cap=catalog.find(c=>c.capabilityId===n.capabilityId&&c.capabilityVersion===n.capabilityVersion);const properties=cap?.inputSchema?.properties||{};
for(const [key,schema] of Object.entries(properties)){const label=document.createElement('label');label.textContent=key+(cap.inputSchema.required?.includes(key)?' *':'');const row=document.createElement('div');row.dataset.param=key;const type=schema.type==='integer'?'number':['array','object'].includes(schema.type)?'json':schema.type;row.dataset.type=type;const source=document.createElement('select');source.setAttribute('aria-label',key+' 来源');for(const [v,t] of [['input','任务输入'],['constant','固定值'],['node','上游结果']]){if(type==='json'&&v==='constant')continue;const o=document.createElement('option');o.value=v;o.textContent=t;source.append(o);}const upstream=document.createElement('select');upstream.setAttribute('aria-label',key+' 上游节点');for(const item of ast.nodes.filter(x=>x.nodeId!==n.nodeId)){const o=document.createElement('option');o.value=item.nodeId;o.textContent=item.nodeId;upstream.append(o);}const value=document.createElement('input');value.setAttribute('aria-label',key+' 值或路径');const b=n.bindings[key];source.value=b?.source||'input';value.value=b?.source==='constant'?String(b.value):b?.path||key;upstream.value=b?.nodeId||'';const sync=()=>{upstream.hidden=source.value!=='node';const binding={source:source.value,type};if(source.value==='constant'){binding.value=type==='number'?Number(value.value):type==='boolean'?value.value==='true':value.value;}else{binding.path=value.value;if(source.value==='node')binding.nodeId=upstream.value;}const draft=JSON.parse($('bindings').value||'{}');if(!value.value&&!cap.inputSchema.required?.includes(key))delete draft[key];else draft[key]=binding;$('bindings').value=JSON.stringify(draft,null,2);pending=true;changed();};upstream.hidden=source.value!=='node';source.onchange=sync;upstream.onchange=sync;value.oninput=sync;row.append(source,upstream,value);host.append(label,row);}}
$('add-node').onclick=()=>{const c=catalog[Number($('capability').value)];if(!c)return;let i=ast.nodes.length+1;while(ast.nodes.some(n=>n.nodeId==='step-'+i))i++;ast.nodes.push({nodeId:'step-'+i,capabilityId:c.capabilityId,capabilityVersion:c.capabilityVersion,dependsOn:[],bindings:{},onFailure:'fail'});changed();select(ast.nodes.length-1);};
$('apply-node').onclick=()=>{try{const old=ast.nodes[selected];if(!old)return;const name=$('node-id').value.trim();if(!/^[a-z][a-z0-9-]*$/.test(name))throw Error('标识使用小写字母、数字和连字符');if(ast.nodes.some((n,i)=>i!==selected&&n.nodeId===name))throw Error('节点标识重复');const bindings=JSON.parse($('bindings').value),policies=JSON.parse($('policies').value);if(Object.keys(policies).some(k=>!['condition','retry','repeat','map','subflow'].includes(k)))throw Error('未知高级策略');const previous=old.nodeId;ast.nodes[selected]={nodeId:name,capabilityId:old.capabilityId,capabilityVersion:old.capabilityVersion,dependsOn:$('depends').value.split(',').map(x=>x.trim()).filter(Boolean),onFailure:$('failure').value,bindings,...policies};if(name!==previous){for(const n of ast.nodes){n.dependsOn=n.dependsOn.map(x=>x===previous?name:x);const walk=x=>{if(!x||typeof x!=='object')return;if(x.source==='node'&&x.nodeId===previous)x.nodeId=name;for(const v of Object.values(x))walk(v);};walk(n.bindings);walk(n.condition);walk(n.repeat);walk(n.map);}}pending=false;changed();select(selected);}catch(e){note(e.message);}};
$('delete-node').onclick=()=>{if(selected<0)return;const id=ast.nodes[selected].nodeId;if(ast.nodes.some((n,i)=>i!==selected&&(n.dependsOn.includes(id)||JSON.stringify(n.bindings).includes('"nodeId":"'+id+'"')))){note('其他节点依赖此节点，请先修改依赖和绑定');return;}ast.nodes.splice(selected,1);selected=-1;$('node-fields').hidden=true;$('pick-node').hidden=false;changed();render();};
for(const id of ['node-id','depends','failure','bindings','policies'])$(id).addEventListener('input',()=>{pending=true;changed();note('节点设置待应用：请先点击“应用节点设置”');});
$('flow-name').oninput=()=>{ast.name=$('flow-name').value;changed();};$('flow-description').oninput=()=>{ast.description=$('flow-description').value;changed();};
async function send(action){if(pending)throw Error('请先应用节点设置');const res=await fetch('/space/'+encodeURIComponent(project)+'/composer/'+action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(action==='publish'?{definitionId:savedId}:ast)});const data=await res.json();if(!res.ok)throw Error(data.message||'操作失败');return data;}
$('validate-flow').onclick=async()=>{try{const r=await send('validate');note(r.ok?'组合结构检查通过；尚未执行':r.problems.join('\\n'));}catch(e){note(e.message);}};
$('save-flow').onclick=async()=>{try{const r=await send('save');savedId=r.definitionId;dirty=false;$('publish-flow').disabled=false;note('已保存 v'+r.version+' · '+r.status);}catch(e){note(e.message);}};
$('publish-flow').onclick=async()=>{if(dirty||!savedId)return;try{const r=await send('publish');note('已发布 v'+r.version+'；此版本不可变。后续修改会保存新版本。');$('publish-flow').disabled=true;}catch(e){note(e.message);}};
render();
</script>`,{projectId:id,projectName:"测试能力组合"}));
    } catch(e){return reply.code(e instanceof ApiError?e.status:500).type("text/html").send(layout("组合加载失败",`<p class="error-box">${esc((e as Error).message)}</p>`));}
  });
  app.post("/space/:id/composer/:action",async(req,reply)=>{
    const sid=req.cookies.web_sid;if(!sid)return reply.code(401).send({message:"请先登录"});
    const {id,action}=req.params as {id:string;action:string};
    try{
      let path=`/api/v2/projects/${encodeURIComponent(id)}/definitions`;
      if(action==="validate")path+="/validate";
      else if(action==="publish"){
        const definitionId=(req.body as {definitionId?:string}).definitionId;
        if(typeof definitionId!=="string")return reply.code(422).send({message:"请先保存组合"});
        const row=(await api<{projectId:string}>(`/api/v2/definitions/${encodeURIComponent(definitionId)}`,{sid})).data;
        if(row.projectId!==id)return reply.code(403).send({message:"组合不属于本项目"});
        path=`/api/v2/definitions/${encodeURIComponent(definitionId)}/publish`;
      }else if(action!=="save")return reply.code(404).send({message:"未知操作"});
      const result=await api(path,{sid,method:"POST",body:action==="publish"?{}:req.body});return reply.code(result.status).send(result.data);
    }catch(e){return reply.code(e instanceof ApiError?e.status:500).send({message:(e as Error).message});}
  });
}
