import {expect,it} from 'vitest';
import {materializeChunk,validateChunkManifest,ParsedDocumentBundle} from '../src/index.js';
const text='订单😀'.repeat(400);
const bundle=ParsedDocumentBundle.parse({documentVersionId:'d1',format:'MARKDOWN',parseStatus:'PARSED',parserVersion:'1',blocks:[{id:'b1',kind:'paragraph',text}],spans:[{id:'s1',documentVersionId:'d1',locator:{kind:'markdown-line',startLine:1,endLine:1},quotedText:text,extractionQuality:'GOOD'}],coverageSummary:{totalBlocks:1,goodSpans:1,lowSpans:0,unparsedSpans:0}});
const manifest=()=>({documentVersionId:'d1',documentChecksum:'a'.repeat(64),strategyVersion:'chunk-v1',createdAt:'2026-09-22T00:00:00Z',strategyParams:{maxCharsPerChunk:600,contextOverlapChars:0,modelBudgetChars:40000},totalCodePoints:1200,chunks:[0,1].map(i=>({chunkId:`c-${i}`,seq:i,boundary:'fixed-size',text:Array.from(text).slice(i*600,(i+1)*600).join(''),contextOverlap:'',spanRefs:[{type:'slice',slice:{sourceSpanId:'s1',startOffset:i*600,endOffset:(i+1)*600,sliceId:`slice-${i}`}}],isTableContinuation:false,estimatedChars:600}))});
it('中文 emoji 切片实际发送局部正文，原 span 保持不变',()=>{
 const m=manifest(),parts=m.chunks.map(c=>materializeChunk(m,c.chunkId,bundle,'a'.repeat(64)));
 expect(parts.map(p=>p.blocks[0]!.text).join('')).toBe(text);
 for(const p of parts){expect(Array.from(p.spans[0]!.quotedText!).length).toBe(600);expect(p.spans[0]!.id).toBe('s1');}
 expect(bundle.blocks[0]!.text).toBe(text);
});
it.each(['tail','overlap','text','identity','duplicate'] as const)('拒绝失真分块清单：%s',kind=>{
 const m=manifest();
 if(kind==='tail'){m.chunks.pop();m.totalCodePoints=600;}
 if(kind==='overlap')m.chunks[1]!.spanRefs[0]!.slice.startOffset=500;
 if(kind==='text')m.chunks[0]!.text='伪造';
 if(kind==='identity')m.documentChecksum='b'.repeat(64);
 if(kind==='duplicate')m.chunks[1]!.chunkId='c-0';
 expect(()=>validateChunkManifest(m,bundle,'a'.repeat(64))).toThrow();
});
