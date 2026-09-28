import {registerFindingPages} from './v2-findings.js';
import {registerTestPatchPages} from "./v2-test-patches.js";
import {registerGraphRunnerPages} from "./v2-runner.js";
import type { FastifyInstance } from "fastify";
import { registerComposerPages } from "./v2-composer.js";
import { api } from "./api.js";
import { layout } from "./pages.js";

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/**
 * R3 最小用户旅程（v2 切片）：
 * - /space/:id?tab=autonomous：v2 会话列表 + 创建（合成草稿闭环模板）+ 就绪检查；
 * - /v2/sessions/:id：实时台（阶段/意图/调用/观察 真实事件数据）+ 取消。
 * 页面数据全部来自 API（真实状态），无假进度。
 */

interface SessionRow { id: string; goal: string; status: string; buildId: string; createdAt: string }

export function registerV2Pages(app: FastifyInstance) {
  registerComposerPages(app);
  registerGraphRunnerPages(app);
  registerTestPatchPages(app);
  registerFindingPages(app);
  const sid = (req: { cookies: Record<string, string | undefined> }) => req.cookies.web_sid;

  app.get("/space/:id/autonomous", async (req, reply) => {
    const s = sid(req);
    if (!s) return reply.redirect("/login");
    const { id } = req.params as { id: string };
    try {
      const [sessionsRes, envRes] = await Promise.all([
        api(`/api/v2/projects/${encodeURIComponent(id)}/sessions`, { sid: s }),
        api(`/api/projects/${encodeURIComponent(id)}/environments`, { sid: s }).catch(() => ({ status: 404, data: { environments: [] } })),
      ]);
      // 项目名可缺省（最小部署未必注册项目详情端点）；id 永远可用。
      const project = { id, name: id };
      const sessions = ((sessionsRes.data as { sessions?: SessionRow[] })?.sessions ?? []) as SessionRow[];
      const environments = ((envRes.data as { environments?: Array<{ id: string; name: string; baseUrl: string; allowedOrigins?: string[] }> })?.environments ?? []);
      const rows = sessions.map((x) => `<tr>
        <td><a href="/v2/sessions/${encodeURIComponent(x.id)}">${esc(x.goal.slice(0, 40))}</a></td>
        <td><span class="badge ${x.status === "COMPLETED" ? "PASS" : x.status === "FAILED" ? "FAIL" : "REVIEW"}">${esc(x.status)}</span></td>
        <td>${esc(x.buildId)}</td><td>${esc(new Date(x.createdAt).toLocaleString("zh-CN"))}</td></tr>`).join("");
      const envOptions = environments.map((e) => `<option value="${esc(e.id)}">${esc(e.name)}（${esc(e.baseUrl)}）</option>`).join("");
      const body = `
      <div class="page-heading"><div><span class="eyebrow">AUTONOMOUS QA（v2 预览）</span><h1>自主测试会话</h1>
      <p>目标驱动的执行循环：观察→规划→行动→验证→调整。组合图可按已发布版本执行；草稿目标循环支持确定性与 Python 模型规划，实际可用范围以所选能力为准。</p></div></div>
      <p><a class="primary-link" href="/space/${esc(id)}/composer">组合测试能力 →</a> · <a href="/space/${esc(id)}/composer/run">运行已发布组合 →</a> · <a href="/space/${esc(id)}/test-patches">补充代码测试 →</a> · <a href="/space/${esc(id)}/findings">缺陷调查 →</a></p>
      <section class="card"><h2>选择这次要完成的工作</h2><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:16px"><article><h3>验收一次交付</h3><p>从批准需求和测试基线进入完整准备、执行、评估流程。</p><a href="/projects/${esc(id)}/delivery">进入交付任务 →</a></article><article><h3>运行自定义组合</h3><p>使用已发布的工具图、固定标准和受控能力完成验证。</p><a href="/space/${esc(id)}/composer/run">选择组合与标准 →</a></article><article><h3>补充有效代码测试</h3><p>审核业务样例，在隔离环境对照健康、缺陷与修复版本。</p><a href="/space/${esc(id)}/test-patches">生成候选测试 →</a></article></div></section>
      <details class="card"><summary>开发者演示：合成草稿自主闭环</summary><h2>发起一次验收（合成草稿闭环）</h2>
      <p class="muted">目标固定为「创建草稿→改名→刷新仍保留名称」，以已批准的 Oracle 为标准。合成系统地址须在环境白名单内。</p>
      <form method="post" action="/space/${esc(id)}/autonomous">
        <label for="v2-goal">验收目标</label><input id="v2-goal" name="goal" required maxlength="2000" value="创建草稿→改名→刷新仍保留名称">
        <label for="v2-env">环境</label><select id="v2-env" name="environmentId" required>${envOptions}</select>
        <label for="v2-target">合成系统地址</label><input id="v2-target" name="targetBaseUrl" required placeholder="http://127.0.0.1:9300" value="http://127.0.0.1:9300">
        <label for="v2-oracle">Oracle（已批准标准）</label><input id="v2-oracle" name="oracleSpecId" required placeholder="从 Oracle 列表粘贴 id">
        <button type="submit">启动会话 →</button>
      </form></details>
      <section class="card"><h2>会话</h2>
      ${rows ? `<table><thead><tr><th>目标</th><th>状态</th><th>构建</th><th>创建时间</th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty-state">尚无会话。发起第一次自主验收。</div>`}
      </section>`;
      return reply.type("text/html").send(layout("自主测试", body, { projectId: project.id, projectName: project.name }));
    } catch (e) {
      return reply.code(502).send(layout("错误", `<div class="error-box">${esc((e as Error).message)}</div>`));
    }
  });

  app.post("/space/:id/autonomous", async (req, reply) => {
    const s = sid(req);
    if (!s) return reply.redirect("/login");
    const { id } = req.params as { id: string };
    const form = req.body as Record<string, string>;
    try {
      await api(`/api/v2/projects/${encodeURIComponent(id)}/sessions`, {
        sid: s, method: "POST",
        body: {
          goal: form.goal, environmentId: form.environmentId,
          targetBaseUrl: form.targetBaseUrl, oracleSpecId: form.oracleSpecId,
          idempotencyKey: `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        },
      });
      return reply.redirect(`/space/${encodeURIComponent(id)}/autonomous`);
    } catch (e) {
      const err = e as { message?: string };
      return reply.code(422).send(layout("启动失败", `<div class="error-box">${esc(err.message ?? "启动失败")}</div><p><a class="primary-link" href="/space/${esc(id)}/autonomous">← 返回</a></p>`));
    }
  });

  app.get("/v2/sessions/:id", async (req, reply) => {
    const s = sid(req);
    if (!s) return reply.redirect("/login");
    const { id } = req.params as { id: string };
    try {
      const res = await api(`/api/v2/sessions/${encodeURIComponent(id)}`, { sid: s });
      const d = res.data as {
        reportVerdict?: string; evidenceComplete?: boolean;
        session: { result?: { verdict: string; buildVerification?:{verified:boolean;reason:string};checks?:Array<{assertionId:string;verdict:string;actual:unknown;reason?:string}> }; id: string; goal: string; status: string; terminationReason: string | null; projectId: string; buildId: string };
        attempts: Array<{ round: number; phase: string; status: string; rationale: string | null }>;
        intents: Array<{ id: string; idempotencyKey: string; createdAt: string }>;
        invocations: Array<{ intentId: string; attemptNo: number; status: string; receipt: { outcome: string } | null }>;
        observations: Array<{ round: number; source: string; summary: unknown }>;
      };
      const phaseLabel: Record<string, string> = { observe: "观察", plan: "规划", act: "行动", verify: "验证", adapt: "调整" };
      const attempts = d.attempts.map((a) => `<tr><td>${a.round}</td><td>${phaseLabel[a.phase] ?? a.phase}</td><td><span class="badge ${a.status === "SUCCEEDED" ? "PASS" : "REVIEW"}">${esc(a.status)}</span></td><td>${esc(a.rationale ?? "")}</td></tr>`).join("");
      const invocations = d.invocations.map((v) => `<tr><td><code>${esc(v.intentId.slice(-8))}</code></td><td>#${v.attemptNo}</td><td>${esc(v.status)}</td><td>${esc(v.receipt?.outcome ?? "")}</td></tr>`).join("");
      const body = `
      <div class="page-heading"><div><span class="eyebrow">SESSION</span><h1>${esc(d.session.goal.slice(0, 50))}</h1>
      <p>状态 <b>${esc(d.session.status)}</b> · 验收结论 <b>${esc(d.reportVerdict ?? d.session.result?.verdict ?? "尚未判定")}</b> · 构建（${d.session.result?.buildVerification?.verified?"已核验":"已声明，未验证"}）${esc(d.session.buildId)}${d.session.terminationReason ? ` · 结束原因：${esc(d.session.terminationReason)}` : ""}</p></div>
      <div>${["QUEUED","RUNNING"].includes(d.session.status) ? `<form method="post" action="/v2/sessions/${esc(id)}/pause"><button type="submit">暂停</button></form>` : d.session.status === "PAUSED" ? `<form method="post" action="/v2/sessions/${esc(id)}/resume"><button type="submit">继续（保留原标准和预算）</button></form>` : ""}${["QUEUED", "RUNNING", "WAITING_HUMAN", "PAUSED"].includes(d.session.status) ? `<form method="post" action="/v2/sessions/${esc(id)}/cancel"><button type="submit" class="danger">取消会话</button></form>` : ""}</div></div>
      ${["QUEUED","PREPARING","RUNNING"].includes(d.session.status) ? `<p class="muted">运行记录每 3 秒更新；暂停或结束后停止刷新。</p><script>setTimeout(()=>location.reload(),3000)</script>` : ""}
      ${d.reportVerdict === "review" && !d.evidenceComplete ? `<p class="error-box">证据缺失或校验失败，当前报告需要复核。历史执行结论仍保留。</p>` : ""}
      ${d.session.result?.checks?`<section class="card"><h2>业务断言</h2><p>业务预期固定在批准版本；操作完成不会直接变成验收通过。</p><ul>${d.session.result.checks.map(c=>`<li><b>${esc(c.verdict)}</b> · ${esc(c.assertionId)} · ${esc(JSON.stringify(c.actual))} ${esc(c.reason??'')}</li>`).join('')}</ul><p><a href="/space/${esc(d.session.projectId)}/findings">查看缺陷与复测 →</a></p></section>`:''}
      <section class="card"><h2>循环阶段（真实事件）</h2>
      ${attempts ? `<table><thead><tr><th>轮次</th><th>阶段</th><th>状态</th><th>决策依据</th></tr></thead><tbody>${attempts}</tbody></table>` : `<div class="empty-state">尚无阶段记录。</div>`}
      </section>
      <section class="card"><h2>调用账本（intent → receipt）</h2>
      ${invocations ? `<table><thead><tr><th>意图</th><th>尝试</th><th>状态</th><th>回执</th></tr></thead><tbody>${invocations}</tbody></table>` : `<div class="empty-state">尚无调用。</div>`}
      </section>
      <p><a class="primary-link" href="/space/${esc(d.session.projectId)}/autonomous">← 会话列表</a></p>`;
      return reply.type("text/html").send(layout("会话详情", body));
    } catch (e) {
      return reply.code(502).send(layout("错误", `<div class="error-box">${esc((e as Error).message)}</div>`));
    }
  });

  for (const action of ["cancel", "pause", "resume"]) app.post(`/v2/sessions/:id/${action}`, async (req, reply) => {
    const s = sid(req);
    if (!s) return reply.redirect("/login");
    const { id } = req.params as { id: string };
    try {
      await api(`/api/v2/sessions/${encodeURIComponent(id)}/${action}`, { sid: s, method: "POST", body: {} });
    } catch { /* 已终态时展示原页面 */ }
    return reply.redirect(`/v2/sessions/${encodeURIComponent(id)}`);
  });
}
