import {chromium} from 'playwright';
import {registerFindingPages} from '../../web/src/v2-findings.js';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import { beforeAll, afterAll, it, expect } from "vitest";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import { createTestEnv, type TestEnv } from "./helpers/db.js";
import { registerV2FindingRoutes } from "../src/routes-v2-findings.js";
import { registerAuth } from "../src/auth.js";
import { sendApiError } from "../src/errors.js";

/** W07 INT-01～03：候选证据门、去重、降级保护、假设分栏。 */

let env: TestEnv, app: ReturnType<typeof Fastify>;
let projectId = "";
let evidenceId="";
const H = {} as Record<string, string>;

const createBody = (over: Record<string, unknown> = {}) => ({
  status: "candidate",
  expected: "刷新后名称保留", actual: "刷新后名称丢失",
  firstFailure: { sessionId: null, attemptId: null, runId: null, evidenceIds: [], observedAt: "2026-09-24T00:00:00Z" },
  hypotheses: [], minimalReproduction: null, severity: null,
  dedupeKey: `dedupe-${randomUUID().slice(0, 8)}`, buildId: "b1", role: "applicant",
  ...over,
});

beforeAll(async () => {
  env = await createTestEnv("v2find");
  const user = await env.prisma.user.create({
    data: { username: randomUUID(), displayName: "lead", passwordHash: "x", platformRole: "LEAD" },
  });
  const project = await env.prisma.project.create({
    data: { name: "Finding 项目", memberships: { create: { userId: user.id, role: "ADMIN" } } },
  });
  projectId = project.id;
  app = Fastify();
  await app.register(cookie);
  registerAuth(app, env.prisma, 600);
  app.addHook("onRequest", async (req) => {
    req.auth = { userId: user.id, username: user.username, displayName: user.displayName, platformRole: "LEAD" };
  });
  app.setErrorHandler((e, q, r) => sendApiError(q, r, e));
  registerV2FindingRoutes(app, env.prisma,env.artifactDir);
  const stored=env.store.put({runId:"fixture",attemptId:"a",filename:"proof.json",data:Buffer.from('{"actual":"failed"}')});
  evidenceId=(await env.prisma.artifact.create({data:{projectId,storageKey:stored.storageKey,checksum:stored.checksum,type:"OBSERVATION",sensitivity:"NORMAL"}})).id;
}, 30000);

afterAll(async () => { await app?.close(); await env?.cleanup(); });

const create = (over?: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/api/v2/projects/${projectId}/findings`, headers: H, payload: createBody(over) as never });
const setStatus = (id: string, status: string) =>
  app.inject({ method: "POST", url: `/api/v2/findings/${id}/status`, headers: H, payload: { status,...(status==="rejected"?{reason:"人工复核后驳回"}:{}) } as never });

it("无证据候选允许；伪造引用拒绝；真实证据仅允许人工确认，不能声明已复现", async () => {
  const created = await create();
  expect(created.statusCode).toBe(202);
  const id = created.json().findingId;
  expect((await setStatus(id, "reproduced")).statusCode).toBe(409);
  // 用带证据的新 Finding 验证通过路径。
  const fake = await create({firstFailure:{sessionId:null,attemptId:null,runId:null,evidenceIds:["fake"],observedAt:"2026-09-24T00:00:00Z"}});
  expect(fake.statusCode).toBe(409);
  expect((await create({status:"human_confirmed"})).statusCode).toBe(409);
  const withEvidence = await create({
    dedupeKey: `dedupe-${randomUUID().slice(0, 8)}`,
    firstFailure: { sessionId: null, attemptId: null, runId: null, evidenceIds: [evidenceId], observedAt: "2026-09-24T00:00:00Z" },
  });
  const findingId = withEvidence.json().findingId;
  expect((await setStatus(findingId, "reproduced")).statusCode).toBe(409);
  expect((await setStatus(findingId,"human_confirmed")).statusCode).toBe(200);
  // fix_verified 还需要已验证复现。
  expect((await setStatus(findingId, "fix_verified")).statusCode).toBe(409);
});

it("同 dedupeKey 去重返回既有", async () => {
  const key = `dedupe-${randomUUID().slice(0, 8)}`;
  const first = await create({ dedupeKey: key });
  const second = await create({ dedupeKey: key });
  expect(second.json().existed).toBe(true);
  expect(second.json().findingId).toBe(first.json().findingId);
});

it("human_confirmed 不能降级回 candidate；rejected 可达", async () => {
  const created = await create({
    dedupeKey: `dedupe-${randomUUID().slice(0, 8)}`,
    firstFailure: { sessionId: null, attemptId: null, runId: null, evidenceIds: [evidenceId], observedAt: "2026-09-24T00:00:00Z" },
  });
  const id = created.json().findingId;
  await setStatus(id, "human_confirmed");
  expect((await setStatus(id, "candidate")).statusCode).toBe(409);
  expect((await setStatus(id, "rejected")).json().status).toBe("rejected");
});

it("假设追加：支持/反对分栏落库", async () => {
  const created = await create();
  const id = created.json().findingId;
  const res = await app.inject({
    method: "POST", url: `/api/v2/findings/${id}/hypotheses`, headers: H,
    payload: {
      text: "改名接口未写持久层",
      supportingEvidence: [{ kind: "network", ref: evidenceId }],
      contradictingEvidence: [{ kind: "observation", ref: evidenceId }],
    } as never,
  });
  expect(res.statusCode).toBe(200);
  const hypotheses = res.json().hypotheses as Array<{ text: string; supportingEvidence: unknown[]; contradictingEvidence: unknown[]; status: string }>;
  expect(hypotheses).toHaveLength(1);
  expect(hypotheses[0]!.supportingEvidence).toHaveLength(1);
  expect(hypotheses[0]!.contradictingEvidence).toHaveLength(1);
});

it("rejection requires reason and expired evidence does not confirm a defect",async()=>{
 const f=(await create({firstFailure:{sessionId:null,attemptId:null,runId:null,evidenceIds:[evidenceId],observedAt:new Date().toISOString()}})).json().findingId;
 expect((await app.inject({method:'POST',url:`/api/v2/findings/${f}/status`,payload:{status:'rejected'}})).statusCode).toBe(422);
 await env.prisma.artifact.update({where:{id:evidenceId},data:{expiresAt:new Date(0)}});
 try{expect((await setStatus(f,'human_confirmed')).statusCode).toBe(409);expect((await app.inject({url:`/api/v2/findings/${f}`})).json().evidenceComplete).toBe(false);}finally{await env.prisma.artifact.update({where:{id:evidenceId},data:{expiresAt:null}});}
});
it('real browser investigation preserves facts and records a reviewed rejection',async()=>{
 const f=(await create({firstFailure:{sessionId:null,attemptId:null,runId:null,evidenceIds:[evidenceId],observedAt:new Date().toISOString()}})).json().findingId;
 const previous=process.env.API_BASE_URL;process.env.API_BASE_URL=await app.listen({host:'127.0.0.1',port:0});const web=Fastify();await web.register(cookie);await web.register(import('@fastify/formbody'));registerFindingPages(web);const url=await web.listen({host:'127.0.0.1',port:0});
 const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}});
 try{await page.context().addCookies([{name:'web_sid',value:'fixture',url}]);await page.goto(`${url}/v2/findings/${f}`);expect(await page.getByText('刷新后名称保留',{exact:true}).count()).toBe(1);
 const directory=fileURLToPath(new URL('../../../docs/evidence/v2-ui/',import.meta.url));mkdirSync(directory,{recursive:true});await page.screenshot({path:join(directory,'desktop-finding.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:join(directory,'mobile-finding.png'),fullPage:true});
 await page.getByLabel('评审结论').selectOption('rejected');await page.getByLabel('依据',{exact:true}).fill('复核发现资料版本不适用，需要重新建立标准');await page.getByRole('button',{name:'保存评审记录'}).click();await page.waitForLoadState('networkidle');expect(await page.locator('.page-heading').innerText()).toContain('已驳回');expect(await page.locator('body').innerText()).toContain('刷新后名称丢失');
 }finally{await browser.close();await web.close();if(previous===undefined)delete process.env.API_BASE_URL;else process.env.API_BASE_URL=previous;}
},40000);
