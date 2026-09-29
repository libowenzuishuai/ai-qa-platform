import {it,expect,beforeAll,afterAll} from 'vitest';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {BrowserHarness,type BrowserEvent} from '@ai-qa/adapter-sdk/browser-harness';
import {type BrowserAgentInput,type BrowserAgentOutput} from '@ai-qa/contracts';
import {chromium} from 'playwright';
import {prepareBrowserRole} from '../src/v2/browser-preparation.js';
let server:ReturnType<typeof createServer>,url:string,posts=0;
const dir=mkdtempSync(join(tmpdir(),'aiqa-extensions-'));
beforeAll(async()=>{server=createServer(async(req,res)=>{
 if(req.url==='/download'){res.setHeader('content-disposition','attachment; filename="report.txt"');res.end('fixture-report');return;}
 if(req.url==='/save'){posts++;res.end('saved');return;}
 res.setHeader('content-type','text/html');res.end(`<label>Name<input></label><button onclick="fetch('/save',{method:'POST'}).then(()=>document.getElementById('result').textContent='saved')">Save</button><p data-testid="result" id="result">initial</p><label>File<input type="file" onchange="document.getElementById('result').textContent=this.files[0].name"></label><a href="/download">Export</a><label>Enable<input type="checkbox"></label><div id="otp">MFA required</div><button onclick="document.getElementById('otp').remove();document.getElementById('result').textContent='authenticated'">Complete MFA</button>`);
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;});
afterAll(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});});
const decision=(input:BrowserAgentInput):BrowserAgentOutput=>{const op=input.operations[0]!;return {observationId:input.observationId,actionId:op.id,elementRef:input.elements.find(e=>e.name===op.target)?.ref??null,point:null,status:'act',rationale:'explicit fixture'};};
function h(over:Record<string,unknown>={}){return new BrowserHarness({artifactDir:dir,allowedOrigins:[url],deadline:Date.now()+20000,signal:new AbortController().signal,event:async()=>{},plan:async input=>decision(input),...over});}
it('explores current controls with approved data; final business result remains an independent read',async()=>{
 const before=posts;const browser=h({plan:async(input:BrowserAgentInput)=>{const step=input.history?.length??0;return {observationId:input.observationId,actionId:null,elementRef:step===0?input.elements.find(e=>e.name==='Name')!.ref:step===1?input.elements.find(e=>e.name==='Save')!.ref:null,status:step===2?'done':'act',rationale:'fixture explorer',...(step<2?{proposed:{role:'user',kind:step===0?'fill':'click',...(step===0?{valueRef:'sample'}:{})}}:{})};}});
 try{const result=await browser.run({goal:'save',strategy:'model-v1',roles:[{id:'user',startUrl:url,writes:[{method:'POST',pathname:'/save'}]}],operations:[],exploration:{roles:['user'],kinds:['fill','click'],values:[{id:'sample',value:'approved'}]}});expect(result.status).toBe('completed');expect(posts-before).toBe(1);expect((await browser.read('user','result')).text).toBe('saved');}finally{await browser.close();}
});
it('repeated exploration stops on unchanged page state',async()=>{
 const browser=h({plan:async(input:BrowserAgentInput)=>({observationId:input.observationId,actionId:null,elementRef:input.elements.find(e=>e.name==='Save')!.ref,status:'act',rationale:'fixture repeat',proposed:{role:'user',kind:'click'}})});
 try{await expect(browser.run({goal:'repeat',strategy:'model-v1',roles:[{id:'user',startUrl:url,writes:[{method:'POST',pathname:'/save'}]}],operations:[],exploration:{roles:['user'],kinds:['click'],values:[]}})).rejects.toMatchObject({code:'EXPLORATION_STALLED'});}finally{await browser.close();}
});
it('uploads owned artifact; download evidence has real hash and cannot cross roles',async()=>{
 const events:BrowserEvent[]=[],browser=h({event:async(e:BrowserEvent)=>events.push(e),upload:async(id:string)=>{expect(id).toBe('owned-file');return {name:'fixture.txt',mimeType:'text/plain',buffer:Buffer.from('fixture-upload')};}});
 try{expect((await browser.run({goal:'files',roles:[{id:'user',startUrl:url}],operations:[{id:'upload',role:'user',kind:'upload',target:'File',value:'owned-file'},{id:'download',role:'user',kind:'download',target:'Export',after:['upload'],download:{filename:'report.txt',maxBytes:100}}]})).status).toBe('completed');expect((await browser.read('user','result')).text).toBe('fixture.txt');expect((await browser.read('user','download','download')).text).toBe(createHash('sha256').update('fixture-report').digest('hex'));expect((await browser.read('other','download','download')).visible).toBe(false);expect(events.some(e=>e.kind==='download'&&e.fileSha256)).toBe(true);}finally{await browser.close();}
});
it.each([{filename:'wrong.txt',maxBytes:100},{filename:'report.txt',maxBytes:2}])('download rejects name/size mismatch %j',async download=>{const browser=h();try{await expect(browser.run({goal:'export',roles:[{id:'user',startUrl:url}],operations:[{id:'download',role:'user',kind:'download',target:'Export',download}]})).rejects.toMatchObject({code:'UNKNOWN_WRITE'});}finally{await browser.close();}});
it('human auth continues same browser after actual success check',async()=>{
 const browser=await chromium.launch(),page=await browser.newPage();let handoffs=0;
 try{await prepareBrowserRole(page,{environmentId:'env',role:'user',credentialRef:'account',loginPath:'/',steps:[{type:'click',locator:{type:'text',value:'Complete MFA'}}],interactiveIndicator:{type:'text',value:'MFA required'},successIndicator:{locator:{type:'testId',value:'result'},expectedText:'authenticated'}},{},url,[url],Date.now()+15000,async()=>{},async()=>{handoffs++;await page.getByText('Complete MFA',{exact:true}).click();});expect(handoffs).toBe(1);}finally{await browser.close();}
});
it('unapproved exploration data cannot dispatch',async()=>{const browser=h({plan:async(input:BrowserAgentInput)=>({observationId:input.observationId,actionId:null,elementRef:input.elements.find(e=>e.name==='Name')!.ref,status:'act',rationale:'fixture invalid',proposed:{role:'user',kind:'fill',valueRef:'secret'}})});try{await expect(browser.run({goal:'fill',strategy:'model-v1',roles:[{id:'user',startUrl:url}],operations:[],exploration:{roles:['user'],kinds:['fill'],values:[]}})).rejects.toMatchObject({code:'FORBIDDEN'});}finally{await browser.close();}});
