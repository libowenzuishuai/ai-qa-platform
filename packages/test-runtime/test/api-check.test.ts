import { beforeAll, afterAll, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { checkApi } from '../src/api-check.js';
let baseUrl:string;
const server=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({count:12,text:'order completed'}));});
beforeAll(async()=>{await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));baseUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}`;});
afterAll(async()=>{await new Promise<void>(r=>server.close(()=>r()));});
it.each([['gt',10,'body.count','PASS'],['lt',10,'body.count','FAIL'],['contains','completed','body.text','PASS']] as const)('API comparison preserves expected/actual ordering: %s',async(operator,expected,responseField,result)=>{
 const checked=await checkApi({template:{name:'read',method:'GET',path:'/',responseField},assertion:{id:'a',stepId:'s',required:true,ruleVersionId:'r',kind:'api.response',operator,expected},baseUrl,policy:{allowedOrigins:[baseUrl],dependencyOrigins:[]},resolveCredential:()=>undefined,timeoutMs:2000});
 expect(checked.result).toBe(result);
});
