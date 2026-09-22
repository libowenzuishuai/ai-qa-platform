import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { api, ApiError } from "./api.js";
import { layout, errorPage } from "./pages.js";
const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const input = (name: string, label: string, value = "", required = true) =>
  `<label>${esc(label)}<input name="${name}" type="text" value="${esc(value)}" ${required ? "required" : ""}></label>`;
const select = (
  name: string,
  label: string,
  rows: any[],
  labelFn = (r: any) => r.name,
) =>
  `<label>${esc(label)}<select name="${name}" required>${rows.map((r) => `<option value="${esc(r.id)}">${esc(labelFn(r))}</option>`).join("")}</select></label>`;
const locatorFields = (prefix: string, label: string, required = true) =>
  `<fieldset><legend>${esc(label)}</legend><label>定位方式<select name="${prefix}Type"><option value="testId">测试标识</option><option value="label">输入框标签</option><option value="text">页面文字</option><option value="role">控件类型与名称</option></select></label>${input(prefix + "Target", "标识或精确文字", "", required)}${input(prefix + "Role", "控件类型（仅最后一种方式使用，例如 button、textbox）", "", false)}</fieldset>`;
const hidden = (key: string, value: unknown) =>
  `<input type="hidden" name="${key}" value="${esc(value)}">`;
const states: Record<string, string> = {
  PASS: "检查通过",
  NEVER_CHECKED: "尚未检查",
  QUEUED: "排队中",
  RUNNING: "进行中",
  WAITING_HUMAN: "等待审阅",
  COMPLETED: "流程已完成",
  FAILED: "处理失败",
  CANCELLED: "已取消",
  FAIL_INVALID_CREDENTIALS: "账号认证失败",
  FAIL_MISSING_ENV: "凭据尚未配置",
  FAIL_LOCATOR_NOT_FOUND: "未找到登录控件",
  FAIL_SITE_UNREACHABLE: "页面不可达",
  FAIL_TIMEOUT: "检查超时",
  FAIL_INTERACTIVE_AUTH_REQUIRED: "需要人工认证",
  ERROR: "检查异常",
  pending: "准备中",
  success: "已准备",
  unknown: "状态待核对",
  cleaning: "清理中",
  cleaned: "已清理",
  cleanup_failed: "清理失败",
  queued: "待开始",
  running: "处理中",
  completed: "已完成",
  skipped: "复用已有资产",
  waiting_human: "等待确认",
  failed: "未完成",
};
const badge = (status: string) =>
  `<span class="badge ${esc(status)}">${esc(states[status] ?? status)}</span>`;
const nodeNames: Record<string, string> = {
  document_parse: "解析需求资料",
  rule_suggest: "提取业务规则",
  rule_approval_gate: "审阅业务规则",
  case_suggest: "设计测试用例",
  case_approval_gate: "审阅测试用例",
  page_observation: "观察测试页面",
  plan_proposal_gate: "审阅执行计划",
  preparation_check: "检查账号与准备",
  execution: "执行自动化测试",
  evaluation: "生成交付评估",
};
function fail(reply: any, error: unknown) {
  return reply
    .code(error instanceof ApiError ? error.status : 400)
    .type("text/html")
    .send(errorPage(error instanceof Error ? error.message : "请求失败"));
}
export function registerPreparationPages(app: FastifyInstance) {
  app.get("/preparation/:id", async (req, reply) => {
    const sid = req.cookies.web_sid;
    if (!sid) return reply.redirect("/login");
    const { id } = req.params as { id: string };
    const base = `/preparation/${encodeURIComponent(id)}`;
    try {
      const [
        { data: d },
        { data: summary },
        { data: plugins },
        { data: ledger },
      ] = await Promise.all([
        api<any>(`/api/projects/${id}/workspace`, { sid }),
        api<any>(`/api/projects/${id}/preparation-summary`, { sid }),
        api<any>(`/api/projects/${id}/data-plugins`, { sid }),
        api<any>(`/api/projects/${id}/data-resources`, { sid }),
      ]);
      const form = (action: string, fields: string, button: string) =>
        `<form method="post" action="${base}/${action}">${fields}<button>${button}</button></form>`;
      const roles = summary.environments.flatMap((e: any) => e.roles);
      const body = `<header class="page-heading"><div><span class="eyebrow">TEST READINESS</span><h1>准备中心</h1><p>让账号、环境和测试数据在执行前准备就绪。</p></div><a href="/workflows/project/${esc(id)}" class="primary-link">创建测试工作流 →</a></header>
      <div class="metric-grid"><div class="metric"><span class="metric-label">测试环境</span><b class="metric-value">${summary.environments.length}</b></div><div class="metric"><span class="metric-label">有效账号检查</span><b class="metric-value">${roles.filter((r: any) => r.valid).length}<small> / ${roles.length}</small></b></div><div class="metric"><span class="metric-label">数据准备方案</span><b class="metric-value">${plugins.plugins.length}</b></div><div class="metric" data-tone="warning"><span class="metric-label">待核对 / 清理</span><b class="metric-value">${ledger.resources.filter((r: any) => ["unknown", "cleanup_failed", "success"].includes(r.status)).length}</b></div></div>
      <section class="card"><div class="panel-title"><h2>账号与环境</h2><a href="/space/${esc(id)}?tab=integrations">登记账号引用 →</a></div>${summary.environments.map((e: any) => `<article><h3>${esc(e.name)} <small>配置版本 ${e.revision}</small></h3><p class="muted">${esc(e.baseUrl)} · ${e.buildConfigured ? "已配置构建核验" : "尚未配置构建核验"}</p>${e.roles.length ? e.roles.map((r: any) => `<div class="action-row"><div><b>${esc(r.role)}</b><p>${r.expired ? "上次通过已过期，请重新检查" : r.valid ? "检查有效" : esc(states[r.status] ?? r.status)}</p></div>${r.configured ? form("check", hidden("environmentId", e.id) + hidden("role", r.role), "检查登录") : ""}${r.lastCheckJobId ? `<a href="/jobs/${esc(r.lastCheckJobId)}">检查详情</a>` : ""}</div>`).join("") : '<p class="empty-state">还没有登记测试账号引用。</p>'}</article>`).join("") || '<p class="empty-state">先在项目空间登记测试环境。</p>'}</section>
      <details class="card"><summary>配置登录步骤</summary><p>用于常见的用户名、密码、提交按钮登录。选择控件的标签、文字、类型或测试标识，使用已登记的账号引用，不在页面保存密码。保存后需重新检查，并重新批准受影响的执行计划。</p>${form("login", select("environmentId", "测试环境", d.environments) + input("role", "测试角色", "tester") + input("credentialRef", "已登记的账号引用", "tester") + input("loginPath", "登录页面路径", "/login") + locatorFields("username", "用户名输入框") + locatorFields("password", "密码输入框") + locatorFields("submit", "登录按钮") + locatorFields("success", "成功标识") + input("successText", "成功标识文字（可选）", "", false) + locatorFields("invalid", "认证失败标识（可选）", false) + locatorFields("interactive", "验证码或二次认证标识（可选）", false), "保存登录配置")}</details>
      <section class="card"><h2>数据准备方案</h2><p class="muted">每次准备分配独立资源。清理只针对台账中的资源，不允许全库或全环境操作。</p>${
        plugins.plugins
          .map(
            (p: any) =>
              `<details><summary>${esc(p.name)} · 版本 ${p.version}</summary>${form(
                "prepare",
                hidden("pluginId", p.id) +
                  hidden("idempotencyKey", randomUUID()) +
                  Object.entries(p.paramSchema?.properties ?? {})
                    .map(([key, def]: any) =>
                      input(
                        `parameter.${key}`,
                        `${key} (${def.type})`,
                        "",
                        (p.paramSchema.required ?? []).includes(key),
                      ),
                    )
                    .join(""),
                "准备独立数据",
              )}</details>`,
          )
          .join("") ||
        '<p class="empty-state">还没有数据准备方案。管理员可登记下方的专用测试接口。</p>'
      }</section>
      <details class="card"><summary>登记数据准备接口（管理员）</summary><p>接口必须接受平台分配的 resourceId、namespace 和 parameters，并按同一资源 ID 提供查询与删除。路径中的 {resourceId} 由平台填写。</p>${form("plugin", select("environmentId", "测试环境", d.environments) + input("name", "方案名称") + input("preparePath", "创建路径", "/test-resources") + input("inspectPath", "查询路径", "/test-resources/{resourceId}") + input("cleanupPath", "清理路径", "/test-resources/{resourceId}") + input("parameterNames", "可选文本参数名（逗号分隔）", "", false) + '<label><input type="checkbox" name="allow404" value="true">该接口的 404 明确表示资源不存在</label>', "登记方案")}</details>
      <section class="card"><h2>资源台账</h2><div class="table-wrap"><table><thead><tr><th>资源</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${ledger.resources.map((r: any) => `<tr><td>${esc(plugins.plugins.find((p: any) => p.id === r.pluginId)?.name ?? "数据资源")}<small>${esc(r.externalRef)}</small>${r.runId ? `<a href="/runs/${esc(r.runId)}">所属测试运行</a>` : ""}</td><td>${badge(r.status)}<small>${esc(r.detail)}</small>${r.evidenceId ? `<a href="/artifacts/${esc(r.evidenceId)}">查看证据</a>` : ""}</td><td>${esc(new Date(r.createdAt).toLocaleString("zh-CN"))}</td><td>${!["cleaned", "pending", "cleaning"].includes(r.status) ? form("inspect", hidden("pluginId", r.pluginId) + hidden("resourceId", r.id), "核对资源") + form("cleanup", hidden("pluginId", r.pluginId) + hidden("resourceId", r.id), "清理此资源") : ""}</td></tr>`).join("")}</tbody></table></div>${!ledger.resources.length ? '<p class="empty-state">尚未创建测试数据。</p>' : ""}</section>`;
      return reply.type("text/html").send(
        layout("准备中心", body, {
          projectId: id,
          projectName: d.project.name,
          activeTab: "preparation",
        }),
      );
    } catch (e) {
      return fail(reply, e);
    }
  });
  app.post("/preparation/:id/:action", async (req, reply) => {
    const sid = req.cookies.web_sid;
    if (!sid) return reply.redirect("/login");
    const { id, action } = req.params as { id: string; action: string };
    const b = req.body as Record<string, string>;
    try {
      let path = "",
        method = "POST",
        body: any = {};
      const base = `/api/projects/${encodeURIComponent(id)}`;
      const locator = (prefix: string) =>
        b[prefix + "Type"] === "role"
          ? {
              type: "role",
              role: b[prefix + "Role"],
              name: b[prefix + "Target"],
            }
          : {
              type: b[prefix + "Type"] || "testId",
              value: b[prefix + "Target"],
            };
      if (action === "login") {
        path = `${base}/environments/${encodeURIComponent(b.environmentId!)}/login-preparations/${encodeURIComponent(b.role!)}`;
        method = "PUT";
        body = {
          credentialRef: b.credentialRef,
          loginPath: b.loginPath,
          steps: [
            {
              type: "fill",
              locator: locator("username"),
              value: {
                source: "credential",
                ref: `${b.credentialRef}.username`,
              },
            },
            {
              type: "fill",
              locator: locator("password"),
              value: {
                source: "credential",
                ref: `${b.credentialRef}.password`,
              },
            },
            {
              type: "click",
              locator: locator("submit"),
            },
          ],
          successIndicator: {
            locator: locator("success"),
            ...(b.successText ? { expectedText: b.successText } : {}),
          },
          ...(b.invalidTarget ? { invalidIndicator: locator("invalid") } : {}),
          ...(b.interactiveTarget
            ? {
                interactiveIndicator: {
                  type: "testId",
                  value: b.interactiveTarget,
                },
              }
            : {}),
        };
      } else if (action === "check")
        path = `${base}/environments/${encodeURIComponent(b.environmentId!)}/login-preparations/${encodeURIComponent(b.role!)}/check`;
      else if (action === "plugin") {
        path = `${base}/data-plugins`;
        body = {
          name: b.name,
          kind: "http-request",
          environmentId: b.environmentId,
          definition: {
            prepare: { method: "POST", path: b.preparePath },
            inspect: { method: "GET", path: b.inspectPath },
            cleanup: {
              method: "DELETE",
              path: b.cleanupPath,
              allow404: b.allow404 === "true",
            },
          },
          paramSchema: {
            type: "object",
            properties: Object.fromEntries(
              (b.parameterNames ?? "")
                .split(",")
                .map((v) => v.trim())
                .filter(Boolean)
                .map((v) => [v, { type: "string" }]),
            ),
            required: [],
          },
        };
      } else if (["prepare", "inspect", "cleanup"].includes(action)) {
        path = `${base}/data-plugins/${encodeURIComponent(b.pluginId!)}/${action}`;
        if (action === "prepare") {
          const { data } = await api<any>(`${base}/data-plugins`, { sid });
          const p = data.plugins.find((x: any) => x.id === b.pluginId);
          if (!p) throw new Error("数据方案不存在");
          const params: Record<string, unknown> = {};
          for (const [key, def] of Object.entries(
            p.paramSchema.properties,
          ) as any) {
            const raw = b[`parameter.${key}`];
            if (raw === undefined || raw === "") continue;
            params[key] =
              def.type === "number"
                ? Number(raw)
                : def.type === "boolean"
                  ? raw === "true"
                  : raw;
          }
          body = { idempotencyKey: b.idempotencyKey, params };
        } else body = { resourceIds: [b.resourceId] };
      } else throw new Error("不支持的操作");
      const { data } = await api<any>(path, { sid, method, body });
      return reply.redirect(
        data.jobId ? `/jobs/${data.jobId}` : `/preparation/${id}`,
      );
    } catch (e) {
      return fail(reply, e);
    }
  });
  app.get("/workflows/project/:id", async (req, reply) => {
    const sid = req.cookies.web_sid;
    if (!sid) return reply.redirect("/login");
    const { id } = req.params as { id: string };
    const page=Math.max(1,Number((req.query as any).page)||1);
    try {
      const [{ data: d }, { data: w }, { data: docs }] = await Promise.all([
        api<any>(`/api/projects/${id}/workspace`, { sid }),
        api<any>(`/api/projects/${id}/workflows?page=${page}`, { sid }),
        api<any>(`/api/projects/${id}/documents`, { sid }),
      ]);
      const versions = docs.documents.flatMap((d: any) =>
        d.versions.map((v: any) => ({
          id: v.id,
          name: `${d.title} · v${v.version}`,
        })),
      );
      return reply.type("text/html").send(
        layout(
          "测试工作流",
          `<header class="page-heading"><div><span class="eyebrow">AUTONOMOUS TESTING</span><h1>测试工作流</h1><p>从需求到评估，逐步推进；关键验收标准由人审阅。</p></div><a href="/preparation/${esc(id)}">检查准备情况 →</a></header><div class="dashboard-grid"><section class="card"><h2>创建工作流</h2><form method="post" action="/workflows/project/${esc(id)}">${hidden("idempotencyKey", randomUUID())}${select("environmentId", "测试环境", d.environments)}<label>使用已有验收基线<select name="baselineId"><option value="">从需求资料开始</option>${d.baselines.map((b: any) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join("")}</select></label><fieldset><legend>需求资料（选择基线时无需勾选）</legend>${versions.map((v: any) => `<label><input type="checkbox" name="documentVersionIds" value="${esc(v.id)}">${esc(v.name)}</label>`).join("") || "还没有资料，请先上传。"}</fieldset>${input("buildId", "本次构建版本", "", false)}${input("role", "观察页面的角色", "visitor")}${input("path", "观察页面路径", "/")}<label>最长持续时间（分钟）<input name="minutes" type="number" min="1" max="1440" value="60" required></label><p class="muted">时间包含等待人工审阅。模型预算使用保守预留，额度不足时停止，不自动追加。</p><button>开始工作流</button></form></section><section class="card"><h2>最近的工作流</h2>${w.workflows.map((x: any) => `<article><h3><a href="/workflows/${esc(x.id)}">${esc(new Date(x.createdAt).toLocaleString("zh-CN"))}</a></h3>${badge(x.status)}<p>${esc(nodeNames[x.currentGate] ?? "查看执行进度与证据")}</p></article>`).join("") || '<p class="empty-state">创建第一个工作流，持续跟踪测试进度。</p>'}<nav><p>共 ${w.total} 次 · 第 ${page} 页</p>${page>1?`<a href="?page=${page-1}">上一页</a>`:""} ${page*w.pageSize<w.total?`<a href="?page=${page+1}">下一页</a>`:""}</nav></section></div>`,
          {
            projectId: id,
            projectName: d.project.name,
            activeTab: "workflows",
          },
        ),
      );
    } catch (e) {
      return fail(reply, e);
    }
  });
  app.post("/workflows/project/:id", async (req, reply) => {
    const sid = req.cookies.web_sid;
    if (!sid) return reply.redirect("/login");
    const { id } = req.params as { id: string };
    const b = req.body as any;
    try {
      const { data } = await api<any>(`/api/projects/${id}/workflows`, {
        sid,
        method: "POST",
        body: {
          idempotencyKey: b.idempotencyKey,
          templateVersion: "v1",
          inputs: {
            environmentId: b.environmentId,
            ...(b.baselineId
              ? { baselineId: b.baselineId }
              : {
                  documentVersionIds: Array.isArray(b.documentVersionIds)
                    ? b.documentVersionIds
                    : b.documentVersionIds
                      ? [b.documentVersionIds]
                      : [],
                  observationPages: [{ role: b.role, path: b.path }],
                }),
            ...(b.buildId ? { buildId: b.buildId } : {}),
          },
          budget: { maxWallClockMs: Number(b.minutes) * 60000 },
        },
      });
      return reply.redirect(`/workflows/${data.workflowId}`);
    } catch (e) {
      return fail(reply, e);
    }
  });
  app.get("/workflows/:id", async (req, reply) => {
    const sid = req.cookies.web_sid;
    if (!sid) return reply.redirect("/login");
    const { id } = req.params as { id: string };
    try {
      const { data: w } = await api<any>(`/api/workflows/${id}`, { sid });
      const active = ["RUNNING", "QUEUED"].includes(w.status);
      const body = `${active ? '<meta http-equiv="refresh" content="5">' : ""}<header class="page-heading"><div><span class="eyebrow">WORKFLOW RUN</span><h1>工作流进度</h1><p>${badge(w.status)} · ${w.nodes.filter((n: any) => ["completed", "skipped"].includes(n.status)).length} / ${w.nodes.length} 步</p></div><a href="/workflows/project/${esc(w.projectId)}">返回工作流</a></header><section class="card"><p>流程完成表示各步骤处理结束，业务是否通过请以最终评估为准。</p><p class="muted">工具作业：${w.usage?.toolCalls ?? 0} · 模型调用预留：${w.usage?.modelCallsReserved ?? 0} / ${w.budget.maxModelCalls} · Token 预留：${w.usage?.tokensReserved ?? 0} / ${w.budget.maxTokens}</p></section><ol class="journey">${w.nodes.map((n: any) => `<li data-done="${["completed", "skipped"].includes(n.status)}"><b>${esc(nodeNames[n.nodeKey]??n.nodeKey)}</b> ${badge(n.status)}${n.error ? `<p class="error-box">${esc(n.error)}</p>` : ""}${(n.outputRef?.jobIds ?? []).map((jobId: string) => `<p><a href="/jobs/${esc(jobId)}">查看作业结果 →</a></p>`).join("")}${(n.outputRef?.caseVersionIds ?? []).map((caseId: string) => `<p><a href="/cases/${esc(caseId)}">审阅用例 →</a></p>`).join("")}${(n.outputRef?.proposalIds ?? []).map((proposalId: string) => `<p><a href="/proposals/${esc(proposalId)}">审阅执行计划 →</a></p>`).join("")}${n.outputRef?.runId ? `<p><a href="/runs/${esc(n.outputRef.runId)}">查看真实运行与报告 →</a> ${n.outputRef.acceptanceStatus ? badge(n.outputRef.acceptanceStatus) : ""}</p>` : ""}${n.status === "waiting_human" ? `<section class="card"><p>${esc(n.humanTodo?.description)}</p><a href="/projects/${esc(w.projectId)}/review">审阅规则与处理澄清 →</a><form method="post" action="/workflows/${esc(id)}/confirm">${hidden("nodeKey", n.nodeKey)}<button name="decision" value="approve">已完成审阅，继续</button> <button class="danger" name="decision" value="reject">终止此流程</button></form></section>` : ""}</li>`).join("")}</ol>${!["COMPLETED", "FAILED", "CANCELLED"].includes(w.status) ? `<form method="post" action="/workflows/${esc(id)}/cancel"><button class="danger">取消工作流</button></form>` : ""}`;
      return reply.type("text/html").send(
        layout("工作流进度", body, {
          projectId: w.projectId,
          activeTab: "workflows",
        }),
      );
    } catch (e) {
      return fail(reply, e);
    }
  });
  for (const action of ["cancel", "confirm"])
    app.post(`/workflows/:id/${action}`, async (req, reply) => {
      const sid = req.cookies.web_sid;
      if (!sid) return reply.redirect("/login");
      const { id } = req.params as { id: string };
      const b = req.body as any;
      try {
        await api(
          `/api/workflows/${id}/${action === "confirm" ? `nodes/${encodeURIComponent(b.nodeKey)}/confirm` : "cancel"}`,
          {
            sid,
            method: "POST",
            body: action === "confirm" ? { decision: b.decision } : {},
          },
        );
        return reply.redirect(`/workflows/${id}`);
      } catch (e) {
        return fail(reply, e);
      }
    });
}
