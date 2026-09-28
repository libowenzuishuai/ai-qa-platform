import type {OracleSpec,OracleAssertion} from '@ai-qa/contracts';
import type {NodeRunRecord} from './graph-executor.js';
// Decimal comparison uses integers, so financial boundaries do not lose precision.
function decimal(value:unknown){
  if(typeof value!=='number'&&typeof value!=='string'||String(value).length>512)return null;
  const match=/^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));if(!match)return null;
  return {n:BigInt(`${match[1]}${match[2]}${match[3]??''}`),scale:match[3]?.length??0};
}
function compare(a:unknown,b:unknown,tolerance:string|null){
  const x=decimal(a),y=decimal(b),t=decimal(tolerance??'0');if(!x||!y||!t||t.n<0n)return null;
  const scale=Math.max(x.scale,y.scale,t.scale),delta=x.n*10n**BigInt(scale-x.scale)-y.n*10n**BigInt(scale-y.scale),margin=t.n*10n**BigInt(scale-t.scale);
  return delta>margin?1:delta < -margin?-1:0;
}
function evaluate(a:OracleAssertion,value:unknown):boolean|null{
  switch(a.operator){
    case 'exists':return value!==undefined&&value!==null;
    case 'not_exists':return value===undefined||value===null;
    case 'visible':return typeof value==='boolean'?value:null;
    case 'hidden':return typeof value==='boolean'?!value:null;
    case 'equals':case 'not_equals':{
      if(value===undefined)return false;
      const numeric=a.tolerance!==null||typeof value==='number'&&typeof a.expected==='string';
      const comparison=numeric?compare(value,a.expected,a.tolerance):undefined;
      if(numeric&&comparison===null)return null;
      const equal=numeric?comparison===0:value===a.expected;
      return a.operator==='equals'?equal:!equal;
    }
    case 'greater_than':{const c=compare(value,a.expected,a.tolerance);return c===null?null:c>0;}
    case 'less_than':{const c=compare(value,a.expected,a.tolerance);return c===null?null:c<0;}
  }
}
export function verifyGraphAssertions(oracle:OracleSpec,bindings:Record<string,{nodeId:string;path:string}>,nodes:NodeRunRecord[]){
  return oracle.assertions.map(assertion=>{
    const binding=bindings[assertion.id],node=nodes.find(n=>n.nodeId===binding?.nodeId);
    if(!binding||!node||node.status!=='completed')return {assertionId:assertion.id,ruleVersionId:assertion.ruleVersionId,verdict:'review',reason:'观察未完成',actual:null};
    let value:unknown=node.output;
    for(const part of binding.path.split('.'))value=value!==null&&typeof value==='object'&&Object.hasOwn(value,part)?(value as Record<string,unknown>)[part]:undefined;
    const passed=evaluate(assertion,value);
    return {assertionId:assertion.id,ruleVersionId:assertion.ruleVersionId,verdict:passed===null?'review':passed?'pass':'fail',actual:value??null,expected:assertion.expected};
  });
}
