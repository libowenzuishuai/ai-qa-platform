import {z} from 'zod';
import {createHash} from 'node:crypto';
export function parseLcov(raw:string){
 if(Buffer.byteLength(raw,'utf8')>262144||raw.includes('\0'))throw new Error('LCOV report exceeds supported limit');
 const files:Array<{path:string;linesFound:number;linesHit:number}>=[];const paths=new Set<string>();let current:{path:string;lines:Map<number,number>;found?:number;hit?:number}|undefined;
 const integer=(value:string)=>{if(!/^\d+$/.test(value)||Number(value)>1000000000)throw new Error('Invalid LCOV count');return Number(value);};
 for(const line of raw.split(/\r?\n/)){
  if(!line||line.startsWith('TN:'))continue;
  if(line.startsWith('SF:')){if(current)throw new Error('Unterminated LCOV record');const path=line.slice(3).replace(/^\/work\//,'');if(!path||path.length>500||path.startsWith('/')||path.includes('\\')||path.split('/').includes('..')||paths.has(path))throw new Error('Invalid or duplicate LCOV source');paths.add(path);current={path,lines:new Map()};continue;}
  if(line==='end_of_record'){
   if(!current)throw new Error('LCOV source missing');const found=current.lines.size,hit=[...current.lines.values()].filter(v=>v>0).length;
   if(current.found===undefined||current.hit===undefined||found!==current.found||hit!==current.hit)throw new Error('LCOV totals contradict line records');files.push({path:current.path,linesFound:found,linesHit:hit});if(files.length>2000)throw new Error('Too many LCOV files');current=undefined;continue;
  }
  if(!current)throw new Error('LCOV record outside source');
  if(line.startsWith('DA:')){const values=line.slice(3).split(',');if(values.length<2||values.length>3)throw new Error('Invalid LCOV line');const n=integer(values[0]!),hits=integer(values[1]!);if(n<1||current.lines.has(n))throw new Error('Invalid or duplicate LCOV line');current.lines.set(n,hits);}
  else if(line.startsWith('LF:')){if(current.found!==undefined)throw new Error('Duplicate LF');current.found=integer(line.slice(3));}
  else if(line.startsWith('LH:')){if(current.hit!==undefined)throw new Error('Duplicate LH');current.hit=integer(line.slice(3));}
  else if(!/^(FN|FNDA|FNF|FNH|BRDA|BRF|BRH|VER):/.test(line))throw new Error('Unsupported LCOV field');
 }
 if(current||!files.length)throw new Error('Incomplete LCOV report');
 return {files,linesFound:files.reduce((n,f)=>n+f.linesFound,0),linesHit:files.reduce((n,f)=>n+f.linesHit,0)};
}
export const CodeCoverageRequest=z.object({format:z.literal('LCOV'),path:z.string().max(300).regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/).refine(s=>!s.split('/').includes('..')).default('coverage/lcov.info')}).strict();
export const CodeCoverageResult=z.object({format:z.literal('LCOV'),sha256:z.string().regex(/^[a-f0-9]{64}$/),raw:z.string().max(262144),linesFound:z.number().int().nonnegative(),linesHit:z.number().int().nonnegative(),files:z.array(z.object({path:z.string().max(500),linesFound:z.number().int().nonnegative(),linesHit:z.number().int().nonnegative()}).strict()).max(2000)}).strict().superRefine((v,ctx)=>{
 try{const actual=parseLcov(v.raw);if(createHash('sha256').update(v.raw).digest('hex')!==v.sha256||JSON.stringify(actual.files)!==JSON.stringify(v.files)||actual.linesFound!==v.linesFound||actual.linesHit!==v.linesHit)throw new Error('Coverage checksum or summary mismatch');}catch(error){ctx.addIssue({code:'custom',message:(error as Error).message});}
});
