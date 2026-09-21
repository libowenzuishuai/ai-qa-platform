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
const h = (name: string, value: unknown) =>
  `<input type="hidden" name="${name}" value="${esc(value)}">`;
const field = (name: string, label: string, value = "", required = true) =>
  `<label>${esc(label)}<input type="text" name="${name}" value="${esc(value)}" ${required ? "required" : ""}></label>`;
const area = (name: string, label: string, value = "") =>
  `<label>${esc(label)}<textarea name="${name}" required>${esc(value)}</textarea></label>`;
const options = (rows: any[], label: (r: any) => string) =>
  rows
    .map((r) => `<option value="${esc(r.id)}">${esc(label(r))}</option>`)
    .join("");
const quality = (v: unknown) =>
  ({ GOOD: "来源清晰", LOW: "来源质量较低", UNPARSED: "尚未解析" })[
    String(v)
  ] ?? "";
const status: Record<string, string> = {
  QUEUED: "排队中",
  RUNNING: "分析中",
  SUCCEEDED: "分析完成",
  FAILED: "分析失败",
  CANCELLED: "已取消",
};
function fail(reply: any, error: unknown) {
  return reply
    .code(error instanceof ApiError ? error.status : 500)
    .type("text/html")
    .send(errorPage(error instanceof Error ? error.message : "请求失败"));
}
export function registerChangeReviewPages(app: FastifyInstance) {
  app.get("/projects/:id/changes", async (req, reply) => {
    const sid = req.cookies.web_sid;
    if (!sid) return reply.redirect("/login");
    const { id } = req.params as { id: string };
    try {
      const page = Math.max(1, Number((req.query as any).page) || 1);
      const { data } = await api<any>(
        `/api/projects/${encodeURIComponent(id)}/changes?page=${page}`,
        { sid },
      );
      const versions = data.documents.flatMap((d: any) =>
        d.versions.map((v: any) => ({ ...v, title: d.title })),
      );
      return reply.type("text/html").send(
        layout(
          "需求变更",
          `<header class="page-head"><div><p class="eyebrow">产品上下文 · 需求变更</p><h1>这次需求更新，影响了什么？</h1><p>比较已解析的版本，保留原始标准，逐项确认后建立新版验收范围。</p></div><a class="button" href="/projects/${esc(id)}/review">上传新版资料</a></header>
      <section class="card"><h2>开始分析</h2><p>选择同一资料的旧版和新版；当前可选择最近 ${data.selectionLimit} 份资料与基线。</p><form method="post" action="/projects/${esc(id)}/changes">${h("idempotencyKey", randomUUID())}<label>验收基线<select name="baselineId" required>${options(data.baselines, (r) => r.name)}</select></label><label>旧资料版本<select name="oldDocumentVersionId" required>${options(versions, (r) => `${r.title} · v${r.version}`)}</select></label><label>新资料版本<select name="newDocumentVersionId" required>${options(versions, (r) => `${r.title} · v${r.version}`)}</select></label><button ${!versions.length || !data.baselines.length ? "disabled" : ""}>分析影响</button></form></section>
      <section class="card"><h2>分析记录 <small>共 ${data.total} 次</small></h2>${data.reviews.map((r: any) => `<article><a href="/changes/${esc(r.id)}">${esc(new Date(r.createdAt).toLocaleString("zh-CN"))}</a> · ${status[r.job.status] ?? esc(r.job.status)}${r.job.error ? `<p>${esc(r.job.error.message)}</p>` : ""}</article>`).join("") || "<p>还没有变更记录。上传新版资料后即可比较。</p>"}${page > 1 ? `<a href="?page=${page - 1}">上一页</a>` : ""}${page * 30 < data.total ? `<a href="?page=${page + 1}">下一页</a>` : ""}</section>`,
          { projectId: id },
        ),
      );
    } catch (error) {
      return fail(reply, error);
    }
  });
  app.post("/projects/:id/changes", async (req, reply) => {
    const sid = req.cookies.web_sid;
    if (!sid) return reply.redirect("/login");
    try {
      const { data } = await api<any>(
        `/api/projects/${encodeURIComponent((req.params as any).id)}/changes`,
        { sid, method: "POST", body: req.body },
      );
      return reply.redirect("/changes/" + data.reviewId);
    } catch (error) {
      return fail(reply, error);
    }
  });
  app.get("/changes/:id", async (req, reply) => {
    const sid = req.cookies.web_sid;
    if (!sid) return reply.redirect("/login");
    try {
      const { data: r } = await api<any>(
        "/api/changes/" + encodeURIComponent((req.params as any).id),
        { sid },
      );
      const out = r.output,
        active = ["QUEUED", "RUNNING"].includes(r.job.status),
        base = "/changes/" + esc(r.id);
      const ruleName = (id: string) =>
        r.input.approvedRuleVersions.find((x: any) => x.id === id)?.statement ??
        id;
      const caseName = (id: string) =>
        r.input.approvedCaseVersions.find((x: any) => x.id === id)?.title ?? id;
      const tasks = r.tasks
        .map((t: any) => {
          const decision = r.resolutions[t.key];
          const old = (
            t.assetType === "RULE"
              ? r.input.approvedRuleVersions
              : r.input.approvedCaseVersions
          ).find((x: any) => x.id === t.assetVersionId);
          const candidates = (
            t.assetType === "RULE" ? r.rules : r.cases
          ).filter(
            (x: any) =>
              x.supersedesId === t.assetVersionId &&
              (x.reviewStatus === "APPROVED" ||
                x.approvalStatus === "APPROVED"),
          );
          const name =
            t.assetType === "SOURCES"
              ? "新增内容与不确定来源"
              : t.assetType === "RULE"
                ? ruleName(t.assetVersionId)
                : caseName(t.assetVersionId);
          return `<article class="card"><h3>${esc(name)}</h3>${
            decision
              ? `<p>已确认：${decision.decision === "KEEP" ? "保留原标准" : "使用新版"} · ${esc(decision.reason)}</p>`
              : `
        ${t.assetType === "CASE" ? `<p><a href="/cases/${esc(t.assetVersionId)}">编辑并批准新版用例</a>；新用例需重新观察、生成和批准执行计划，旧计划仅供原标准复测。</p>` : ""}
        <form method="post" action="${base}/resolve">${h("assetType", t.assetType)}${h("assetVersionId", t.assetVersionId)}<label>处理决定<select name="decision"><option value="KEEP">保留原标准（说明原因）</option>${t.assetType !== "SOURCES" ? '<option value="REPLACED">采用已批准的新版本</option>' : ""}</select></label>${t.assetType !== "SOURCES" ? `<label>替换版本<select name="replacementVersionId"><option value="">保留时不选择</option>${options(candidates, (x) => `v${x.version} · ${x.statement ?? x.title}`)}</select></label>` : ""}${area("reason", "复核依据与处理说明")}<button>确认处理</button></form>
        ${t.assetType === "RULE" ? `<details><summary>修订规则并重新批准</summary><p>将生成草稿，不改动旧规则。结构化数值不自动沿用，请在业务字段中核对。</p><form method="post" action="${base}/revise-rule">${h("ruleVersionId", t.assetVersionId)}${area("statement", "规则说明", old.statement)}${field("role", "业务角色", old.role ?? "")}${area("action", "业务动作", old.action)}${area("expectation", "预期结果", old.expectation)}${field("precondition", "前置条件", old.precondition ?? "", false)}${field("condition", "触发条件", old.condition ?? "", false)}${field("forbidden", "禁止行为（用分号分隔）", (old.forbiddenBehaviors ?? []).join(";"), false)}${(old.businessFields ?? []).map((f: any, i: number) => `${h("bf" + i + "Key", f.key)}${h("bf" + i + "Type", typeof f.value)}${field("bf" + i + "Value", "业务数值：" + f.key, String(f.value ?? ""), false)}${field("bf" + i + "Unit", "单位", f.unit ?? "", false)}${field("bf" + i + "Operator", "比较方式（gt/gte/lt/lte/eq/neq）", f.operator ?? "", false)}`).join("")}<label>依据等级<select name="classification"><option value="EXPLICIT">原文明确规定</option><option value="INFERRED">根据资料推断</option><option value="UNKNOWN">依据尚不明确</option></select></label><fieldset><legend>选择新版原文依据</legend>${r.input.comparison.newBundle.spans.map((s: any) => `<label><input type="checkbox" name="sourceSpanIds" value="${esc(s.id)}" ${s.extractionQuality === "UNPARSED" ? "disabled" : ""}>${esc(s.quotedText ?? "未解析")} · ${esc(quality(s.extractionQuality))}</label>`).join("")}</fieldset>${area("reason", "修订原因")}<button>保存新规则草稿</button></form></details>` : ""}`
          }</article>`;
        })
        .join("");
      const changes = out?.sourceReport.changes
        .map(
          (c: any) =>
            `<article class="card"><h3>${({ added: "新增", removed: "删除", modified: "修改", uncertain: "待确认" } as any)[c.kind]}</h3><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px"><section><h4>旧版原文</h4><pre style="white-space:pre-wrap">${esc(c.old?.quotedText ?? "无对应片段")}</pre><small>${esc(quality(c.old?.extractionQuality))}</small></section><section><h4>新版原文</h4><pre style="white-space:pre-wrap">${esc(c.new?.quotedText ?? "未能唯一对应")}</pre><small>${esc(quality(c.new?.extractionQuality))}</small></section></div>${c.reason ? `<p>${esc(c.reason)}</p>` : ""}</article>`,
        )
        .join("");
      return reply.type("text/html").send(
        layout(
          "变更复核",
          `${active ? '<meta http-equiv="refresh" content="5">' : ""}<header class="page-head"><div><p class="eyebrow">需求变更 · 人工复核</p><h1>${status[r.job.status]}</h1><p>${r.job.request.mode === "mock" ? "包含模拟来源" : "已登记的真实来源"} · 确定性分析，不调用模型</p><p>待处理 ${r.pendingCount} 项。分析完成和复核完成均不代表测试通过。</p></div><a href="/projects/${esc(r.projectId)}/changes">返回变更记录</a></header>
      ${r.job.error ? `<section class="card"><h2>处理未完成</h2><p>${esc(r.job.error.message)}</p></section>` : ""}
      ${active ? `<form method="post" action="${base}/cancel"><button>取消分析</button></form>` : ""}${r.job.status === "FAILED" ? `<form method="post" action="${base}/retry"><button>重新分析固定输入</button></form>` : ""}
      ${out ? `<section><h2>来源对比</h2>${changes || "<p>未检测到片段变化。</p>"}</section><section><h2>复核待办</h2>${out.impact.unresolved.map((s: string) => `<p>${esc(s)}</p>`).join("")}${tasks || "<p>本次未发现与所选基线相交的规则。</p>"}</section><section class="card"><h2>确认新版验收范围</h2><p>保留所有未受影响项目，替换已确认的新版本。旧基线和历史执行不变。</p>${r.resolutions.BASELINE ? `<p>新版基线已保存。请到 <a href="/space/${esc(r.projectId)}?tab=missions">测试任务</a> 选择新版基线，补齐新计划后执行。</p>` : `<form method="post" action="${base}/baseline">${field("name", "新版基线名称")}<button ${r.pendingCount ? "disabled" : ""}>建立新版基线</button></form>`}</section><section class="card"><h2>按原标准验证修复</h2><p>选择旧运行及新构建，沿用旧断言和计划；不会使用修订后的宽松标准覆盖旧失败。</p><form method="post" action="${base}/retest">${h("idempotencyKey", randomUUID())}<label>原运行<select name="runId" required>${options(r.runs, (x) => `${x.buildId} · ${x.acceptanceStatus ?? x.lifecycle}`)}</select></label>${field("buildId", "修复后的新构建版本")}<button ${!r.runs.length ? "disabled" : ""}>发起原标准复测</button></form></section>` : ""}`,
          { projectId: r.projectId },
        ),
      );
    } catch (error) {
      return fail(reply, error);
    }
  });
  for (const action of [
    "resolve",
    "revise-rule",
    "baseline",
    "cancel",
    "retry",
    "retest",
  ])
    app.post("/changes/:id/" + action, async (req, reply) => {
      const sid = req.cookies.web_sid;
      if (!sid) return reply.redirect("/login");
      const id = (req.params as any).id;
      try {
        const { data: r } = await api<any>(
          "/api/changes/" + encodeURIComponent(id),
          { sid },
        );
        const body = { ...(req.body as any) };
        if (!body.replacementVersionId) delete body.replacementVersionId;
        let path = "/api/changes/" + encodeURIComponent(id) + "/" + action;
        if (action === "revise-rule") {
          body.forbiddenBehaviors = String(body.forbidden ?? "")
            .split(";")
            .map((x: string) => x.trim())
            .filter(Boolean);
          delete body.forbidden;
          body.businessFields = [];
          for (let i = 0; body["bf" + i + "Key"] !== undefined; i++) {
            const pre = "bf" + i;
            body.businessFields.push({
              key: body[pre + "Key"],
              value:
                body[pre + "Type"] === "number"
                  ? Number(body[pre + "Value"])
                  : body[pre + "Type"] === "boolean"
                    ? body[pre + "Value"] === "true"
                    : body[pre + "Value"],
              ...(body[pre + "Unit"] ? { unit: body[pre + "Unit"] } : {}),
              ...(body[pre + "Operator"]
                ? { operator: body[pre + "Operator"] }
                : {}),
            });
            for (const k of ["Key", "Type", "Value", "Unit", "Operator"])
              delete body[pre + k];
          }
          body.sourceSpanIds = Array.isArray(body.sourceSpanIds)
            ? body.sourceSpanIds
            : body.sourceSpanIds
              ? [body.sourceSpanIds]
              : [];
        }
        if (action === "cancel" || action === "retry")
          path = "/api/jobs/" + r.jobId + "/" + action;
        if (action === "retest") {
          if (!r.runs.some((x: any) => x.id === body.runId))
            throw new Error("请选择本次基线的旧运行");
          path = "/api/runs/" + encodeURIComponent(body.runId) + "/retest";
          delete body.runId;
        }
        const { data } = await api<any>(path, { sid, method: "POST", body });
        if (action === "retest") return reply.redirect("/runs/" + data.runId);
        if (action === "revise-rule")
          return reply.redirect("/projects/" + r.projectId + "/review");
        return reply.redirect("/changes/" + id);
      } catch (error) {
        return fail(reply, error);
      }
    });
}
