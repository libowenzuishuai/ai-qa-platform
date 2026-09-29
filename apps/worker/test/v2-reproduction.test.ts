import {it,expect} from 'vitest';
import {createServer} from 'node:http';
import {ReproductionAdapter} from '@ai-qa/adapter-sdk/samples/reproduction';
import {validateCapabilityOutput} from '@ai-qa/adapter-sdk';
it('real isolated fixture: reset → subset execution → cleanup, same oracle/build, bounded 1-minimal failure',async()=>{
 const active=new Set<string>(),calls:string[]=[];let corrupt=false,cleanupFails=false;
 const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const x=JSON.parse(raw),action=req.url!.split('/').at(-1);calls.push(action!);let reply={namespace:x.namespace,buildId:corrupt?'wrong':x.buildId,oracleHash:x.oracleHash} as Record<string,unknown>;
 if(action==='reset'){active.add(x.namespace);reply.clean=true;}
 if(action==='trial'){expect(active.has(x.namespace)).toBe(true);reply={...reply,verdict:x.steps.includes('setup')&&x.steps.includes('save')?'fail':'pass',failureKey:'persist',evidence:['isolated-result']};}
 if(action==='cleanup'){if(!cleanupFails)active.delete(x.namespace);reply.clean=!cleanupFails;}
 res.setHeader('content-type','application/json');res.end(JSON.stringify(reply));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const baseUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const adapter=new ReproductionAdapter(),effects:unknown[]=[],ctx={allowedOrigins:[baseUrl],deadline:Date.now()+20000,signal:new AbortController().signal,idempotencyKey:'session:repro',resolveSecret:async()=>'',beforeEffect:async(e:unknown)=>{effects.push(e);}};
 const input={baseUrl,buildId:'fixed-input-build',oracleHash:'a'.repeat(64),failureKey:'persist',steps:['noise','setup','save','noop'],maxTrials:30};
 try{
  const result=await adapter.execute(input,ctx);expect(result.status).toBe('SUCCEEDED');expect(result.output).toMatchObject({candidate:['setup','save'],minimal:true,verified:true});expect(validateCapabilityOutput(adapter.manifest,result.output).ok).toBe(true);expect(active.size).toBe(0);expect(effects.length).toBe(calls.length);
  const before=calls.length;const denied=await adapter.execute(input,{...ctx,beforeEffect:async()=>{throw Error('BUDGET_EXCEEDED');}});expect(denied.status).not.toBe('SUCCEEDED');expect(calls.length).toBe(before);
  const oversized=await adapter.execute({...input,steps:Array.from({length:101},(_,i)=>String(i))},ctx);expect(oversized.status).toBe('FAILED');expect(calls.length).toBe(before);
  cleanupFails=true;const failure=await adapter.execute(input,{...ctx,idempotencyKey:'other:repro'});expect(failure.status).toBe('UNKNOWN');expect(failure.resourceKeys).toHaveLength(1);expect(failure.error?.code).toBe('CLEANUP_REQUIRED');
  cleanupFails=false;corrupt=true;const mismatch=await adapter.execute(input,{...ctx,idempotencyKey:'third:repro'});expect(mismatch.status).not.toBe('SUCCEEDED');
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
