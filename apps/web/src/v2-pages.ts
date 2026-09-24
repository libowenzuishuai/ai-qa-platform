import type { FastifyInstance } from "fastify";
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
      <p>目标驱动的执行循环：观察→规划→行动→验证→调整。当前为 script 规划器切片（确定性，显式标注；真实模型规划为后续切片）。</p></div></div>
      <section class="card"><h2>发起一次验收（合成草稿闭环）</h2>
      <p class="muted">目标固定为「创建草稿→改名→刷新仍保留名称」，以已批准的 Oracle 为标准。合成系统地址须在环境白名单内。</p>
      <form method="post" action="/space/${esc(id)}/autonomous">
        <label for="v2-goal">验收目标</label><input id="v2-goal" name="goal" required maxlength="2000" value="创建草稿→改名→刷新仍保留名称">
        <label for="v2-env">环境</label><select id="v2-env" name="environmentId" required>${envOptions}</select>
        <label for="v2-target">合成系统地址</label><input id="v2-target" name="targetBaseUrl" required placeholder="http://127.0.0.1:9300" value="http://127.0.0.1:9300">
        <label for="v2-oracle">Oracle（已批准标准）</label><input id="v2-oracle" name="oracleSpecId" required placeholder="从 Oracle 列表粘贴 id">
        <button type="submit">启动会话 →</button>
      </form></section>
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
        session: { id: string; goal: string; status: string; terminationReason: string | null; projectId: string; buildId: string };
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
      <p>状态 <b>${esc(d.session.status)}</b> · 构建 ${esc(d.session.buildId)}${d.session.terminationReason ? ` · 结束原因：${esc(d.session.terminationReason)}` : ""}</p></div>
      <div>${["QUEUED", "RUNNING", "WAITING_HUMAN", "PAUSED"].includes(d.session.status) ? `<form method="post" action="/v2/sessions/${esc(id)}/cancel"><button type="submit" class="danger">取消会话</button></form>` : ""}</div></div>
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

  app.post("/v2/sessions/:id/cancel", async (req, reply) => {
    const s = sid(req);
    if (!s) return reply.redirect("/login");
    const { id } = req.params as { id: string };
    try {
      await api(`/api/v2/sessions/${encodeURIComponent(id)}/cancel`, { sid: s, method: "POST", body: {} });
    } catch { /* 已终态时展示原页面 */ }
    return reply.redirect(`/v2/sessions/${encodeURIComponent(id)}`);
  });
}
