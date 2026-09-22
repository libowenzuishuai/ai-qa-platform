import { RuleExtractionOutput, canonicalStringify } from '@ai-qa/contracts';
export interface ChunkExtractionResult {chunkId:string;seq:number;output:RuleExtractionOutput}
/** Platform reference reconciliation. Preserve semantics; detect only literal expectation/forbidden contradictions in identical scopes. */
export function mergeChunkExtractions(results:ChunkExtractionResult[]):RuleExtractionOutput {
  if(results.length>1000 || results.reduce((n,r)=>n+r.output.ruleDrafts.length,0)>5000 || Buffer.byteLength(JSON.stringify(results))>10*1024*1024)throw new Error('合并超过 1000 块 / 5000 规则 / 10 MiB 上限');
  if(new Set(results.map(r=>r.chunkId)).size!==results.length || new Set(results.map(r=>r.seq)).size!==results.length)throw new Error('合并块重复');
  const ordered=[...results].sort((a,b)=>a.seq-b.seq);
  const groups=new Map<string,RuleExtractionOutput['ruleDrafts'][number]>();
  const mapping=new Map<string,Map<string,string>>();
  for(const result of ordered){
    const keys=new Map<string,string>();mapping.set(result.chunkId,keys);
    for(const draft of RuleExtractionOutput.parse(result.output).ruleDrafts){
      if(keys.has(draft.key))throw new Error('块内规则 key 重复');
      // Including classification/businessFields/forbiddenBehaviors prevents numeric or quality loss.
      const {key,sources,conflictsWith,...semantics}=draft;
      const signature=canonicalStringify(semantics);
      let merged=groups.get(signature);
      if(!merged){merged={...draft,key:`rule-draft-${String(groups.size+1).padStart(2,'0')}`,sources:[],conflictsWith:[]};groups.set(signature,merged);}
      keys.set(key,merged.key);
      for(const source of sources){
        let target=merged.sources.find(s=>s.documentVersionId===source.documentVersionId);
        if(!target){target={documentVersionId:source.documentVersionId,sourceSpanIds:[]};merged.sources.push(target);}
        target.sourceSpanIds=[...new Set([...target.sourceSpanIds,...source.sourceSpanIds])].sort();
      }
    }
  }
  const ruleDrafts=[...groups.values()],byKey=new Map(ruleDrafts.map(d=>[d.key,d]));
  const clarifications:RuleExtractionOutput['clarifications']=[],unparsed=new Map<string,RuleExtractionOutput['unparsedRanges'][number]>();
  const seenClarifications=new Set<string>();
  for(const result of ordered){
    const keys=mapping.get(result.chunkId)!;
    const resolve=(key:string)=>{const mapped=keys.get(key);if(!mapped)throw new Error('合并引用不存在的块内规则');return mapped;};
    for(const draft of result.output.ruleDrafts){
      const merged=byKey.get(resolve(draft.key))!;
      for(const conflict of draft.conflictsWith){
        const other=byKey.get(resolve(conflict))!;
        if(other.key===merged.key)throw new Error('冲突规则不能去重成同一规则');
        if(!merged.conflictsWith.includes(other.key))merged.conflictsWith.push(other.key);
        if(!other.conflictsWith.includes(merged.key))other.conflictsWith.push(merged.key);
      }
    }
    for(const c of result.output.clarifications){
      const item={...c,ruleDraftKeys:[...new Set(c.ruleDraftKeys.map(resolve))].sort()};
      const signature=canonicalStringify(item);
      if(!seenClarifications.has(signature)){seenClarifications.add(signature);clarifications.push(item);}
    }
    for(const r of result.output.unparsedRanges)unparsed.set(canonicalStringify(r),r);
  }
  // Bounded cross-chunk conflict pass. Exact same scope and an explicitly forbidden
  // expectation are contradictory; similar wording or different numbers alone are not proof.
  const scopes=new Map<string,typeof ruleDrafts>();
  for(const draft of ruleDrafts){
    if(draft.classification!=='EXPLICIT')continue;
    const scope=canonicalStringify({role:draft.role??null,precondition:draft.precondition??null,condition:draft.condition??null,action:draft.action});
    const same=scopes.get(scope)??[];same.push(draft);scopes.set(scope,same);
  }
  const pairs=new Set<string>();let comparisons=0;
  for(const group of scopes.values()){
    const expected=new Map<string,typeof ruleDrafts>();
    for(const d of group){const same=expected.get(d.expectation)??[];same.push(d);expected.set(d.expectation,same);}
    for(const d of group)for(const forbidden of d.forbiddenBehaviors)for(const other of expected.get(forbidden)??[]){
      if(++comparisons>20000)throw new Error('跨块冲突候选超过 20000 上限，请分组审阅');
      if(d.key===other.key)continue;
      const keys=[d.key,other.key].sort(),key=keys.join(':');if(pairs.has(key))continue;pairs.add(key);
      if(!d.conflictsWith.includes(other.key))d.conflictsWith.push(other.key);
      if(!other.conflictsWith.includes(d.key))other.conflictsWith.push(d.key);
      if(!clarifications.some(c=>c.kind==='CONFLICT'&&keys.every(k=>c.ruleDraftKeys.includes(k))))clarifications.push({kind:'CONFLICT',ruleDraftKeys:keys,question:'相同角色、前置条件、条件和动作下，一条要求的结果被另一条明确禁止。请依据双方原文确认适用规则；合并器不会自行选择。'});
    }
  }
  for(const d of ruleDrafts){d.conflictsWith.sort();d.sources.sort((a,b)=>a.documentVersionId<b.documentVersionId?-1:1);}
  return RuleExtractionOutput.parse({ruleDrafts,clarifications,unparsedRanges:[...unparsed.values()]});
}
export function chunkCoverage(manifest:Array<{chunkId:string;seq:number}>,rows:Array<{chunkId:string;status:string}>){
  const state={complete:manifest.length>0,processed:[] as string[],pending:[] as string[],failed:[] as string[],inProgress:[] as string[],cancelled:[] as string[],missing:[] as string[],invalid:[] as string[]};
  const ids=new Set(manifest.map(c=>c.chunkId)),byId=new Map(rows.map(r=>[r.chunkId,r.status]));
  if(ids.size!==manifest.length || byId.size!==rows.length){state.complete=false;state.invalid.push('duplicate');}
  for(const r of rows)if(!ids.has(r.chunkId)){state.complete=false;state.invalid.push(r.chunkId);}
  const states={completed:'processed',pending:'pending',failed:'failed',in_progress:'inProgress',cancelled:'cancelled'} as const;
  for(const c of manifest){
    const s=byId.get(c.chunkId);
    if(s===undefined){state.missing.push(c.chunkId);state.complete=false;continue;}
    const field=states[s as keyof typeof states];
    if(field)state[field].push(c.chunkId);else state.invalid.push(c.chunkId);
    if(s!=='completed')state.complete=false;
  }
  return state;
}
