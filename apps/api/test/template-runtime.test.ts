import {expect,it} from 'vitest';
import {validateExecutableGraph,BUILTIN_TEMPLATES,readReference} from '../src/template-runtime.js';
const nodes=(keys:string[])=>keys.map((k,i)=>({key:k,capabilityKey:k,capabilityVersion:1,dependsOn:i?[keys[i-1]!]:[],isApprovalGate:k.endsWith('-gate')}));
it.each(BUILTIN_TEMPLATES)('$name 的内置图可执行',t=>expect(validateExecutableGraph(nodes(t.keys))).toHaveLength(t.keys.length));
it('拒绝没接执行器的能力、伪审批门和缺少批准前置',()=>{
 expect(()=>validateExecutableGraph(nodes(['magic-pass']))).toThrow(/执行器/);
 expect(()=>validateExecutableGraph([{...nodes(['document-parse'])[0],isApprovalGate:true}])).toThrow(/人工门/);
 expect(()=>validateExecutableGraph(nodes(['browser-execute']))).toThrow(/前序/);
});
it('输入映射须是前序输出且类型正确，不能替换环境和身份',()=>{
 const graph=nodes(['document-parse','rule-extract']);
 expect(validateExecutableGraph([graph[0],{...graph[1],inputMapping:{documentVersionIds:'nodes.document-parse.documentVersionIds'}}])).toHaveLength(2);
 for(const mapping of [{documentVersionIds:'nodes.future.documentVersionIds'},{documentVersionIds:'input.buildId'},{environmentId:'input.baselineId'},{documentVersionIds:'input.__proto__'}])expect(()=>validateExecutableGraph([graph[0],{...graph[1],inputMapping:mapping}])).toThrow();
 expect(readReference('nodes.parse.documentVersionIds',{},[{nodeKey:'parse',outputRef:{documentVersionIds:['a']}}])).toEqual(['a']);
});
it('依赖顺序无需等于数组顺序，环/悬空与审批条件跳过拒绝',()=>{
 const graph=nodes(['document-parse','rule-extract']);
 expect(validateExecutableGraph([...graph].reverse())).toHaveLength(2);
 expect(()=>validateExecutableGraph([{...graph[0],dependsOn:['rule-extract']},graph[1]])).toThrow(/环/);
 expect(()=>validateExecutableGraph([{...nodes(['rule-approval-gate'])[0],condition:{variable:'input.baselineId',operator:'exists',value:true}}])).toThrow(/跳过/);
});

it('准备检查不可被条件跳过，不能只凭图上存在节点越过账号检查',()=>{
 const graph=nodes(['plan-approval-gate','login-check','browser-execute','evaluate']);
 expect(()=>validateExecutableGraph(graph.map(n=>n.capabilityKey==='login-check'?{...n,condition:{variable:'input.baselineId',operator:'exists',value:false}}:n))).toThrow(/跳过/);
});
