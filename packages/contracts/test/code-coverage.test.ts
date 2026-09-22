import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parseLcov,CodeCoverageResult} from '../src/code-coverage.js';
const vectors=JSON.parse(readFileSync(new URL('../fixtures/lcov-v1.json',import.meta.url),'utf8'));
for(const v of vectors)it('LCOV shared: '+v.name,()=>{if(v.valid){const x=parseLcov(v.raw);expect(CodeCoverageResult.safeParse({...x,format:'LCOV',raw:v.raw,sha256:createHash('sha256').update(v.raw).digest('hex')}).success).toBe(true);}else expect(()=>parseLcov(v.raw)).toThrow();});
it('checksum and supplied coverage totals cannot override raw report',()=>{const raw=vectors[0].raw,x=parseLcov(raw),base={...x,format:'LCOV',raw,sha256:createHash('sha256').update(raw).digest('hex')};expect(CodeCoverageResult.safeParse({...base,linesHit:2}).success).toBe(false);expect(CodeCoverageResult.safeParse({...base,sha256:'a'.repeat(64)}).success).toBe(false);});
