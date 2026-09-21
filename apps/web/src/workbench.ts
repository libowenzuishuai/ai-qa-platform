import type { FastifyInstance } from "fastify";
import { API_BASE, api, ApiError } from "./api.js";
import { layout, errorPage } from "./pages.js";

const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
const pretty = (value: unknown) => `<pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(value, null, 2))}</pre>`;
const mode = (value: unknown) => value === "mock" ? "模拟数据（不代表真实模型效果）" : value === "real" ? "真实模式" : "历史/人工资产";
const choices = `<label>生成模式</label><select name="mode"><option value="mock">模拟查表（仅已登记样例可用）</option><option value="real">真实模型（需要服务已配置）</option></select>`;
const list = (value: unknown) => Array.isArray(value) ? value.map(String) : value ? [String(value)] : [];

export function registerWorkbenchRoutes(app: FastifyInstance) {
  app.addContentTypeParser(/^multipart\/form-data(?:;|$)/i, { parseAs: "buffer", bodyLimit: 21 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  app.get("/projects/:id/review", async (req, reply) => {
    const sid = req.cookies["web_sid"];
    if (!sid) return reply.redirect("/login");
    const { id } = req.params as { id: string };
    try {
      const [project, documents, review] = await Promise.all([
        api<{ name: string }>(`/api/projects/${encodeURIComponent(id)}`, { sid }),
        api<{ documents: any[] }>(`/api/projects/${encodeURIComponent(id)}/documents`, { sid }),
        api<{ rules: any[]; clarifications: any[]; cases: any[]; jobs: any[] }>(`/api/projects/${encodeURIComponent(id)}/review`, { sid }),
      ]);
      const base = `/projects/${encodeURIComponent(id)}/review`;
      const documentRows = documents.data.documents.flatMap(d => d.versions.map((v: any) => `<tr><td><input type="checkbox" name="documentVersionIds" value="${esc(v.id)}" ${v.parseStatus !== "PARSED" ? "disabled" : ""}></td><td><a href="/document-versions/${esc(v.id)}">${esc(d.title)} · v${v.version}</a></td><td>${esc(v.parseStatus)}<br>${esc(mode(v.mode))}</td><td>${(v.parseWarnings ?? []).map(esc).join("<br>")}</td></tr>`)).join("");
      const rules = review.data.rules.map(r => `<article class="card"><h3>${esc(r.statement)}</h3><p>${esc(r.classification)} · ${esc(r.reviewStatus)} · ${esc(mode(r.generationMode))}</p><p>动作：${esc(r.action)}；条件：${esc(r.condition)}；预期：${esc(r.expectation)}</p><p>禁止：${esc((r.forbiddenBehaviors ?? []).join("；"))}</p><p>来源：${(r.sources ?? []).map((s: any) => `<a href="/document-versions/${esc(s.documentVersionId)}">查看原文（${s.sourceSpanIds.length} 个片段）</a>`).join(" · ")}</p>
      ${["DRAFT", "NEEDS_REVIEW"].includes(r.reviewStatus) ? `<form method="post" action="${base}/rules/${esc(r.id)}/approve"><button>批准规则</button></form><form method="post" action="${base}/rules/${esc(r.id)}/reject"><button class="danger">驳回规则</button></form>` : ""}</article>`).join("");
      const clarifications = review.data.clarifications.map(c => `<article class="card"><h3>${esc(c.question)}</h3><p>${esc(c.kind)} · 关联 ${c.ruleVersionIds.length} 条规则</p>${c.resolvedAt ? `<p>已确认：${esc(c.answer)}</p><p>来源：${esc(c.answerSource)}；回答人：${esc(c.resolvedBy)}</p>` : `<form method="post" action="${base}/clarifications/${esc(c.id)}"><label>回答</label><textarea name="answer" required maxlength="10000" rows="4" style="width:100%"></textarea><label>答案来源（产品确认记录/文档位置等）</label><input name="answerSource" type="text" required maxlength="2000"><button>确认回答</button></form>`}</article>`).join("");
      const generation = review.data.rules.filter(r => r.reviewStatus === "APPROVED").map(r => `<label><input type="checkbox" name="ruleVersionIds" value="${esc(r.id)}">${esc(r.statement)} · ${esc(mode(r.generationMode))}</label>`).join("");
      const cases = review.data.cases.map(c => `<article class="card"><h3><a href="/cases/${esc(c.id)}">${esc(c.title)}</a></h3><p>${esc(c.approvalStatus)} · ${esc(mode(c.generationMode))}</p><p>角色：${esc(c.roles.join("、"))}</p><ol>${(c.steps ?? []).map((s: any) => `<li>${esc(s.role)}：${esc(s.action)}<br>预期：${esc(s.expectedResult)}</li>`).join("")}</ol><details><summary>查看前置条件、数据、断言与清理</summary>${pretty({ preconditions: c.preconditions, data: c.dataSpec, assertions: c.assertions, cleanup: c.cleanup })}</details><p class="muted">生成草稿需批准与绑定执行计划。请到项目空间的“测试任务”继续。</p></article>`).join("");
      const jobs = review.data.jobs.map(j => `<tr><td><a href="/jobs/${esc(j.id)}">${esc(j.kind)}</a></td><td>${esc(j.status)}</td><td>${esc(mode(j.request?.mode))}</td><td>${esc(j.error?.message)}</td></tr>`).join("");
      return reply.type("text/html").send(layout("资料与测试审阅", `<h1>${esc(project.data.name)} · 资料与测试审阅</h1><p><a href="/projects/${esc(id)}">返回运行页面</a> · <a href="${base}">刷新状态</a></p>
      <p><a class="button" href="/projects/${esc(id)}/changes">比较需求变更与复核影响</a></p><section class="card"><h2>1. 上传业务资料</h2><form id="upload" method="post" action="${base}/documents" enctype="multipart/form-data"><label>标题</label><input type="text" name="title" required maxlength="200"><label>格式</label><select name="declaredFormat">${["MARKDOWN", "TXT", "DOCX", "PDF_TEXT", "PDF_SCANNED", "PNG", "JPEG"].map(x => `<option>${x}</option>`).join("")}</select><label>文件（最大 20 MB）</label><input type="file" name="file" required><input type="hidden" name="fileSizeBytes"><label>解析模式（图片使用视觉模型）</label><select name="mode"><option value="real">真实解析</option><option value="mock">模拟视觉（需登记响应）</option></select><label>追加到已有文档（可选）</label><select name="documentId"><option value="">新建文档</option>${documents.data.documents.map(d => `<option value="${esc(d.id)}">${esc(d.title)}</option>`).join("")}</select><button>上传并解析</button></form></section>
      <section class="card"><h2>2. 选择已解析资料，提取规则</h2><form method="post" action="${base}/extract"><table><tr><th>选择</th><th>资料</th><th>状态</th><th>解析提示</th></tr>${documentRows || "<tr><td colspan=4>暂无资料</td></tr>"}</table>${choices}<button>提取规则草稿</button></form></section>
      <h2>3. 回答澄清，再审阅规则</h2>${clarifications || "<p>暂无澄清</p>"}${rules || "<p>暂无规则</p>"}
      <section class="card"><h2>4. 从批准规则生成用例</h2><form method="post" action="${base}/generate">${generation || "<p>暂无批准规则</p>"}${choices}<button>生成用例草稿</button></form></section>
      <h2>5. 用例审阅</h2>${cases || "<p>暂无用例</p>"}<h2>最近作业</h2><p class="muted">本页最多显示各类资产 200 条、最近作业 100 条。</p><table><tr><th>类型</th><th>状态</th><th>模式</th><th>失败原因</th></tr>${jobs}</table>
      <script>document.getElementById('upload').addEventListener('submit',function(e){const f=this.elements.file.files[0];if(!f||f.size>20*1024*1024||f.size===0){e.preventDefault();alert('请选择 1 字节至 20 MB 的文件');return;}this.elements.fileSizeBytes.value=f.size;});</script>`));
    } catch (error) { return fail(reply, error); }
  });
  app.post("/projects/:id/review/documents", { bodyLimit: 21 * 1024 * 1024 }, async (req, reply) => {
    const sid = req.cookies["web_sid"]; if (!sid) return reply.redirect("/login");
    const { id } = req.params as { id: string };
    try {
      const response = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(id)}/documents`, { method: "POST", headers: { cookie: `aiqa_sid=${sid}`, "content-type": req.headers["content-type"]! }, body: new Uint8Array(req.body as Buffer) });
      const data = await response.json() as { jobId?: string; message?: string };
      if (!response.ok) throw new ApiError(response.status, "UPLOAD_FAILED", data.message ?? "上传失败");
      return reply.redirect(`/jobs/${data.jobId}`);
    } catch (error) { return fail(reply, error); }
  });
  for (const action of ["extract", "generate", "rules/:asset/approve", "rules/:asset/reject", "clarifications/:asset"]) {
    app.post(`/projects/:id/review/${action}`, async (req, reply) => {
      const sid = req.cookies["web_sid"]; if (!sid) return reply.redirect("/login");
      const { id, asset } = req.params as { id: string; asset?: string };
      const body = req.body as Record<string, unknown>;
      try {
        let path: string, data: unknown;
        if (action === "extract") { path = `/api/projects/${encodeURIComponent(id)}/rule-extractions`; data = { documentVersionIds: list(body.documentVersionIds), mode: body.mode }; }
        else if (action === "generate") { path = `/api/projects/${encodeURIComponent(id)}/case-generations`; data = { ruleVersionIds: list(body.ruleVersionIds), mode: body.mode }; }
        else if (action.startsWith("rules/")) { path = `/api/rule-versions/${encodeURIComponent(asset!)}/${action.endsWith("approve") ? "approve" : "reject"}`; data = {}; }
        else { path = `/api/clarifications/${encodeURIComponent(asset!)}/resolve`; data = { answer: body.answer, answerSource: body.answerSource }; }
        const response = await api<{ jobId?: string }>(path, { method: "POST", body: data, sid });
        return reply.redirect(response.data.jobId ? `/jobs/${response.data.jobId}` : `/projects/${encodeURIComponent(id)}/review`);
      } catch (error) { return fail(reply, error); }
    });
  }
  app.get("/document-versions/:id", async (req, reply) => {
    const sid = req.cookies["web_sid"]; if (!sid) return reply.redirect("/login");
    const { id } = req.params as { id: string };
    try {
      const { data } = await api<{ documentVersion: any; bundle: any }>(`/api/document-versions/${encodeURIComponent(id)}`, { sid });
      const v = data.documentVersion;
      return reply.type("text/html").send(layout("资料原文", `<h1>${esc(v.document.title)} · v${v.version}</h1><a href="/projects/${esc(v.document.projectId)}/review">返回审阅</a><p>${esc(v.parseStatus)} · ${esc(mode(v.mode))}</p>${(v.parseWarnings ?? []).map((w: string) => `<p>${esc(w)}</p>`).join("")}<h2>解析覆盖</h2>${pretty(v.coverageSummary)}<h2>来源片段</h2>${data.bundle?.spans.map((s: any) => `<article class="card"><p>${esc(s.extractionQuality)} · ${esc(s.id)}</p>${pretty(s.locator)}<pre style="white-space:pre-wrap">${esc(s.quotedText ?? "该片段未解析")}</pre></article>`).join("") ?? "<p>解析尚未完成</p>"}`));
    } catch (error) { return fail(reply, error); }
  });
  app.get("/jobs/:id", async (req, reply) => {
    const sid = req.cookies["web_sid"]; if (!sid) return reply.redirect("/login");
    const { id } = req.params as { id: string };
    try {
      const { data: j } = await api<any>(`/api/jobs/${encodeURIComponent(id)}`, { sid });
      const local=['LOGIN_CHECK','DATA_PREPARE','DATA_CLEANUP','DATA_INSPECT'].includes(j.kind);
      const names:Record<string,string>={LOGIN_CHECK:'登录检查',DATA_PREPARE:'准备测试数据',DATA_CLEANUP:'清理测试数据',DATA_INSPECT:'核对测试数据',DOCUMENT_PARSE:'资料解析',RULE_EXTRACTION:'业务规则提取',CASE_GENERATION:'测试用例设计',WEB_OBSERVATION:'页面观察',PLAN_PROPOSAL:'执行计划建议'};
      const status:Record<string,string>={QUEUED:'排队中',RUNNING:'处理中',SUCCEEDED:'处理已结束',FAILED:'处理失败',CANCELLED:'已取消'};
      const back=j.workflowId?`/workflows/${encodeURIComponent(j.workflowId)}`:local?`/preparation/${encodeURIComponent(j.projectId)}`:`/space/${encodeURIComponent(j.projectId)}`;
      return reply.type("text/html").send(layout("作业进度", `<h1>${esc(names[j.kind]??j.kind)}</h1><p>状态：${esc(status[j.status]??j.status)}${j.mode?' · '+esc(mode(j.mode)):''}</p><p>${esc(j.error?.message)}</p>${j.kind==='LOGIN_CHECK'&&j.result?`<section class="card"><h2>${j.result.result.status==='PASS'?'登录检查通过':'登录尚未准备好'}</h2><p>${esc(j.result.result.detail)}</p><p>${esc(j.result.result.checkedAt)}</p><a href="/artifacts/${esc(j.result.result.evidenceArtifactId)}">查看检查证据</a></section>`:j.result?`<details><summary>处理结果</summary>${pretty(j.result)}</details>`:''}<a href="${back}">返回${j.workflowId?'工作流':local?'准备中心':'项目'}</a>${j.status==='FAILED'&&!local&&!j.workflowId?`<form method="post" action="/jobs/${esc(id)}/retry"><button>显式重试</button></form>`:''}${['QUEUED','RUNNING'].includes(j.status)?`<p>处理中，每 3 秒刷新。</p><script>setTimeout(()=>location.reload(),3000)</script>${local?`<form method="post" action="/jobs/${esc(id)}/cancel"><button class="danger">取消检查或准备</button></form>`:''}`:''}`,{projectId:j.projectId,activeTab:local?'preparation':'workflows'}));
    } catch (error) { return fail(reply, error); }
  });
  app.post('/jobs/:id/cancel',async(req,reply)=>{const sid=req.cookies.web_sid;if(!sid)return reply.redirect('/login');const {id}=req.params as {id:string};try{await api(`/api/jobs/${encodeURIComponent(id)}/cancel`,{sid,method:'POST',body:{}});return reply.redirect(`/jobs/${encodeURIComponent(id)}`);}catch(e){return fail(reply,e);}});
  app.post("/jobs/:id/retry", async (req, reply) => {
    const sid = req.cookies["web_sid"]; if (!sid) return reply.redirect("/login");
    const { id } = req.params as { id: string };
    try { await api(`/api/jobs/${encodeURIComponent(id)}/retry`, { method: "POST", sid }); return reply.redirect(`/jobs/${encodeURIComponent(id)}`); }
    catch (error) { return fail(reply, error); }
  });
}
function fail(reply: import("fastify").FastifyReply, error: unknown) {
  return reply.code(error instanceof ApiError ? error.status : 500).type("text/html").send(errorPage(esc(error instanceof Error ? error.message : error)));
}
