import { randomUUID } from 'node:crypto';
/** Human-readable forms; the API remains the authority for business contracts. */
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const input = (name: string, label: string, value: unknown = '') => `<label>${esc(label)}<input type="text" name="${name}" value="${esc(value)}"></label>`;
const area = (name: string, label: string, value: unknown = '') => `<label>${esc(label)}<textarea name="${name}" rows="3">${esc(value)}</textarea></label>`;
const choice = (name: string, label: string, values: [string,string][], value: unknown) => `<label>${esc(label)}<select name="${name}">${values.map(([id,text])=>`<option value="${esc(id)}" ${id===value?'selected':''}>${esc(text)}</option>`).join('')}</select></label>`;
const operators: [string,string][] = [['equals','等于'],['notEquals','不等于'],['contains','包含'],['notContains','不包含'],['gt','大于'],['gte','大于或等于'],['lt','小于'],['lte','小于或等于'],['matches','匹配表达式'],['exists','存在'],['notExists','不存在']];
const kinds: [string,string][] = [['ui.text','页面文字'],['ui.element','页面元素'],['ui.state','页面状态'],['data.value','数据值'],['api.response','接口响应'],['download.content','下载内容（执行能力待支持）'],['visual','视觉检查（执行能力待支持）']];
function remove(name: string) { return `<label class="muted"><input type="checkbox" name="${name}" value="yes">删除此项（保存新版本后生效）</label>`; }
export function repeater(name:string, title:string, rows:any[], render:(index:string,row:any)=>string) {
  return `<section class="card"><h2>${esc(title)}</h2><div data-rows="${name}">${rows.map((row,i)=>`<fieldset>${render(String(i),row)}</fieldset>`).join('')}</div><input type="hidden" name="${name}Count" value="${rows.length}"><template id="${name}-template"><fieldset>${render('__INDEX__',{})}</fieldset></template><button type="button" data-add="${name}">添加${esc(title)}</button></section>`;
}
export const repeaterScript = `<script>document.querySelectorAll('[data-add]').forEach(button=>button.addEventListener('click',()=>{const name=button.dataset.add;const count=document.querySelector('[name="'+name+'Count"]');const index=Number(count.value);if(index>=100)return;const template=document.getElementById(name+'-template');const fragment=template.content.cloneNode(true);fragment.querySelectorAll('[name]').forEach(el=>el.name=el.name.replaceAll('__INDEX__',String(index)));document.querySelector('[data-rows="'+name+'"]').appendChild(fragment);count.value=String(index+1);}));</script>`;
export function caseEditor(c:any) {
  const rules:[string,string][]=(c.availableRules??[]).map((r:any)=>[r.id,`${r.statement}（版本 ${r.version}）`]);
  const assertions = repeater('assertion','检查点',c.assertions,(i,a)=>
    `<input type="hidden" name="assertion_${i}_id" value="${esc(a.id??'')}">`+
    input(`assertion_${i}_description`,'检查说明',a.description)+choice(`assertion_${i}_rule`,'依据规则',rules,a.ruleVersionId)+
    choice(`assertion_${i}_kind`,'检查类型',kinds,a.kind??'ui.text')+choice(`assertion_${i}_operator`,'判断方式',operators,a.operator??'equals')+
    choice(`assertion_${i}_valueType`,'预期值类型',[['string','文字'],['number','数字'],['boolean','是 / 否'],['none','不需要预期值（存在性检查）']],a.expected===undefined||a.expected===null?'none':typeof a.expected)+
    input(`assertion_${i}_expected`,'预期值（是 / 否填写 true / false）',a.expected)+input(`assertion_${i}_unit`,'单位（数字比较必填；金额使用最小单位）',a.unit)+
    `<label><input type="checkbox" name="assertion_${i}_required" value="yes" ${a.required!==false?'checked':''}>必测检查点</label>`+remove(`assertion_${i}_remove`));
  const steps = repeater('step','操作步骤',c.steps,(i,s)=>`<input type="hidden" name="step_${i}_id" value="${esc(s.id??'')}">`+input(`step_${i}_role`,'执行角色',s.role??c.roles[0])+area(`step_${i}_action`,'操作内容',s.action)+area(`step_${i}_expectedResult`,'步骤观察说明（可选）',s.expectedResult)+remove(`step_${i}_remove`));
  const params = repeater('param','夹具参数',Object.entries(c.dataSpec.params??{}).map(([key,value])=>({key,value})),(i,p)=>input(`param_${i}_key`,'参数名称',p.key)+choice(`param_${i}_type`,'参数类型',[['string','文字'],['number','数字'],['boolean','是 / 否']],typeof p.value==='undefined'?'string':typeof p.value)+input(`param_${i}_value`,'参数值',p.value)+remove(`param_${i}_remove`));
  return `<h1>审阅与编辑用例</h1><p>${esc(c.title)} · 版本 ${c.version} · ${c.approvalStatus==='APPROVED'?'已批准':'待审阅'}</p><p class="muted">保存会创建新草稿。已批准用例、历史运行及验收标准保持原样。</p>
  <form method="post" action="/cases/${esc(c.id)}/revise">
  <section class="card">${input('title','用例名称',c.title)}${area('description','用例说明',c.description)}${choice('priority','优先级',[['P0','关键'],['P1','重要'],['P2','一般']],c.priority)}${area('roles','业务角色（每行一个）',c.roles.join('\n'))}${area('preconditions','前置条件（每行一个）',c.preconditions.join('\n'))}<h2>验收依据</h2>${rules.map(([id,label])=>`<label><input type="checkbox" name="ruleVersionIds" value="${esc(id)}" ${c.ruleVersionIds.includes(id)?'checked':''}>${esc(label)}</label>`).join('')}</section>
  ${steps}${assertions}<section class="card"><h2>测试数据</h2>${choice('dataStrategy','准备方式',[['create','由用例步骤创建'],['fixture','使用已配置夹具']],c.dataSpec.strategy)}${area('dataNote','数据创建说明',c.dataSpec.note)}<p class="muted">夹具须由管理员预先配置，填写名称不会自动创建执行能力。</p>${input('fixtureId','已配置夹具名称',c.dataSpec.fixtureId)}</section>${params}
  <section class="card"><h2>数据清理</h2>${choice('cleanupStrategy','清理方式',[['manual','人工清理'],['namespace','按运行隔离区清理'],['fixture','已配置夹具清理']],c.cleanup.strategy)}${area('cleanupNote','清理步骤与责任说明',c.cleanup.note)}</section><button>保存为新版本</button></form>${repeaterScript}<p><a href="/space/${esc(c.projectId)}?tab=missions">返回任务</a></p>`;
}
function text(body:any,name:string) { const v=body[name]; if(v===undefined)return ''; if(typeof v!=='string')throw new Error('表单字段重复或格式错误'); return v; }
function rows(body:any,name:string) {const n=Number(text(body,`${name}Count`));if(!Number.isInteger(n)||n<0||n>100)throw new Error('表单项目数量超限');return Array.from({length:n},(_,i)=>i).filter(i=>text(body,`${name}_${i}_remove`)!=='yes');}
function scalar(type:string,value:string):string|number|boolean|undefined {
  if(type==='none')return undefined;
  if(type==='string')return value;
  if(type==='number'&&value.trim()!==''&&Number.isFinite(Number(value)))return Number(value);
  if(type==='boolean'&&['true','false'].includes(value))return value==='true';
  throw new Error('预期值或参数与所选类型不符');
}
export function parseCaseForm(body:any) {
  const lines=(name:string)=>text(body,name).split('\n').map(v=>v.trim()).filter(Boolean);
  const params:Record<string,string|number|boolean>=Object.create(null);
  for(const i of rows(body,'param')){const key=text(body,`param_${i}_key`).trim();if(!key||Object.hasOwn(params,key))throw new Error('夹具参数名称为空或重复');params[key]=scalar(text(body,`param_${i}_type`),text(body,`param_${i}_value`))!;}
  return {
    title:text(body,'title'),description:text(body,'description'),priority:text(body,'priority'),roles:lines('roles'),preconditions:lines('preconditions'),
    ruleVersionIds:Array.isArray(body.ruleVersionIds)?body.ruleVersionIds:body.ruleVersionIds?[body.ruleVersionIds]:[],
    steps:rows(body,'step').map(i=>({id:text(body,`step_${i}_id`)||randomUUID(),role:text(body,`step_${i}_role`),action:text(body,`step_${i}_action`),expectedResult:text(body,`step_${i}_expectedResult`)})),
    assertions:rows(body,'assertion').map(i=>({id:text(body,`assertion_${i}_id`)||randomUUID(),description:text(body,`assertion_${i}_description`),ruleVersionId:text(body,`assertion_${i}_rule`),kind:text(body,`assertion_${i}_kind`),operator:text(body,`assertion_${i}_operator`),expected:scalar(text(body,`assertion_${i}_valueType`),text(body,`assertion_${i}_expected`)),unit:text(body,`assertion_${i}_unit`)||undefined,required:text(body,`assertion_${i}_required`)==='yes'})),
    dataSpec:text(body,'dataStrategy')==='create'?{strategy:'create',note:text(body,'dataNote')}:{strategy:'fixture',fixtureId:text(body,'fixtureId'),params},
    cleanup:{strategy:text(body,'cleanupStrategy'),note:text(body,'cleanupNote')},
  };
}
