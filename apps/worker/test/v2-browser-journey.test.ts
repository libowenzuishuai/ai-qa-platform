import {registerV2ProfileRoutes} from "../../api/src/routes-v2-profiles.js";
import {registerV2OracleRoutes} from "../../api/src/routes-v2-oracle.js";
import {HttpReadManifest} from "@ai-qa/adapter-sdk/samples/http-checker";
import {registerV2DefinitionRoutes} from "../../api/src/routes-v2-definitions.js";
import { beforeAll, afterAll, it, expect } from "vitest";
import Fastify from "fastify";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import cookie from "@fastify/cookie";
import { chromium } from "playwright";
import { createTestEnv, type TestEnv } from "../../api/test/helpers/db.js";
import { registerV2SessionRoutes } from "../../api/src/routes-v2-sessions.js";
import { registerV2CapabilityRoutes } from "../../api/src/routes-v2-capabilities.js";
import { registerAuth } from "../../api/src/auth.js";
import { sendApiError } from "../../api/src/errors.js";
import { processAgentJob } from "../src/agent-job-processor.js";
import { WorkerConfig } from "../src/config.js";
import { registerBuiltinSamples } from "../src/v2/samples.js";
import { DraftOpsManifest } from "@ai-qa/adapter-sdk/samples/draft-ops";
import { computeOracleHash } from "@ai-qa/contracts";

/**
 * R3 真实浏览器验收（1440 桌面 / 390 移动）：
 * 会话列表→创建→详情 全链路走真实 API + SSR 页面；
 * 布局无横向溢出、表单可键盘操作；截图存 docs/evidence/v2-ui/。
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
let env: TestEnv, apiApp: ReturnType<typeof Fastify>, webApp: ReturnType<typeof Fastify>;
let projectId = "", environmentId = "", oracleSpecId = "";
let draftPort = 0, draftBaseUrl = "";
let draftServer: ReturnType<typeof spawn>;
let webUrl = "";
const H = {} as Record<string, string>;
let webSid = "web-journey-session";
const queuedJobs: string[] = [];
const queue = { add: async (_n: string, d: { jobId: string }) => { queuedJobs.push(d.jobId); return {} as never; } };

beforeAll(async () => {
  env = await createTestEnv("v2ui");
  const user = await env.prisma.user.create({
    data: { username: randomUUID(), displayName: "lead", passwordHash: "x", platformRole: "LEAD" },
  });
  await env.prisma.session.create({ data: { id: webSid, userId: user.id, expiresAt: new Date(Date.now() + 900000) } });
  const project = await env.prisma.project.create({
    data: { name: "浏览器验收项目", memberships: { create: { userId: user.id, role: "ADMIN" } } },
  });
  projectId = project.id;

  draftPort = 20000 + Math.floor(Math.random() * 20000);
  draftBaseUrl = `http://127.0.0.1:${draftPort}`;
  draftServer = spawn("node", [join(root, "examples/synthetic/draft-app/server.mjs"), "--port", String(draftPort)], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("draft timeout")), 8000);
    const on = (b: Buffer) => { if (b.toString().includes("ready")) { clearTimeout(timer); resolve(); } };
    draftServer.stdout?.on("data", on);
    draftServer.stderr?.on("data", on);
  });

  const environment = await env.prisma.environment.create({
    data: { projectId, name: "synthetic", baseUrl: draftBaseUrl, allowedOrigins: [draftBaseUrl] },
  });
  environmentId = environment.id;

  const dims = ["normal", "boundary", "permission", "multi_role", "state", "persistence"] as const;
  const ruleVersionId = `rv-ui-${randomUUID().slice(0, 6)}`;
  const assertions = [{
    id: "a-title", ruleVersionId, kind: "deterministic",
    fact: "草稿标题", observationType: "api_field", observationRef: "draft.title",
    operator: "equals", expected: "验收目标名称", precondition: null, unit: null, tolerance: null,
    allowedRoles: [], required: true,
  }];
  const coverageDeclarations = dims.map((dimension) => ({ ruleVersionId, dimension, status: "planned", reason: "ui 测试" }));
  const oracleHash = computeOracleHash({ projectId, ruleVersionIds: [ruleVersionId], assertions: assertions as never, semanticCandidates: [], coverageDeclarations });
  const oracle = await env.prisma.v2OracleSpec.create({
    data: {
      projectId, version: 1, status: "APPROVED", ruleVersionIds: [ruleVersionId],
      assertions: assertions as never, semanticCandidates: [], coverageDeclarations,
      oracleHash, createdBy: "t", approvedBy: "t", approvedAt: new Date(),
    },
  });
  oracleSpecId = oracle.id;

  apiApp = Fastify();
  await apiApp.register(cookie);
  registerAuth(apiApp, env.prisma, 600);
  apiApp.addHook("onRequest", async (req) => {
    req.auth = { userId: user.id, username: user.username, displayName: user.displayName, platformRole: "LEAD" };
  });
  apiApp.setErrorHandler((e, q, r) => sendApiError(q, r, e));
  registerV2CapabilityRoutes(apiApp, env.prisma);
  registerV2SessionRoutes(apiApp, env.prisma, queue,{artifactDir:env.artifactDir});
  registerV2DefinitionRoutes(apiApp,env.prisma);
  registerV2ProfileRoutes(apiApp,env.prisma,queue);
  registerV2OracleRoutes(apiApp,env.prisma);
  // 页面需要环境列表（最小内联端点；真实 API 由 routes-projects 提供）。
  apiApp.get("/api/projects/:id/environments", async (req) => {
    const { id } = req.params as { id: string };
    return { environments: await env.prisma.environment.findMany({ where: { projectId: id } }) };
  });
  const apiUrl = await apiApp.listen({ host: "127.0.0.1", port: 0 });
  process.env.API_BASE_URL = apiUrl;

  const { registerV2Pages } = await import("../../web/src/v2-pages.js");
  webApp = Fastify();
  await webApp.register(cookie);
  await webApp.register(import("@fastify/formbody")); // 浏览器表单是 urlencoded
  registerV2Pages(webApp);
  webUrl = await webApp.listen({ host: "127.0.0.1", port: 0 });

  registerBuiltinSamples();
  const install = await apiApp.inject({
    method: "POST", url: `/api/v2/projects/${projectId}/capabilities/install`, headers: H,
    payload: { manifest: JSON.parse(JSON.stringify(DraftOpsManifest)) },
  });
  await apiApp.inject({
    method: "POST", url: `/api/v2/installations/${install.json().installationId}/authorize`, headers: H,
    payload: { scope: ["draft:ops"] },
  });
}, 40000);

afterAll(async () => {
  delete process.env.API_BASE_URL;
  draftServer?.kill("SIGTERM");
  await webApp?.close();
  await apiApp?.close();
  await env?.cleanup();
});

function config() {
  return WorkerConfig.parse({
    databaseUrl: env.databaseUrl, redisUrl: "redis://127.0.0.1:6380/0",
    artifactDir: env.artifactDir, intelligenceBackend: "python",
    intelligenceUrl: "http://127.0.0.1:1", intelligenceToken: "x", intelligenceTimeoutMs: 5000,
  });
}

const shotDir = join(root, "docs/evidence/v2-ui");
mkdirSync(shotDir, { recursive: true });

it("1440/390 真实浏览器旅程：列表空态→表单创建→详情（真实事件）；无横向溢出", async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: "web_sid", value: webSid, url: webUrl }]);
  const page = await context.newPage();

  // 列表空态。
  await page.goto(`${webUrl}/space/${projectId}/autonomous`);
  expect(await page.locator(".empty-state").count()).toBeGreaterThan(0);
  await page.screenshot({ path: join(shotDir, "desktop-list-empty.png"), fullPage: true });
  const overflow1440 = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(overflow1440).toBe(false);

  // 表单键盘可操作 + 提交（真实创建）。
  await page.getByText("开发者演示：合成草稿自主闭环",{exact:true}).click();
  await page.focus("#v2-target");
  await page.fill("#v2-target", draftBaseUrl);
  await page.fill("#v2-oracle", oracleSpecId);
  const [submitResponse] = await Promise.all([
    page.waitForNavigation(),
    page.locator("button[type=submit]").click(),
  ]);
  expect([200, 302]).toContain(submitResponse?.status() ?? 0);
  while (queuedJobs.length) await processAgentJob(env.prisma, config(), queuedJobs.shift()!);
  const dbJob = await env.prisma.job.findFirst({ where: { kind: "V2_SESSION_LOOP" } });
  expect(dbJob?.status).toBe("SUCCEEDED");
  await page.reload();
  expect(await page.getByText("COMPLETED").count()).toBeGreaterThan(0);
  await page.screenshot({ path: join(shotDir, "desktop-list-completed.png"), fullPage: true });

  // 详情：阶段与账本真实数据。
  await page.locator("table a").first().click();
  expect(await page.getByText("循环阶段（真实事件）").count()).toBeGreaterThan(0);
  expect(await page.getByText("验证").count()).toBeGreaterThan(0);
  expect(await page.getByText("调用账本（intent → receipt）").count()).toBeGreaterThan(0);
  await page.screenshot({ path: join(shotDir, "desktop-detail.png"), fullPage: true });

  // 390 移动：无横向溢出（表格区允许内部滚动）。
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await mobile.addCookies([{ name: "web_sid", value: webSid, url: webUrl }]);
  const mpage = await mobile.newPage();
  await mpage.goto(`${webUrl}/v2/sessions/${(await env.prisma.v2ExecutionSession.findMany({ where: { projectId } }))[0]!.id}`);
  await mpage.waitForLoadState("networkidle");
  await mpage.screenshot({ path: join(shotDir, "mobile-detail.png"), fullPage: true });
  const overflow390 = await mpage.evaluate(() => {
    // app-main 自身允许 overflow-x:auto（表格滚动），检查文档级溢出。
    return document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
  });
  expect(overflow390).toBe(false);

  await browser.close();
}, 120000);

it("组合编辑器：画布和表单保存同一 AST，发布后重新打开，移动端无溢出",async()=>{
 const browser=await chromium.launch();
 try {
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.addCookies([{name:"web_sid",value:webSid,url:webUrl}]);
  const page=await context.newPage();
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto(`${webUrl}/space/${projectId}/composer`);
  await page.fill("#flow-name","浏览器验收组合");
  await page.click("#add-node");
  await page.fill("#node-id","observe-draft");
  await page.getByText("高级：参数绑定 JSON",{exact:true}).click();
  await page.fill("#bindings",JSON.stringify({op:{source:"constant",type:"string",value:"meta"},baseUrl:{source:"input",type:"string",path:"baseUrl"}}));
  await page.click("#apply-node");
  expect(await page.locator("#canvas").innerText()).toContain("observe-draft");
  await page.click("#validate-flow");
  await page.waitForFunction(()=>document.getElementById("compose-status")?.textContent?.includes("检查通过"));
  await page.click("#save-flow");
  await page.waitForFunction(()=>document.getElementById("compose-status")?.textContent?.includes("已保存"));
  await page.click("#publish-flow");
  await page.waitForFunction(()=>document.getElementById("compose-status")?.textContent?.includes("已发布"));
  const row=await env.prisma.v2WorkflowDefinition.findFirstOrThrow({where:{projectId,name:"浏览器验收组合"}});
  expect(row.status).toBe("PUBLISHED");
  expect((row.content as any).nodes[0].nodeId).toBe("observe-draft");
  await page.goto(`${webUrl}/space/${projectId}/composer?definition=${row.id}`);
  expect(await page.locator("#canvas").innerText()).toContain("observe-draft");
  await page.screenshot({path:join(shotDir,"desktop-composer.png"),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth+1)).toBe(false);
  await page.screenshot({path:join(shotDir,"mobile-composer.png"),fullPage:true});
  expect(errors).toEqual([]);
 } finally {await browser.close();}
},45000);

it("real browser: publish profile, configure form without JSON, execute graph and report",async()=>{
 const install=(await apiApp.inject({method:'POST',url:`/api/v2/projects/${projectId}/capabilities/install`,payload:{manifest:HttpReadManifest}})).json();
 await apiApp.inject({method:'POST',url:`/api/v2/installations/${install.installationId}/authorize`,payload:{scope:['read:http']}});
 const saved=(await apiApp.inject({method:'POST',url:`/api/v2/projects/${projectId}/definitions`,payload:{name:'HTTP 验收',description:'UI journey',maxSubflowDepth:4,nodes:[{nodeId:'verify',capabilityId:HttpReadManifest.id,capabilityVersion:'1.0.0',dependsOn:[],onFailure:'fail',bindings:{baseUrl:{source:'input',path:'baseUrl',type:'string'},resourcePath:{source:'constant',value:'/api/_meta',type:'string'}}}]}})).json();
 await apiApp.inject({method:'POST',url:`/api/v2/definitions/${saved.definitionId}/publish`});
 const old=await env.prisma.v2OracleSpec.findUniqueOrThrow({where:{id:oracleSpecId}});
 const assertions=[{...(old.assertions as Array<Record<string,unknown>>)[0],id:'a-status',fact:'元信息接口可用',observationType:'api_status',observationRef:'meta.status',expected:'200'}];
 const content={projectId,ruleVersionIds:old.ruleVersionIds,assertions,coverageDeclarations:old.coverageDeclarations,semanticCandidates:[]};
 const oracle=await env.prisma.v2OracleSpec.create({data:{...content,assertions:assertions as never,coverageDeclarations:old.coverageDeclarations as never,version:2,status:'APPROVED',oracleHash:computeOracleHash(content as never),createdBy:'t',approvedBy:'t',approvedAt:new Date()}});
 const browser=await chromium.launch();try{
  const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addCookies([{name:'web_sid',value:webSid,url:webUrl}]);const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${webUrl}/space/${projectId}/composer/run`);
  await page.locator('input[name=key]').fill('release-checks');await page.locator(`input[type=checkbox][value="${install.installationId}"]`).check();
  await Promise.all([page.waitForURL(/profile=/,{timeout:5000}),page.getByRole('button',{name:'保存并发布配置'}).click()]).catch(async e=>{throw Error(e.message+' PAGE '+page.url()+' '+await page.locator('body').innerText());});
  await page.locator('select[name=definitionId]').selectOption(saved.definitionId);await page.locator('select[name=oracleSpecId]').selectOption(oracle.id);
  await page.getByLabel('元信息接口可用 观察节点').selectOption('verify');await page.locator('input[name=goal]').fill('接口状态符合批准标准');await page.locator('input[name=buildId]').fill('browser-graph-build');
  expect(await page.getByLabel('任务参数 baseUrl').inputValue()).toBe(draftBaseUrl);
  await page.screenshot({path:join(shotDir,'desktop-graph-launch.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth+1)).toBe(false);await page.screenshot({path:join(shotDir,'mobile-graph-launch.png'),fullPage:true});
  expect(await page.locator('#graph-launch').evaluate((f:any)=>Array.from(f.querySelectorAll(':invalid')).map((e:any)=>e.outerHTML))).toEqual([]);
  await Promise.all([page.waitForURL(/\/v2\/sessions\//,{timeout:5000}),page.getByRole('button',{name:'开始验收 →'}).click()]).catch(async e=>{throw Error(e.message+' PAGE '+page.url()+' '+await page.locator('body').innerText());});
  const sessionId=page.url().split('/').at(-1)!;const job=await env.prisma.job.findFirstOrThrow({where:{kind:'V2_GRAPH_SESSION',request:{path:['sessionId'],equals:sessionId}}});
  await processAgentJob(env.prisma,config(),job.id);await page.reload();expect(await page.locator('body').innerText()).toContain('pass');expect(errors).toEqual([]);
 }finally{await browser.close();}
},30000);
