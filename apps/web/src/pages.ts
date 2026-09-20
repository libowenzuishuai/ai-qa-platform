const escapeHtml = (v: unknown) => String(v ?? "").replace(/[&<>"\']/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "\'":"&#39;"}[c]!));
/** 页面渲染（服务端模板，零客户端依赖；SSE 用原生 EventSource）。 */

const STYLE = `
* { box-sizing: border-box; }
body { font-family: "PingFang SC","Microsoft YaHei",sans-serif; margin:0; background:#f5f6f8; color:#1f2329; }
header { background:#1f3d7a; color:#fff; padding:12px 24px; display:flex; align-items:center; gap:16px; }
header a { color:#cdd9ff; text-decoration:none; margin-right:14px; }
header a:hover { color:#fff; }
main { max-width:1080px; margin:24px auto; padding:0 16px; }
h1 { font-size:20px; } h2 { font-size:16px; }
table { width:100%; border-collapse:collapse; background:#fff; margin:12px 0; }
th,td { padding:8px 12px; border:1px solid #e2e4ea; text-align:left; font-size:14px; }
th { background:#f0f2f7; }
.card { background:#fff; border:1px solid #e2e4ea; padding:16px 20px; margin:12px 0; }
label { display:block; margin:10px 0 4px; font-size:14px; font-weight:500; }
select,input[type=text],input[type=password] { width:320px; padding:8px; border:1px solid #c9cdd6; font-size:14px; }
button { padding:8px 18px; background:#2457d6; color:#fff; border:0; font-size:14px; cursor:pointer; margin-top:12px; }
button.danger { background:#c72f2f; }
button:disabled { background:#9aa4b8; cursor:not-allowed; }
.badge { display:inline-block; padding:2px 10px; border-radius:10px; font-size:12px; }
.badge.PASS,.badge.FINISHED,.badge.GREEN { background:#e9f7ee; color:#1c7c3c; }
.badge.FAIL,.badge.ERROR { background:#fdecec; color:#a42121; }
.badge.BLOCKED,.badge.CANCELLED,.badge.REVIEW,.badge.INCOMPLETE,.badge.QUEUED,.badge.PENDING,.badge.RUNNING,.badge.PREPARING,.badge.FINALIZING,.badge.CANCEL_REQUESTED { background:#fff4e0; color:#a16500; }
.badge.NOT_RUN { background:#eef0f4; color:#4e5561; }
.error-box { background:#fdecec; color:#a42121; border:1px solid #f5c6c6; padding:10px 14px; margin:12px 0; font-size:14px; }
.muted { color:#646a73; font-size:13px; }
img.shot { max-width:360px; border:1px solid #e2e4ea; margin:6px 6px 0 0; }
#sse-log { background:#0f172a; color:#d7e3ff; font-family:ui-monospace,monospace; font-size:12px; padding:12px; height:260px; overflow-y:auto; white-space:pre-wrap; }
.kv { font-size:14px; } .kv b { display:inline-block; width:140px; font-weight:500; color:#4e5561; }
.steps td.detail { color:#646a73; font-size:13px; }
`;

export function layout(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · AI 测试平台</title><style>${STYLE}</style></head>
<body><header><b>AI 测试人员平台</b><span class="muted" style="color:#9fb0dd">业务资料 · 测试审阅 · 运行验收</span>
<nav style="margin-left:auto"><a href="/">项目</a><a href="/runs">运行</a></nav></header>
<main>${body}</main></body></html>`;
}

export function loginPage(error?: string): string {
  return layout(
    "登录",
    `<h1>平台登录</h1>
    ${error ? `<div class="error-box">${error}</div>` : ""}
    <div class="card"><form method="post" action="/login">
      <label>用户名</label><input type="text" name="username" autocomplete="username">
      <label>密码</label><input type="password" name="password" autocomplete="current-password">
      <button type="submit">登录</button>
    </form></div>`,
  );
}

export function projectsPage(
  user: string,
  projects: Array<{ id: string; name: string; role: string }>,
): string {
  const rows = projects
    .map(
      (p) =>
        `<tr><td><a href="/space/${p.id}">${escapeHtml(p.name)}</a></td><td>${p.id}</td><td><span class="badge">${p.role}</span></td></tr>`,
    )
    .join("");
  return layout(
    "项目",
    `<h1>我的项目</h1><form method="post" action="/projects/new"><label>创建项目</label><input type="text" name="name" required maxlength="120"><button>创建</button></form>
    <p class="muted">当前用户：${escapeHtml(user)}</p>
    <table><thead><tr><th>项目</th><th>ID</th><th>我的角色</th></tr></thead>
    <tbody>${rows || "<tr><td colspan=3>暂无项目</td></tr>"}</tbody></table>`,
  );
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
            .map((e) => `<img class="shot" src="${e.url}" alt="${a.assertionId}">`)
            .join("");
          const traces = a.evidence
            .filter((e) => e.type === "TRACE" && e.exists)
            .map((e) => `<a href="${e.url}">下载 trace（受限）</a>`)
            .join(" ");
          return `<tr><td>${a.assertionId}</td>
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
    `<h1>运行报告</h1>
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
  return layout("错误", `<h1>出错了</h1><div class="error-box">${message}</div><p><a href="/">返回项目列表</a></p>`);
}
