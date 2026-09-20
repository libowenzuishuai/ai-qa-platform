import { describe,it,expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '@ai-qa/artifact-store';
import { classifyRepositoryPath,discoverRepository } from '../src/repository.js';
describe('仓库只读发现',()=>{
  it('跳过凭据与执行线索，业务候选与运行说明分开',()=>{
    for(const p of ['.env','.env.example','sub/.env.production','secrets.md','id_rsa','key.pem','node_modules/a/README.md'])expect(classifyRepositoryPath(p)).toBeUndefined();
    expect(classifyRepositoryPath('docs/PRD.md')).toBe('BUSINESS_CANDIDATE');expect(classifyRepositoryPath('README.md')).toBe('RUNTIME_CLUE');expect(classifyRepositoryPath('openapi.yaml')).toBe('API_CONTRACT');
  });
  it('固定 commit 与 blob hash；软链接不读取，响应内容损坏拒绝',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'repo-discovery-'));const data=Buffer.from('# PRD\n订阅升级后为 Pro');const sha=createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');const calls:string[]=[];
    const mock:typeof fetch=async input=>{const url=String(input);calls.push(url);return Response.json(url.includes('/commits/')?{sha:'a'.repeat(40),commit:{tree:{sha:'b'.repeat(40)}}}:url.includes('/trees/')?{tree:[{path:'docs/PRD.md',sha,size:data.length,type:'blob',mode:'100644'},{path:'link.md',sha,size:data.length,type:'blob',mode:'120000'}]}:{encoding:'base64',content:data.toString('base64')});};
    try{const result=await discoverRepository({url:'https://github.com/org/project'},new ArtifactStore(dir),'test',mock);expect(result.files).toHaveLength(1);expect(result.commitSha).toBe('a'.repeat(40));expect(result.files[0]?.blobHash).toBe(sha);expect(calls.filter(x=>x.includes('/blobs/'))).toHaveLength(1);expect(result.skipped).toEqual([{path:'link.md',reason:expect.any(String)}]);
      const bad:typeof fetch=async(input,init)=>String(input).includes('/blobs/')?Response.json({encoding:'base64',content:Buffer.from('x').toString('base64')}):mock(input,init);
      await expect(discoverRepository({url:'https://github.com/org/project'},new ArtifactStore(dir),'bad',bad)).rejects.toThrow('校验');
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
});

it('通用凭据不能隐式使用 demo 账号，未知凭据字段拒绝',async()=>{
  const {makeCredentialResolver}=await import('../src/credentials.js');
  process.env.DEMO_VISITOR_USERNAME='demo-account';
  try{expect(makeCredentialResolver({})('visitor.username')).toBeUndefined();expect(makeCredentialResolver({},true)('visitor.username')).toBe('demo-account');expect(makeCredentialResolver({},true)('visitor.token')).toBeUndefined();}finally{delete process.env.DEMO_VISITOR_USERNAME;}
});
