import { afterAll, beforeAll, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { registerAuth } from '../src/auth.js';
import { sendApiError } from '../src/errors.js';
import { registerReleaseRoutes } from '../src/routes-release.js';
import { createTestEnv, seedMinimalAssets, type TestEnv } from './helpers/db.js';

/**
 * R07/R08/R09 API 验收：
 * - R07：能力注册版本自增；模板悬空引用/环/重复节点拒绝；发布幂等；
 * - R08：未知工具拒绝；目标规划 CAS 审核；记忆项目隔离与失效；诊断跨项目引用拒绝；
 * - R09：决策不改 Run verdict；错项目/非终态/缺风险说明拒绝；并发审核单成功；
 *   导出与统计共用 reporting 口径。
 */

let env: TestEnv, app: FastifyInstance;
let projectId = '', otherProjectId = '', otherRunId = '', finishedRunId = '';
const H = { cookie: 'aiqa_sid=release-session' };

beforeAll(async () => {
  env = await createTestEnv('release');
  const user = await env.prisma.user.create({
    data: { username: 'release-test', displayName: 'T', passwordHash: 'unused', platformRole: 'LEAD' },
  });
  await env.prisma.session.create({
    data: { id: 'release-session', userId: user.id, expiresAt: new Date(Date.now() + 600_000) },
  });
  projectId = (await env.prisma.project.create({ data: { name: 'release 项目' } })).id;
  // 另一项目：当前用户无成员身份（平台角色 LEAD，无 ADMIN 兜底）→ 全部跨项目访问必须 403。
  otherProjectId = (await env.prisma.project.create({ data: { name: '另一项目' } })).id;
  await env.prisma.projectMembership.create({ data: { projectId, userId: user.id, role: 'ADMIN' } });

  // 他项目的空终态 Run，仅用于跨项目拒绝用例。
  {
    const baseline = await env.prisma.baseline.create({
      data: { projectId: otherProjectId, name: 'b', ruleVersionIds: [], caseVersionIds: [] },
    });
    const environment = await env.prisma.environment.create({
      data: { projectId: otherProjectId, name: 'e', baseUrl: 'http://127.0.0.1:1', allowedOrigins: [] },
    });
    otherRunId = (await env.prisma.run.create({
      data: {
        projectId: otherProjectId, baselineId: baseline.id, environmentId: environment.id,
        mode: 'mock', lifecycle: 'FINISHED', selectedCaseVersionIds: [], budget: {},
        idempotencyKey: `other-${Math.random()}`, acceptanceStatus: 'PASS',
      },
    })).id;
  }

  // 本项目的真实 FAIL 运行：固定计划 + FAIL 断言记录（reporting 唯一口径下的真 FAIL）。
  const assets = await seedMinimalAssets(env.prisma, env.store);
  projectId = assets.projectId;
  await env.prisma.projectMembership.create({ data: { projectId, userId: user.id, role: 'ADMIN' } });
  const plan = await env.prisma.testPlanVersion.findUniqueOrThrow({ where: { id: assets.planVersionId } });
  finishedRunId = (await env.prisma.run.create({
    data: {
      projectId, baselineId: assets.baselineId, environmentId: assets.environmentId,
      mode: 'real', lifecycle: 'FINISHED', selectedCaseVersionIds: [assets.caseVersionId],
      budget: {}, idempotencyKey: `fail-${Math.random()}`, acceptanceStatus: 'FAIL',
      casePlanPins: [{ caseVersionId: assets.caseVersionId, planVersionId: assets.planVersionId, acceptanceHash: plan.acceptanceHash }],
    },
  })).id;
  const attempt = await env.prisma.caseAttempt.create({
    data: {
      runId: finishedRunId, caseVersionId: assets.caseVersionId, projectId,
      attemptNo: 1, namespace: 'ns', lifecycle: 'FINISHED', verdict: 'FAIL', reasonCode: 'ASSERTION',
      startedAt: new Date(), finishedAt: new Date(),
    },
  });
  await env.prisma.assertionResultRecord.create({
    data: {
      attemptId: attempt.id, assertionId: 'a1', expected: '付款待办', actual: '付款失败',
      result: 'FAIL', evaluatedAt: new Date(), evidenceIds: [],
    },
  });

  app = Fastify();
  await app.register(cookie);
  registerAuth(app, env.prisma, 600);
  app.setErrorHandler((e, req, reply) => sendApiError(req, reply, e));
  registerReleaseRoutes(app, env.prisma, env.store);
});

afterAll(async () => { await app?.close(); await env?.cleanup(); });

const post = (url: string, payload: unknown, headers = H) =>
  app.inject({ method: 'POST', url: `/api${url}`, headers, payload });
const get = (url: string, headers = H) =>
  app.inject({ method: 'GET', url: `/api${url}`, headers });

// ============ R07 ============

it('能力注册：版本自增，重复 key 产生 v2', async () => {
  const base = {
    key: 'doc-parse', name: '文档解析', inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    effects: ['READ'], idempotencyStrategy: 'idempotent', recoveryStrategy: 'read_only',
  };
  const v1 = (await post(`/projects/${projectId}/capabilities`, base)).json();
  const v2 = (await post(`/projects/${projectId}/capabilities`, { ...base, name: '文档解析 v2' })).json();
  expect(v1.version).toBe(1);
  expect(v2.version).toBe(2);
  const list = (await get(`/projects/${projectId}/capabilities`)).json();
  expect(list.capabilities.filter((c: { key: string }) => c.key === 'doc-parse')).toHaveLength(2);
});

it('模板校验：悬空引用、环、重复节点 key 均被拒绝', async () => {
  const url = `/projects/${projectId}/workflow-templates`;
  const dangling = await post(url, {
    key: 't-dangling', name: 'x', nodes: [
      { key: 'a', capabilityKey: 'no-such', capabilityVersion: 1 },
    ],
  });
  expect(dangling.statusCode).toBe(422);
  expect(dangling.json().message).toContain('no-such');

  const cyc = await post(url, {
    key: 't-cycle', name: 'x', nodes: [
      { key: 'a', capabilityKey: 'doc-parse', capabilityVersion: 1, dependsOn: ['b'] },
      { key: 'b', capabilityKey: 'doc-parse', capabilityVersion: 1, dependsOn: ['a'] },
    ],
  });
  expect(cyc.statusCode).toBe(422);
  expect(cyc.json().message).toContain('环');

  const dup = await post(url, {
    key: 't-dup', name: 'x', nodes: [
      { key: 'a', capabilityKey: 'doc-parse', capabilityVersion: 1 },
      { key: 'a', capabilityKey: 'doc-parse', capabilityVersion: 1 },
    ],
  });
  expect(dup.statusCode).toBe(422);
  expect(dup.json().message).toContain('重复');
});

it('模板创建与发布：合法 DAG 通过，发布幂等，重复 key 版本自增', async () => {
  const url = `/projects/${projectId}/workflow-templates`;
  await post(`/projects/${projectId}/capabilities`,{key:'document-parse',name:'解析',inputSchema:{type:'object'},outputSchema:{type:'object'},effects:['READ'],idempotencyStrategy:'idempotent',recoveryStrategy:'read_only'});
  const okBody={key:'release-acceptance',name:'解析入口',nodes:[{key:'parse-my-doc',capabilityKey:'document-parse',capabilityVersion:1}]};
  const created = await post(url, okBody);
  expect(created.statusCode).toBe(200);
  const template = created.json();
  expect(template.version).toBe(1);
  expect(template.status).toBe('DRAFT');

  const v2 = await post(url, { ...okBody, name: '发布验收 v2' });
  expect(v2.json().version).toBe(2);

  const pub1 = await post(`/workflow-templates/${template.id}/publish`, {});
  expect(pub1.statusCode).toBe(200);
  const pub2 = await post(`/workflow-templates/${template.id}/publish`, {});
  expect(pub2.statusCode).toBe(200); // 幂等
  expect((await get(`/projects/${projectId}/workflow-templates`)).json().templates).toHaveLength(2);
});

// ============ R08 ============

it('目标规划：未知工具拒绝；合法建议通过；CAS 并发审核仅一个成功', async () => {
  const url = `/projects/${projectId}/goal-proposals`;
  const bad = await post(url, {
    goal: '验证登录', suggestedTools: [{ capabilityKey: 'ghost-tool', reason: 'x' }],
  });
  expect(bad.statusCode).toBe(422);
  expect(bad.json().message).toContain('ghost-tool');

  const good = await post(url, {
    goal: '验证登录流程',
    suggestedTools: [{ capabilityKey: 'doc-parse', reason: '解析 PRD' }],
    blockers: [{ kind: 'MISSING_DATA', description: '缺 PRD 原文' }],
  });
  expect(good.statusCode).toBe(200);
  expect(good.json().status).toBe('DRAFT');

  const reviewUrl = `/goal-proposals/${good.json().id}/review`;
  const [a, b] = await Promise.all([
    post(reviewUrl, { decision: 'approve' }),
    post(reviewUrl, { decision: 'reject' }),
  ]);
  expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
  const finalStatus = (await env.prisma.goalProposal.findUniqueOrThrow({ where: { id: good.json().id } })).status;
  expect(['APPROVED', 'REJECTED']).toContain(finalStatus);
});

it('记忆：创建/列表默认隐藏已失效；失效 CAS；跨项目拒绝', async () => {
  const url = `/projects/${projectId}/memories`;
  const created = await post(url, {
    content: '登录页 URL 为 /login',
    source: { kind: 'manual' },
    context: {},
    invalidationTriggers: [{ kind: 'document_change', condition: 'PRD 登录章节变化' }],
  });
  expect(created.statusCode).toBe(200);

  // 跨项目：无另一项目成员身份 → 403（平台 ADMIN 例外仅限 VIEWER 读，写仍拒绝）。
  const cross = await post(`/projects/${otherProjectId}/memories`, {
    content: 'x', source: { kind: 'manual' }, context: {}, invalidationTriggers: [],
  });
  expect(cross.statusCode).toBe(403);

  const inv1 = await post(`/memories/${created.json().id}/invalidate`, { reason: 'PRD 已变更' });
  expect(inv1.statusCode).toBe(200);
  const inv2 = await post(`/memories/${created.json().id}/invalidate`, { reason: '再次失效' });
  expect(inv2.statusCode).toBe(409); // CAS：已失效不能重复失效

  const hidden = (await get(url)).json();
  expect(hidden.memories).toHaveLength(0);
  const shown = (await get(`${url}?includeInvalidated=true`)).json();
  expect(shown.memories).toHaveLength(1);
  expect(shown.memories[0].invalidatedReason).toBe('PRD 已变更');
});

it('诊断：引用他项目 Run 拒绝；本项目可建可查', async () => {
  const bad = await post(`/projects/${projectId}/diagnoses`, {
    runId: otherRunId, category: 'PRODUCT_FAILURE',
    facts: [{ text: '截图显示错误' }], hypotheses: [], suggestions: [], confidence: 'high',
  });
  expect(bad.statusCode).toBe(422);

  const ok = await post(`/projects/${projectId}/diagnoses`, {
    runId: finishedRunId, category: 'PRODUCT_FAILURE',
    facts: [{ text: '断言失败' }],
    hypotheses: [{ text: '接口超时', basis: '耗时 30s' }],
    suggestions: [{ text: '复测一次', riskNote: '不稳定用例' }],
    confidence: 'medium',
  });
  expect(ok.statusCode).toBe(200);
  const listed = (await get(`/projects/${projectId}/diagnoses?runId=${finishedRunId}`)).json();
  expect(listed.diagnoses).toHaveLength(1);
  expect(listed.diagnoses[0].hypotheses[0].basis).toBe('耗时 30s');
});

// ============ R09 ============

it('发布决策：错项目 Run 拒绝；非终态拒绝；缺风险说明拒绝', async () => {
  const url = `/projects/${projectId}/release-decisions`;
  expect((await post(url, { runIds: [otherRunId], decision: 'ACCEPT', reason: 'ok' })).statusCode).toBe(422);

  const baseline = await env.prisma.baseline.create({
    data: { projectId, name: 'b2', ruleVersionIds: [], caseVersionIds: [] },
  });
  const environment = await env.prisma.environment.findFirstOrThrow({ where: { projectId } });
  const running = await env.prisma.run.create({
    data: { projectId, baselineId: baseline.id, environmentId: environment.id, mode: 'mock', selectedCaseVersionIds: [], budget: {}, idempotencyKey: `run-${Math.random()}` },
  });
  expect((await post(url, { runIds: [running.id], decision: 'ACCEPT', reason: 'ok' })).statusCode).toBe(409);

  expect((await post(url, { runIds: [finishedRunId], decision: 'ACCEPT_WITH_RISK', reason: '一切正常' })).statusCode).toBe(422);
});

it('发布决策：不改 Run verdict；决策追加为历史；快照记录 FAIL 事实', async () => {
  const url = `/projects/${projectId}/release-decisions`;
  const before = await env.prisma.run.findUniqueOrThrow({ where: { id: finishedRunId } });

  const d1 = await post(url, {
    runIds: [finishedRunId], decision: 'ACCEPT_WITH_RISK',
    reason: '存在 FAIL，风险：仅影响次要场景',
  });
  expect(d1.statusCode).toBe(200);
  const d2 = await post(url, { runIds: [finishedRunId], decision: 'REJECT', reason: 'FAIL 未修复' });
  expect(d2.statusCode).toBe(200);

  // Run 的 acceptanceStatus / lifecycle 不被决策修改。
  const after = await env.prisma.run.findUniqueOrThrow({ where: { id: finishedRunId } });
  expect(after.acceptanceStatus).toBe(before.acceptanceStatus);
  expect(after.lifecycle).toBe(before.lifecycle);

  const list = (await get(url)).json();
  expect(list.decisions).toHaveLength(2); // 追加历史，不覆盖

  // 快照如实记录存在 FAIL：接受风险不能把 FAIL 洗成通过。
  const snapshot = list.decisions.find((d: { decision: string }) => d.decision === 'ACCEPT_WITH_RISK').evidenceSnapshot[finishedRunId];
  expect(snapshot.hasFail).toBe(true);
  expect(snapshot.acceptanceStatus).toBe('FAIL');
});

it('导出：JSON 与 Markdown 与页面共用 reporting 口径；未登录拒绝', async () => {
  expect((await get(`/runs/${finishedRunId}/export/json`, {})).statusCode).toBe(401);
  expect((await get(`/runs/${otherRunId}/export/json`)).statusCode).toBe(403); // 跨项目

  const json = await get(`/runs/${finishedRunId}/export/json`);
  expect(json.statusCode).toBe(200);
  expect(json.headers['content-type']).toContain('application/json');
  const body = json.json();
  expect(body.run.id).toBe(finishedRunId);
  expect(body.metrics.acceptanceStatus).toBe('FAIL');
  expect(Array.isArray(body.cases)).toBe(true);

  const md = await get(`/runs/${finishedRunId}/export/markdown`);
  expect(md.statusCode).toBe(200);
  expect(md.body).toContain(finishedRunId);
  expect(md.body).toContain('FAIL');
});

it('全量统计：group by 数库，与列表限额无关', async () => {
  const stats = (await get(`/projects/${projectId}/stats`)).json();
  expect(stats.runs.total).toBeGreaterThanOrEqual(2);
  expect(stats.runs.byLifecycle.FINISHED).toBeGreaterThanOrEqual(1);
  expect(stats.runs.byAcceptance.FAIL).toBeGreaterThanOrEqual(1);
  expect(stats.generatedAt).toBeTruthy();
});

it('并发能力注册与模板新版本分配唯一版本号，不返回 500',async()=>{
 const base={key:'concurrent-cap',name:'并发',inputSchema:{type:'object'},outputSchema:{type:'object'},effects:['READ'],idempotencyStrategy:'idempotent',recoveryStrategy:'read_only'};
 const caps=await Promise.all([post(`/projects/${projectId}/capabilities`,base),post(`/projects/${projectId}/capabilities`,base)]);
 expect(caps.map(r=>r.statusCode)).toEqual([200,200]);expect(caps.map(r=>r.json().version).sort()).toEqual([1,2]);
 const template={key:'concurrent-template',name:'并发',nodes:[{key:'parse',capabilityKey:'doc-parse',capabilityVersion:1}]};
 const ts=await Promise.all([post(`/projects/${projectId}/workflow-templates`,template),post(`/projects/${projectId}/workflow-templates`,template)]);
 expect(ts.map(r=>r.statusCode)).toEqual([200,200]);expect(ts.map(r=>r.json().version).sort()).toEqual([1,2]);
});
it('批准目标到真实工作流原子绑定：阻塞/模拟/越权范围拒绝，并发执行只建一份',async()=>{
 await post(`/projects/${projectId}/workflow-templates/builtins`,{});
 const template=await env.prisma.workflowTemplate.findFirstOrThrow({where:{projectId,key:'engineering-check',status:'PUBLISHED'}});
 const make=async(blockers:any[]=[])=>{const r=await post(`/projects/${projectId}/goal-proposals`,{goal:'工程质量检查',suggestedTools:[{capabilityKey:'code-check',reason:'执行已有工程检查'}],suggestedScope:{},suggestedBudget:{},blockers});expect(r.statusCode,r.body).toBe(200);return r.json();};
 const p=await make(),body={templateId:template.id,inputs:{codeCheck:{repositoryUrl:'https://github.com/fixture/project',commitSha:'a'.repeat(40),kind:'NODE_TEST',timeoutSeconds:60,installDependencies:false}}};
 expect((await post(`/goal-proposals/${p.id}/execute`,body)).statusCode).toBe(409);
 await post(`/goal-proposals/${p.id}/review`,{decision:'approve'});
 const [a,b]=await Promise.all([post(`/goal-proposals/${p.id}/execute`,body),post(`/goal-proposals/${p.id}/execute`,body)]);
 expect(a.statusCode,a.body).toBe(202);expect(b.json().workflowId).toBe(a.json().workflowId);
 expect(await env.prisma.workflowRun.count({where:{projectId,idempotencyKey:'goal:'+p.id}})).toBe(1);
 expect((await env.prisma.goalProposal.findUniqueOrThrow({where:{id:p.id}})).status).toBe('EXECUTED');
 expect((await post(`/goal-proposals/${p.id}/execute`,{...body,inputs:{codeCheck:{...body.inputs.codeCheck,commitSha:'b'.repeat(40)}}})).statusCode).toBe(409);
 const blocked=await make([{kind:'MISSING_DATA',description:'缺少 PRD'}]);await post(`/goal-proposals/${blocked.id}/review`,{decision:'approve'});
 expect((await post(`/goal-proposals/${blocked.id}/execute`,body)).statusCode).toBe(409);
 const mock=await make();await env.prisma.goalProposal.update({where:{id:mock.id},data:{status:'APPROVED',suggestedScope:{mode:'mock'}}});
 expect((await post(`/goal-proposals/${mock.id}/execute`,body)).statusCode).toBe(422);
});
it('记忆来源、有效期、环境版本校验；false 查询不返回已失效条目',async()=>{
 const url=`/projects/${projectId}/memories`;
 expect((await post(url,{content:'伪造观察',source:{kind:'observation'}})).statusCode).toBe(422);
 expect((await post(url,{content:'错项目执行',source:{kind:'execution',referenceId:otherRunId}})).statusCode).toBe(422);
 expect((await post(url,{content:'过期',source:{kind:'manual'},validUntil:new Date(Date.now()-1000).toISOString()})).statusCode).toBe(422);
 const environment=await env.prisma.environment.findFirstOrThrow({where:{projectId}});
 const created=await post(url,{content:'当前环境观察提示',source:{kind:'execution',referenceId:finishedRunId},context:{environmentId:environment.id,environmentRevision:environment.revision}});
 expect(created.statusCode,created.body).toBe(200);expect(created.json().validUntil).toBeTruthy();
 await env.prisma.environment.update({where:{id:environment.id},data:{revision:{increment:1}}});
 const visible=(await get(url+'?includeInvalidated=false')).json();expect(visible.memories.find((m:any)=>m.id===created.json().id)).toBeUndefined();
 expect((await env.prisma.projectMemory.findUniqueOrThrow({where:{id:created.json().id}})).invalidatedReason).toContain('环境');
});
it('报告自动诊断冻结事实证据且幂等，不修改 verdict；伪造证据拒绝',async()=>{
 const before=await env.prisma.run.findUniqueOrThrow({where:{id:finishedRunId}});
 const [a,b]=await Promise.all([post(`/projects/${projectId}/diagnoses/generate`,{runId:finishedRunId}),post(`/projects/${projectId}/diagnoses/generate`,{runId:finishedRunId})]);
 expect(a.statusCode,a.body).toBe(200);expect(b.json().id).toBe(a.json().id);expect(a.json().hypotheses).toEqual([]);
 const artifact=await env.prisma.artifact.findUniqueOrThrow({where:{id:a.json().facts[0].evidenceId}});expect(env.store.verify(artifact.storageKey,artifact.checksum)).toBe(true);
 expect((await env.prisma.run.findUniqueOrThrow({where:{id:finishedRunId}})).acceptanceStatus).toBe(before.acceptanceStatus);
 expect((await post(`/projects/${projectId}/diagnoses`,{runId:finishedRunId,category:'PRODUCT_FAILURE',facts:[{text:'伪造',evidenceId:'missing'}],confidence:'high'})).statusCode).toBe(422);
});

it('发布决定并发重试只追加一次，内容变化冲突；历史结论保持 FAIL',async()=>{
 const body={runIds:[finishedRunId],decision:'ACCEPT_WITH_RISK',reason:'风险由业务负责人知悉，保留原失败',idempotencyKey:'decision-once-2026'};
 const responses=await Promise.all([post(`/projects/${projectId}/release-decisions`,body),post(`/projects/${projectId}/release-decisions`,body)]);
 for(const r of responses)expect(r.statusCode,r.body).toBe(200);expect(responses[0]!.json().id).toBe(responses[1]!.json().id);
 expect((await post(`/projects/${projectId}/release-decisions`,{...body,decision:'REJECT'})).statusCode).toBe(409);
 const audit=await env.prisma.auditEvent.count({where:{entityId:responses[0]!.json().id,action:'releaseDecision.create'}});expect(audit).toBe(1);
 expect((await env.prisma.run.findUniqueOrThrow({where:{id:finishedRunId}})).acceptanceStatus).toBe('FAIL');
});
