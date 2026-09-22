import {formUx} from './form-ux.js';
import { productStyle, workspaceNavigation } from "./design-system.js";
const escapeHtml = (v: unknown) => String(v ?? "").replace(/[&<>"\']/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "\'":"&#39;"}[c]!));
/** 页面渲染（服务端模板，零客户端依赖；SSE 用原生 EventSource）。 */

export interface LayoutContext { projectId?: string; projectName?: string; activeTab?: string }
export function layout(title: string, body: string, context: LayoutContext = {}): string {
  const navigation = context.projectId
    ? workspaceNavigation.map(([key,label,icon]) => `<a href="/space/${encodeURIComponent(context.projectId!)}?tab=${key}" ${key===context.activeTab?'aria-current="page"':''}><span class="nav-icon" aria-hidden="true">${icon}</span>${label}</a>`).join('')
    : `<a href="/"><span class="nav-icon" aria-hidden="true">▦</span>我的项目</a><a href="/runs"><span class="nav-icon" aria-hidden="true">▷</span>全部运行</a>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · AI QA</title><style>${productStyle}</style></head>
<body data-project-id="${escapeHtml(context.projectId??'')}"><aside class="app-sidebar"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">q.</span><div>AI QA<small>QUALITY WORKSPACE</small></div></a><div class="space-label"><small>PROJECT SPACE</small>${escapeHtml(context.projectName??'软件验收工作空间')}</div><div class="nav-label">WORKSPACE</div><nav aria-label="工作空间导航">${navigation}${context.projectId?`<a href="/projects/${encodeURIComponent(context.projectId)}/delivery"><span class="nav-icon" aria-hidden="true">◎</span>交付中心</a>`:""}</nav><div class="sidebar-note"><b>每次交付，都有依据。</b>从业务要求到执行证据，<br>让质量判断可以复核。<p style="margin:20px 0 0"><a href="/">切换项目 ↗</a></p></div></aside><div class="app-shell"><header class="topbar"><div class="breadcrumb">${escapeHtml(context.projectName??'工作空间')}<span>/</span><b>${escapeHtml(title)}</b></div><div class="top-meta">需求 · 执行 · 证据</div></header><main class="app-main" id="main-content">${body}</main><footer class="app-footer">AI QA / 软件验收平台 · 以批准的要求为依据，以实际证据为结论。</footer></div>${formUx}</body></html>`;
}

export function loginPage(error?: string): string {
  return layout(
    "登录",
    `<div class="login-card"><span class="eyebrow">WELCOME TO AI QA</span><h1>登录质量工作空间</h1><p class="muted">从需求出发，验证每一次交付。</p>
    ${error ? `<div class="error-box">${error}</div>` : ""}
    <div class="card"><form method="post" action="/login">
      <label for="login-username">用户名</label><input id="login-username" type="text" name="username" autocomplete="username">
      <label for="login-password">密码</label><input id="login-password" type="password" name="password" autocomplete="current-password">
      <button type="submit">登录</button>
    </form></div></div>`,
  );
}

export function projectsPage(
  user: string,
  projects: Array<{ id: string; name: string; role: string }>,
): string {
  const tiles = projects.map(p => `<a class="card project-tile" href="/space/${encodeURIComponent(p.id)}"><span class="project-avatar">${escapeHtml(p.name.slice(0,1))}</span><h2>${escapeHtml(p.name)}</h2><p class="muted">${escapeHtml(({ADMIN:'项目管理员',LEAD:'测试负责人',MEMBER:'项目成员',VIEWER:'查看者'} as Record<string,string>)[p.role]??p.role)}</p><span>进入项目空间 →</span></a>`).join('');
  return layout("我的项目",`<div class="page-heading"><div><span class="eyebrow">YOUR QUALITY WORKSPACE</span><h1>我的项目</h1><p>${escapeHtml(user)}，从一个项目开始，让测试沿着业务发生。</p></div></div><div class="project-list">${tiles||'<div class="empty-state">还没有项目。接入第一个项目，建立验收依据。</div>'}</div><section class="card"><h2>接入一个新项目</h2><p class="muted">创建后可连接仓库、登记测试网址并导入业务资料。</p><form method="post" action="/projects/new"><label for="project-name">项目名称</label><input id="project-name" type="text" name="name" required maxlength="120" placeholder="例如：客户服务平台"><button>创建项目 →</button></form></section>`);
}

export interface LauncherData {
  project: { id: string; name: string };
  environments: Array<{ id: string; name: string; baseUrl: string; buildId: string | null }>;
  baselines: Array<{ id: string; name: string; active: boolean }>;
  caseVersions: Array<{ caseVersionId: string; title: string; approvalStatus: string; hasPlan: boolean }>;
  runs: Array<{ id: string; lifecycle: string; acceptanceStatus: string; createdAt: string }>;
}

export function launcherPage(data: LauncherData, error?: string): string {
  const envOptions = data.environments
    .map((e) => `<option value="${e.id}">${escapeHtml(e.name)}（${escapeHtml(e.baseUrl)}${e.buildId ? ` · ${e.buildId}` : ""}）</option>`)
    .join("");
  const baselineOptions = data.baselines
    .map((b) => `<option value="${b.id}" ${b.active ? "selected" : ""}>${escapeHtml(b.name)}</option>`)
    .join("");
  const caseRows = data.caseVersions
    .map(
      (c) =>
        `<tr><td><label style="margin:0"><input type="checkbox" name="caseVersionIds" value="${c.caseVersionId}" checked> ${escapeHtml(c.title)}</label></td>
        <td>${c.caseVersionId}</td><td><span class="badge ${c.approvalStatus === "APPROVED" ? "PASS" : "REVIEW"}">${c.approvalStatus}</span></td>
        <td>${c.hasPlan ? "✓" : "无计划"}</td></tr>`,
    )
    .join("");
  const runRows = data.runs
    .map(
      (r) =>
        `<tr><td><a href="/runs/${r.id}">${r.id.slice(0, 14)}…</a></td>
        <td><span class="badge ${r.lifecycle}">${r.lifecycle}</span></td>
        <td><span class="badge ${r.acceptanceStatus}">${r.acceptanceStatus}</span></td>
        <td class="muted">${r.createdAt.replace("T", " ").slice(0, 19)}</td></tr>`,
    )
    .join("");
  return layout(
    data.project.name,
    `<h1>${escapeHtml(data.project.name)}</h1><p><a href="/projects/${data.project.id}/review">打开资料与测试审阅工作台</a></p>
    ${error ? `<div class="error-box">${error}</div>` : ""}
    <div class="card">
      <h2>启动测试</h2>
      <form method="post" action="/projects/${data.project.id}/start" name="start-run">
        <label>测试环境</label><select name="environmentId">${envOptions || "<option value=''>（请先登记环境）</option>"}</select>
        <label>基线</label><select name="baselineId">${baselineOptions || "<option value=''>（无基线）</option>"}</select>
        <label>构建标识（可选；留空则报告标记“版本未验证”）</label><input type="text" name="buildId" placeholder="如 demo-build-042">
        <table><thead><tr><th>用例</th><th>版本 ID</th><th>状态</th><th>计划</th></tr></thead><tbody>${caseRows || "<tr><td colspan=4>暂无固定用例（先执行种子）</td></tr>"}</tbody></table>
        <button type="submit" ${data.caseVersions.length === 0 ? "disabled" : ""}>开始测试</button>
      </form>
      <form method="post" action="/projects/${data.project.id}/seed" style="margin-top:8px">
        <label>执行固定资产种子（真实浏览器观察 + 创建规则/用例/基线）</label>
        <button type="submit" class="danger" style="background:#5c6b8a">执行/刷新种子</button>
        <span class="muted">需要上方选择环境</span>
      </form>
    </div>
    <h2>最近运行</h2>
    <table><thead><tr><th>运行</th><th>生命周期</th><th>严格验收</th><th>创建时间</th></tr></thead>
    <tbody>${runRows || "<tr><td colspan=4>暂无</td></tr>"}</tbody></table>`,
  );
}

export interface RunDetailData {
  run: { id: string; lifecycle: string; acceptanceStatus: string; buildId: string | null; mode: string };
  cases: Array<{ caseVersionId: string; title: string; verdict: string; reasonCode: string; attemptId: string | null }>;
}

export function runDetailPage(data: RunDetailData, error?: string): string {
  const r = data.run;
  const caseRows = data.cases
    .map(
      (c) =>
        `<tr><td>${escapeHtml(c.title)}</td><td class="muted">${c.caseVersionId}</td>
        <td><span class="badge ${c.verdict}">${c.verdict}</span></td>
        <td><span class="badge">${c.reasonCode}</span></td></tr>`,
    )
    .join("");
  const cancellable = !["FINISHED", "CANCELLED", "ERROR"].includes(r.lifecycle);
  return layout(
    `运行 ${r.id.slice(0, 8)}`,
    `<h1>运行详情</h1>
    ${error ? `<div class="error-box">${error}</div>` : ""}
    <div class="card">
      <div class="kv"><b>运行 ID</b>${r.id}</div>
      <div class="kv"><b>生命周期</b><span class="badge ${r.lifecycle}">${r.lifecycle}</span></div>
      <div class="kv"><b>严格验收</b><span class="badge ${r.acceptanceStatus}">${r.acceptanceStatus}</span></div>
      <div class="kv"><b>构建标识</b>${r.buildId ?? '<span class="muted">无（版本未验证）</span>'}</div>
      <div class="kv"><b>模式</b>${r.mode}</div>
      <div style="margin-top:12px">
        <form method="post" action="/runs/${r.id}/cancel" style="display:inline">
          <button type="submit" class="danger" ${cancellable ? "" : "disabled"}>取消运行</button>
        </form>
        <a href="/runs/${r.id}/report"><button type="button" style="background:#5c6b8a">查看报告</button></a>
      </div>
    </div>
    <h2>用例状态</h2>
    <table><thead><tr><th>用例</th><th>版本</th><th>verdict</th><th>原因</th></tr></thead><tbody>${caseRows}</tbody></table>
    <h2>实时事件（SSE）</h2>
    <div class="card"><div id="sse-log">等待连接…</div>
    <p class="muted">断线自动重连（Last-Event-ID 续传）；刷新页面恢复状态。</p></div>
    <script>
      const log = document.getElementById('sse-log');
      const seen = new Set();
      const es = new EventSource('/api/runs/${r.id}/events');
      es.onopen = () => log.textContent += '[connected]\\n';
      es.onerror = () => log.textContent += '[reconnecting…]\\n';
      es.onmessage = (e) => append(e.data);
      for (const type of ['run.lifecycle','attempt.started','attempt.finished','step.updated','assertion.evaluated','violation','write.intent','run.cancel_requested','run.platform_error','run.cancel_skipped','run.case_missing','attempt.fixture_error','run.done']) {
        es.addEventListener(type, (e) => append(e.data));
      }
      es.addEventListener('stream.end', (e) => { append(e.data); es.close(); });
      function append(raw) {
        try {
          const d = JSON.parse(raw);
          const key = d.seq ?? raw;
          if (seen.has(key)) return; seen.add(key);
          const p = d.payload ?? {};
          const line = [d.seq, d.type, p.stepId ?? p.caseVersionId?.slice(0,10) ?? '', p.status ?? p.verdict ?? p.lifecycle ?? p.detail ?? '']
            .filter(Boolean).join(' · ');
          log.textContent += line + '\\n';
          log.scrollTop = log.scrollHeight;
        } catch { log.textContent += raw + '\\n'; }
      }
    </script>`,
  );
}

export interface ReportData {
  run: { id: string; lifecycle: string; acceptanceStatus: string; buildVerified: boolean; mode: string };
  metrics: {
    totalSelected: number;
    counts: Record<string, number>;
    unstable: number;
    executionRateDisplay: string;
    passRateDisplay: string;
    ruleCoverageDisplay: string;
    acceptanceStatus: string;
  };
  cases: Array<{
    caseVersionId: string;
    title: string;
    verdict: string;
    reasonCode: string;
    evidenceDowngraded: boolean;
    traces?: Array<{ artifactId: string; type: string; sensitivity: string; url: string; exists: boolean }>;
    assertions: Array<{
      assertionId: string;
      expected: string | null;
      actual: string | null;
      unit: string | null;
      result: string;
      note: string | null;
      evidence: Array<{ artifactId: string; type: string; sensitivity: string; url: string; exists: boolean }>;
    }>;
  }>;
}

export function reportPage(data: ReportData): string {
  const m = data.metrics;
  const caseBlocks = data.cases
    .map((c) => {
      const assertionRows = c.assertions
        .map((a) => {
          const shots = a.evidence
            .filter((e) => e.type.startsWith("assert") && e.exists)
            .map((e) => `<img class="shot" src="${e.url}" alt="${escapeHtml(a.assertionId)}">`)
            .join("");
          const traces = a.evidence
            .filter((e) => e.type === "TRACE" && e.exists)
            .map((e) => `<a href="${e.url}">下载 trace（受限）</a>`)
            .join(" ");
          return `<tr><td>${escapeHtml(a.assertionId)}</td>
          <td>${escapeHtml(a.expected ?? "—")}${a.unit ? ` <span class="muted">${escapeHtml(a.unit)}</span>` : ""}</td>
          <td>${escapeHtml(a.actual ?? "—")}</td>
          <td><span class="badge ${a.result}">${a.result}</span></td>
          <td class="detail">${escapeHtml(a.note ?? "")}</td></tr>
          ${shots || traces ? `<tr><td colspan=5>${shots} ${traces}</td></tr>` : ""}`;
        })
        .join("");
      const traceLinks = (c.traces ?? [])
        .filter((t) => t.exists)
        .map((t) => `<a href="${t.url}">下载 trace（受限原始证据）</a>`)
        .join(" ");
      return `<div class="card">
        <h2>${escapeHtml(c.title)} <span class="badge ${c.verdict}">${c.verdict}</span>
        <span class="badge">${c.reasonCode}</span>
        ${c.evidenceDowngraded ? '<span class="badge REVIEW">证据缺失降级</span>' : ""}</h2>
        ${traceLinks ? `<p>${traceLinks}</p>` : ""}
        <table class="steps"><thead><tr><th>断言</th><th>预期</th><th>实际</th><th>结果</th><th>说明</th></tr></thead>
        <tbody>${assertionRows || "<tr><td colspan=5>未执行</td></tr>"}</tbody></table>
      </div>`;
    })
    .join("");
  return layout(
    "报告",
    `<h1>运行报告</h1><p><a href="/runs/${encodeURIComponent(data.run.id)}/export/json">导出 JSON</a> · <a href="/runs/${encodeURIComponent(data.run.id)}/export/markdown">导出 Markdown</a></p>
    <div class="card">
      <div class="kv"><b>运行</b><a href="/runs/${data.run.id}">${data.run.id}</a></div>
      <div class="kv"><b>生命周期</b><span class="badge ${data.run.lifecycle}">${data.run.lifecycle}</span></div>
      <div class="kv"><b>严格验收</b><span class="badge ${m.acceptanceStatus}">${m.acceptanceStatus}</span></div>
      <div class="kv"><b>构建标识</b>${data.run.buildVerified ? "已核验运行实例" : '<span class="muted">版本未验证</span>'}</div>
      <div class="kv"><b>选定用例</b>${m.totalSelected}</div>
      <div class="kv"><b>结果分布</b>PASS ${m.counts.PASS ?? 0} · FAIL ${m.counts.FAIL ?? 0} · BLOCKED ${m.counts.BLOCKED ?? 0} · REVIEW ${m.counts.REVIEW ?? 0} · NOT_RUN ${m.counts.NOT_RUN ?? 0} · unstable ${m.unstable}</div>
      <div class="kv"><b>用例执行率</b>${m.executionRateDisplay}</div>
      <div class="kv"><b>通过比例</b>${m.passRateDisplay}</div>
      <div class="kv"><b>规则覆盖率</b>${m.ruleCoverageDisplay}</div>
    </div>
    ${caseBlocks}`,
  );
}

export function errorPage(message: string): string {
  return layout("错误", `<h1>出错了</h1><div class="error-box" role="alert" data-error-page>${escapeHtml(message)}</div><p><a href="/">返回项目列表</a></p>`);
}
