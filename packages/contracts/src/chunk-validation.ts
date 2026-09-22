import { ChunkManifest } from './chunking.js';
import { ParsedDocumentBundle } from './document.js';
import { canonicalStringify } from './acceptance-hash.js';

/** Verify source coverage independently of the Python producer before any model call. */
export function validateChunkManifest(raw: unknown, bundle: ParsedDocumentBundle, checksum: string) {
  const m=ChunkManifest.parse(raw), fail=(s:string):never=>{throw new Error(`分块清单无效：${s}`);};
  if(m.documentVersionId!==bundle.documentVersionId || m.documentChecksum!==checksum)fail('文档身份或字节校验和不符');
  if(bundle.blocks.length!==bundle.spans.length || new Set(bundle.spans.map(s=>s.id)).size!==bundle.spans.length)fail('片段映射不唯一');
  const sources=new Map(bundle.spans.map((s,i)=>[s.id,{span:s,block:bundle.blocks[i]!}]));
  for(const {span,block} of sources.values())if(span.quotedText!==null&&span.quotedText!==block.text)fail('不支持不一一对应的片段映射');
  const ranges=new Map<string,Array<[number,number]>>(),fragments=new Set<string>();
  if(new Set(m.chunks.map(c=>c.chunkId)).size!==m.chunks.length)fail('块 ID 重复');
  let total=0;
  for(const [i,c] of m.chunks.entries()){
    if(c.seq!==i || !c.spanRefs.length)fail('块序号或引用为空');
    const texts:string[]=[];
    for(const ref of c.spanRefs){
      const id=ref.type==='span'?ref.spanId:ref.slice.sourceSpanId;
      const source=sources.get(id);if(!source)fail('未知来源');
      const points=Array.from(source!.block.text);
      const start=ref.type==='span'?0:ref.slice.startOffset,end=ref.type==='span'?points.length:ref.slice.endOffset;
      const fragment=ref.type==='span'?id:ref.slice.sliceId;
      if(fragments.has(fragment)||start<0||end<start||end>points.length||(start===end&&points.length>0))fail('切片重复或越界');
      fragments.add(fragment);
      ranges.set(id,[...(ranges.get(id)??[]),[start,end]]);
      texts.push(points.slice(start,end).join(''));
    }
    const text=texts.filter(Boolean).join('\n');
    if(c.text!==text || c.estimatedChars!==Array.from(text).length)fail('正文与引用不符');
    if(c.estimatedChars>m.strategyParams.maxCharsPerChunk)fail('正文超过块预算');
    const context=i===0?'':Array.from(m.chunks[i-1]!.text).slice(-m.strategyParams.contextOverlapChars).join('');
    if(c.contextOverlap!==(m.strategyParams.contextOverlapChars?context:''))fail('上下文不属于相邻块');
    if(c.estimatedChars+Array.from(c.contextOverlap).length+20000>m.strategyParams.modelBudgetChars)fail('请求超过预算');
    total+=c.estimatedChars;
  }
  for(const [id,{block}] of sources){
    const assigned=ranges.get(id);if(!assigned)fail('遗漏来源');
    let cursor=0;
    for(const [start,end] of assigned!.sort((a,b)=>a[0]-b[0])){if(start!==cursor)fail('切片存在空洞或重叠');cursor=end;}
    if(cursor!==Array.from(block.text).length)fail('遗漏正文尾部');
  }
  if(total!==m.totalCodePoints)fail('总字符数不一致');
  return m;
}
export function chunkManifestPayload(raw: unknown){
  const {createdAt,...m}=ChunkManifest.parse(raw);return m;
}
/** Slice only at verified code-point offsets. IDs still refer to the immutable original spans. */
export function materializeChunk(raw:unknown,chunkId:string,whole:ParsedDocumentBundle,checksum:string){
  const m=validateChunkManifest(raw,whole,checksum),c=m.chunks.find(c=>c.chunkId===chunkId);
  if(!c)throw new Error('块不在清单中');
  const spans:ParsedDocumentBundle['spans']=[],blocks:ParsedDocumentBundle['blocks']=[];
  for(const ref of c.spanRefs){
    const id=ref.type==='span'?ref.spanId:ref.slice.sourceSpanId,index=whole.spans.findIndex(s=>s.id===id);
    const original=whole.spans[index]!, block=whole.blocks[index]!;
    const text=ref.type==='span'?block.text:Array.from(block.text).slice(ref.slice.startOffset,ref.slice.endOffset).join('');
    spans.push({...original,quotedText:original.quotedText===null?null:text});blocks.push({...block,text});
  }
  if(new Set(spans.map(s=>s.id)).size!==spans.length)throw new Error('同块不得重复引用同一 span');
  // Preserve proven table headers by locator; never assume two adjacent table blocks share columns.
  const tableContext:string[]=[];
  for(const [i,block] of blocks.entries())if(block.kind==='table'){
    const loc=spans[i]!.locator;
    let headers:typeof whole.spans=[];
    if(loc.kind==='docx-cell')headers=whole.spans.filter(s=>s.locator.kind==='docx-cell'&&s.locator.tableIndex===loc.tableIndex&&s.locator.row===0);
    const text=headers.map(h=>JSON.stringify({sourceSpanId:h.id,locator:h.locator,text:h.quotedText})).join('\n');
    if(headers.length && headers.every(h=>h.extractionQuality==='GOOD'&&h.quotedText!==null) && Array.from(text).length<=5000){tableContext.push('表格首行上下文（仍需判断是否表头）：'+text);}
    else if(c.isTableContinuation || c.spanRefs.some(r=>r.type==='slice'&&r.slice.startOffset>0)){
      if(spans[i]!.extractionQuality==='GOOD')spans[i]={...spans[i]!,extractionQuality:'LOW'};
      tableContext.push('TABLE_DEGRADED：无法确认本片段的完整表头和列关系；该片段不能支持 EXPLICIT，必须列核对澄清。');
    }
  }
  return ParsedDocumentBundle.parse({...whole,blocks,spans,warnings:[
    ...tableContext,
    `块范围提取（chunk ${c.seq} / ${m.chunks.length}）`,
    `仅处理本块正文；以下重叠上下文不是新需求、不能新增来源引用：${c.contextOverlap}`,
    ...(c.isTableContinuation?['表格延续：未确认表头对应时必须列 TABLE_DEGRADED，禁止猜测列含义。']:[]),
  ],coverageSummary:{totalBlocks:blocks.length,goodSpans:spans.filter(s=>s.extractionQuality==='GOOD').length,lowSpans:spans.filter(s=>s.extractionQuality==='LOW').length,unparsedSpans:spans.filter(s=>s.extractionQuality==='UNPARSED').length}});
}
