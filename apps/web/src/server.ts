import {registerAgentPages} from './agent-pages.js';
import {registerTemplateEditor} from './template-editor.js';
import {registerIntegrationPages} from './integrations.js';
import {registerDeliveryPages} from './delivery.js';
import {registerChangeReviewPages} from "./change-review.js";
import { registerPreparationPages } from './preparation.js';
import { registerProductPages } from "./product.js";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { registerWorkbenchRoutes } from "./workbench.js";
import formbody from "@fastify/formbody";
import { randomBytes } from "node:crypto";
import { API_BASE, ApiError, api } from "./api.js";
import {
  errorPage,
  launcherPage,
  layout,
  loginPage,
  projectsPage,
  reportPage,
  runDetailPage,
  type LauncherData,
  type ReportData,
  type RunDetailData,
} from "./pages.js";

/**
 * 最小运行页面（阶段 1 提示词 H）：
 * SSR 只调用平台 API；SSE 由 web 服务端代理（同源 EventSource），
 * 断线重连带 Last-Event-ID 由浏览器 EventSource 自动处理。
 */

const PORT = Number(process.env.WEB_PORT ?? 7100);
const HOST = process.env.WEB_HOST ?? "127.0.0.1";

const app = Fastify({ logger: { level: process.env.WEB_LOG_LEVEL ?? "warn" } });
// 容器健康检查端点：不鉴权、不触库，只证明进程在服务。
app.get("/healthz", async () => ({ ok: true }));
await app.register(cookie);
await app.register(formbody);
registerWorkbenchRoutes(app);
registerProductPages(app);
registerPreparationPages(app);
registerChangeReviewPages(app);
registerDeliveryPages(app);
registerAgentPages(app);
registerTemplateEditor(app);
registerIntegrationPages(app);

function sid(req: { cookies: Record<string, string | undefined> }): string | undefined {
  return req.cookies["web_sid"];
}

async function requireSid(req: { cookies: Record<string, string | undefined> }): Promise<string> {
  const s = sid(req);
  if (!s) throw new ApiError(401, "UNAUTHENTICATED", "未登录");
  return s;
}

function html(reply: import("fastify").FastifyReply, body: string, code = 200) {
  return reply.code(code).type("text/html; charset=utf-8").send(body);
}

app.get("/", async (req, reply) => {
  try {
    const s = await requireSid(req);
    const me = await api<{ displayName: string }>("/api/auth/me", { sid: s });
    const projects = await api<{ projects: Array<{ id: string; name: string; role: string }> }>(
      "/api/projects",
      { sid: s },
    );
    return html(reply, projectsPage(me.data.displayName, projects.data.projects));
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return reply.redirect("/login");
    return html(reply, errorPage(String(err)), 500);
  }
});

app.get("/login", async (_req, reply) => html(reply, loginPage()));

app.post("/login", async (req, reply) => {
  const body = req.body as { username?: string; password?: string };
  try {
    const response = await fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: body.username ?? "", password: body.password ?? "" }),
    });
    if (!response.ok) {
      const err = (await response.json().catch(() => ({}))) as { message?: string };
      return html(reply, loginPage(err.message ?? "登录失败"), 401);
    }
    const setCookie = response.headers.get("set-cookie") ?? "";
    const apiSid = /aiqa_sid=([^;]+)/.exec(setCookie)?.[1];
    if (!apiSid) return html(reply, loginPage("登录响应缺少会话"), 502);
    reply.setCookie("web_sid", apiSid, { path: "/", httpOnly: true, sameSite: "lax" });
    return reply.redirect("/");
  } catch (err) {
    return html(reply, loginPage(`API 不可达：${String(err)}`), 502);
  }
});

app.post("/logout", async (req, reply) => {
  const s = sid(req);
  if (s) await api("/api/auth/logout", { method: "POST", sid: s }).catch(() => undefined);
  reply.clearCookie("web_sid", { path: "/" });
  return reply.redirect("/login");
});

app.get("/projects/:id", async (req, reply) => {
  try {
    const s = await requireSid(req);
    const { id } = req.params as { id: string };
    const project = await api<{ name: string }>(`/api/projects/${id}`, { sid: s });
    const environments = await api<{ environments: Array<{ id: string; name: string; baseUrl: string; buildId: string | null }> }>(
      `/api/projects/${id}/environments`,
      { sid: s },
    );
    const baselines = await api<{ baselines: Array<{ id: string; name: string; active: boolean }> }>(
      `/api/projects/${id}/baselines`,
      { sid: s },
    );
    const cases = await api<{ caseVersions: Array<{ caseVersionId: string; title: string; approvalStatus: string; hasPlan: boolean }> }>(
      `/api/projects/${id}/case-versions`,
      { sid: s },
    );
    const runs = await api<{ runs: Array<{ id: string; lifecycle: string; acceptanceStatus: string; createdAt: string }> }>(
      `/api/projects/${id}/run-summaries`,
      { sid: s },
    );
    const data: LauncherData = {
      project: { id, name: project.data.name },
      environments: environments.data.environments,
      baselines: baselines.data.baselines,
      caseVersions: cases.data.caseVersions,
      runs: runs.data.runs,
    };
    return html(reply, launcherPage(data));
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return reply.redirect("/login");
    return html(reply, errorPage(err instanceof Error ? err.message : String(err)), 500);
  }
});

app.post("/projects/:id/seed", async (req, reply) => {
  try {
    const s = await requireSid(req);
    const { id } = req.params as { id: string };
    const body = req.body as { environmentId?: string };
    if (!body.environmentId) {
      return html(reply, errorPage("请先在页面上选择环境（种子需要环境）"), 422);
    }
    await api(`/api/projects/${id}/seed-fixed-assets`, {
      method: "POST",
      sid: s,
      body: { environmentId: body.environmentId },
    });
    return reply.redirect(`/projects/${id}`);
  } catch (err) {
    return html(reply, errorPage(err instanceof Error ? err.message : String(err)), 500);
  }
});

app.post("/projects/:id/start", async (req, reply) => {
  try {
    const s = await requireSid(req);
    const { id } = req.params as { id: string };
    const raw = req.body as Record<string, unknown>;
    const caseVersionIds = Array.isArray(raw.caseVersionIds)
      ? (raw.caseVersionIds as string[])
      : raw.caseVersionIds
        ? [String(raw.caseVersionIds)]
        : [];
    const created = await api<{ runId: string }>("/api/runs", {
      method: "POST",
      sid: s,
      body: {
        projectId: id,
        baselineId: String(raw.baselineId ?? ""),
        environmentId: String(raw.environmentId ?? ""),
        caseVersionIds,
        buildId: raw.buildId ? String(raw.buildId) : undefined,
        mode: "real",
        idempotencyKey: `web-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
      },
    });
    return reply.redirect(`/runs/${created.data.runId}`);
  } catch (err) {
    if (err instanceof ApiError) {
      return html(reply, errorPage(`${err.message}${err.details ? `（${JSON.stringify(err.details)}）` : ""}`), err.status);
    }
    return html(reply, errorPage(String(err)), 500);
  }
});

app.get("/runs", async (req, reply) => {
  try {
    const s = await requireSid(req);
    const projectId = (req.query as { projectId?: string }).projectId;
    const projects = await api<{ projects: Array<{ id: string; name: string }> }>("/api/projects", { sid: s });
    const first = projectId ?? projects.data.projects[0]?.id;
    if (!first) return html(reply, errorPage("暂无项目"));
    const runs = await api<{ runs: Array<{ id: string; lifecycle: string; acceptanceStatus: string; createdAt: string }> }>(
      `/api/runs?projectId=${first}`,
      { sid: s },
    );
    const rows = runs.data.runs
      .map(
        (r) =>
          `<tr><td><a href="/runs/${r.id}">${r.id.slice(0, 14)}…</a></td>
          <td><span class="badge ${r.lifecycle}">${r.lifecycle}</span></td>
          <td><span class="badge ${r.acceptanceStatus}">${r.acceptanceStatus}</span></td>
          <td class="muted">${r.createdAt.replace("T", " ").slice(0, 19)}</td>
          <td><a href="/runs/${r.id}/report">报告</a></td></tr>`,
      )
      .join("");
    return html(
      reply,
      launcherRuns(`运行列表（项目 ${first.slice(0, 8)}…）`, rows),
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return reply.redirect("/login");
    return html(reply, errorPage(String(err)), 500);
  }
});

function launcherRuns(title: string, rows: string): string {
  return layout(
    title,
    `<h1>${title}</h1><table><thead><tr><th>运行</th><th>生命周期</th><th>严格验收</th><th>创建时间</th><th></th></tr></thead><tbody>${rows || "<tr><td colspan=5>暂无</td></tr>"}</tbody></table>`,
  );
}

app.get("/runs/:id", async (req, reply) => {
  try {
    const s = await requireSid(req);
    const { id } = req.params as { id: string };
    const detail = await api<RunDetailData>(`/api/runs/${id}`, { sid: s });
    return html(reply, runDetailPage(detail.data));
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return reply.redirect("/login");
    return html(reply, errorPage(err instanceof Error ? err.message : String(err)), err instanceof ApiError ? err.status : 500);
  }
});

app.post("/runs/:id/cancel", async (req, reply) => {
  try {
    const s = await requireSid(req);
    const { id } = req.params as { id: string };
    await api(`/api/runs/${id}/cancel`, { method: "POST", sid: s });
    return reply.redirect(`/runs/${id}`);
  } catch (err) {
    return html(reply, errorPage(err instanceof Error ? err.message : String(err)), 500);
  }
});

app.get("/runs/:id/report", async (req, reply) => {
  try {
    const s = await requireSid(req);
    const { id } = req.params as { id: string };
    const report = await api<ReportData>(`/api/runs/${id}/report`, { sid: s });
    // 证据 URL 改走 web 同源代理（API 路径浏览器不可达）。
    const data = JSON.parse(
      JSON.stringify(report.data).replaceAll("/api/artifacts/", "/artifacts/"),
    ) as ReportData;
    return html(reply, reportPage(data));
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return reply.redirect("/login");
    return html(reply, errorPage(err instanceof Error ? err.message : String(err)), err instanceof ApiError ? err.status : 500);
  }
});

// 证据代理（同源 <img>/下载；鉴权由 API 完成）。
app.get("/artifacts/:id", async (req, reply) => {
  const s = sid(req);
  if (!s) return reply.redirect("/login");
  const { id } = req.params as { id: string };
  const response = await fetch(`${API_BASE}/api/artifacts/${id}`, {
    headers: { cookie: `aiqa_sid=${s}` },
  });
  if (!response.ok || !response.body) {
    return reply.code(response.status).type("text/plain; charset=utf-8").send(`证据不可用（HTTP ${response.status}）`);
  }
  reply.header("content-type", response.headers.get("content-type") ?? "application/octet-stream");
  if (response.headers.get("content-disposition")) {
    reply.header("content-disposition", response.headers.get("content-disposition")!);
  }
  return reply.send(response.body);
});

// SSE 代理（同源 EventSource → API）。
app.get("/api/runs/:id/events", async (req, reply) => {
  const s = sid(req);
  if (!s) return reply.code(401).send({ code: "UNAUTHENTICATED", message: "未登录" });
  const { id } = req.params as { id: string };
  const lastEventId = req.headers["last-event-id"];
  const url = new URL(`${API_BASE}/api/runs/${id}/events`);
  if (lastEventId) url.searchParams.set("lastEventId", String(lastEventId));
  const upstream = await fetch(url, { headers: { cookie: `aiqa_sid=${s}`, accept: "text/event-stream" } });
  if (!upstream.ok || !upstream.body) {
    return reply.code(upstream.status).send({ code: "UPSTREAM_ERROR", message: `SSE 上游 ${upstream.status}` });
  }
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  const reader = upstream.body.getReader();
  const pump = async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        reply.raw.write(Buffer.from(value));
      }
    } catch {
      /* 客户端断开 */
    }
    reply.raw.end();
  };
  void pump();
  return reply;
});

const address = await app.listen({ port: PORT, host: HOST });
console.log(`web ready on ${address}`);
