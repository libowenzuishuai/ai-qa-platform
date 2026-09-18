import { afterAll, beforeAll, afterEach, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { callIntelligence } from '../src/intelligence-client.js';
import { RuleExtractionResponse } from '@ai-qa/contracts';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const vectors=JSON.parse(readFileSync(root+'packages/contracts/fixtures/intelligence-conformance.json','utf8'));
const rules=vectors.find((v:any)=>v.name==='01-explicit-prd');
const cases=vectors.find((v:any)=>v.name==='case-valid');
let child:ChildProcess;
let url:string;
const config=()=>({port:0,host:'127.0.0.1',databaseUrl:'unused',redisUrl:'unused',artifactDir:'unused',demoFixtureToken:'unused',logLevel:'warn',
  intelligenceUrl:url,intelligenceToken:'http-test-token',intelligenceTimeoutMs:2000});
beforeAll(async()=>{
 child=spawn(root+'services/intelligence/.venv/bin/python',['-m','uvicorn','http_fixture:app','--host','127.0.0.1','--port','0'],{
  cwd:root,env:{...process.env,PYTHONPATH:root+'services/intelligence/src:'+root+'services/intelligence/tests'},stdio:['ignore','pipe','pipe'],
 });
 await new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Python service startup timed out')),10000);
  const consume=(data:Buffer)=>{const match=data.toString().match(/Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/);if(match){url=match[1]!;clearTimeout(timer);resolve();}};
  child.stderr!.on('data',consume);child.stdout!.on('data',consume);
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('exit',code=>{clearTimeout(timer);reject(new Error('Python exited '+code));});
 });
},15000);
afterEach(()=>vi.restoreAllMocks());
afterAll(async()=>{
 if(child && child.exitCode===null){const exit=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await exit;}
});
it('实际 TypeScript → Python HTTP：规则和用例协议往返',async()=>{
 const r=await callIntelligence(config(),'rules','http-rules','mock',rules.input);
 expect(RuleExtractionResponse.parse(r).output).toEqual(rules.output);
 const c=await callIntelligence(config(),'cases','http-cases','mock',cases.input);
 expect(c.output).toEqual(cases.output);
});
it('Python 拒绝未经登记的 mock 输入，TS 不回退参考管线',async()=>{
 await expect(callIntelligence(config(),'rules','miss','mock',{...rules.input,promptVersion:'unregistered'})).rejects.toMatchObject({code:'MODEL_OUTPUT_INVALID'});
});
it('未配置服务与错误令牌均明确失败',async()=>{
 await expect(callIntelligence({...config(),intelligenceToken:undefined},'rules','missing','mock',rules.input)).rejects.toMatchObject({code:'DEPENDENCY_UNAVAILABLE'});
 await expect(callIntelligence({...config(),intelligenceToken:'wrong'},'rules','auth','mock',rules.input)).rejects.toMatchObject({code:'DEPENDENCY_UNAVAILABLE'});
});
it('响应错请求编号、错模式、伪造结构均不接收',async()=>{
 const base={schemaVersion:'1.0',requestId:'r','mode':'mock',output:rules.output,invocations:[]};
 for(const body of [{...base,requestId:'other'},{...base,mode:'real'},{...base,output:{}}]){
  vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify(body),{status:200}));
  await expect(callIntelligence(config(),'rules','r','mock',rules.input)).rejects.toMatchObject({code:'MODEL_OUTPUT_INVALID'});
  vi.restoreAllMocks();
 }
});
it('超时为 MODEL_TIMEOUT，不静默改用 TypeScript 或 mock',async()=>{
 vi.spyOn(globalThis,'fetch').mockRejectedValue(Object.assign(new Error('timeout'),{name:'TimeoutError'}));
 await expect(callIntelligence(config(),'rules','r','mock',rules.input)).rejects.toMatchObject({code:'MODEL_TIMEOUT'});
});
