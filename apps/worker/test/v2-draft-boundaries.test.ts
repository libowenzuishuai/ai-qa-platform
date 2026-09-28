import {it,expect} from 'vitest';
import {createServer,type Server} from 'node:http';
import {DraftOpsAdapter} from '@ai-qa/adapter-sdk/samples/draft-ops';
async function listen(server:Server){await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${(server.address() as {port:number}).port}`;}
const close=(server:Server)=>new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();});
function context(origin:string){return {allowedOrigins:[origin],signal:new AbortController().signal,deadline:Date.now()+3000,idempotencyKey:'test-origin-boundary',resolveSecret:async()=>{throw Error('no secrets');}};}
it('观察中的绝对或协议相对操作地址不能向第二接收站外发',async()=>{
 let hits=0;const receiver=createServer((_q,r)=>{hits++;r.end('{}');});const target=createServer((_q,r)=>r.end('{}'));
 const outside=await listen(receiver),base=await listen(target);
 try{for(const renamePath of [outside+'/capture','//'+new URL(outside).host+'/capture']){
  const result=await new DraftOpsAdapter().execute({baseUrl:base,op:'rename',draftId:'d-1',title:'private title',renamePath},context(base));
  expect(result.status).toBe('FAILED');
 }expect(hits).toBe(0);}finally{await close(receiver);await close(target);}
});
it('HTTP 500 不记成功；已发出的写断连保留 UNKNOWN',async()=>{
 const target=createServer((req,res)=>{if(req.url?.endsWith('/rename'))req.socket.destroy();else{res.writeHead(500,{'content-type':'application/json'});res.end('{}');}});
 const base=await listen(target);try{
  const adapter=new DraftOpsAdapter();
  expect((await adapter.execute({baseUrl:base,op:'create',title:'x'},context(base))).status).toBe('FAILED');
  expect((await adapter.execute({baseUrl:base,op:'rename',draftId:'1',title:'x',renamePath:'/api/drafts/:id/rename'},context(base))).status).toBe('UNKNOWN');
 }finally{await close(target);}
});
it('真实浏览器观察：302/子资源不越界，页面脚本不能发送修改请求',async()=>{
 const {WebObserveAdapter}=await import('@ai-qa/adapter-sdk/samples/web-observe');
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'v2-observe-boundary-'));
 let outsideHits=0,mutations=0;
 const receiver=createServer((_q,r)=>{outsideHits++;r.end('outside');});const outside=await listen(receiver);
 const target=createServer((q,r)=>{
  if(q.method==='POST'){mutations++;r.end('written');return;}
  if(q.url==='/redirect'){r.writeHead(302,{location:outside+'/capture'});r.end();return;}
  r.writeHead(200,{'content-type':'text/html'});r.end(`<h1 data-testid="draft-title">hello</h1><img src="${outside}/image"><script>fetch('/mutate',{method:'POST',body:'private'})</script>`);
 });const base=await listen(target);
 try{for(const path of ['/redirect','/page']){
  const r=await new WebObserveAdapter().execute({baseUrl:base,path},{...context(base),artifactDir:dir,deadline:Date.now()+10000});
  expect(r.status).toBe('FAILED');
 }expect(outsideHits).toBe(0);expect(mutations).toBe(0);}finally{await close(target);await close(receiver);rmSync(dir,{recursive:true,force:true});}
},30000);
