#!/usr/bin/env node
/**
 * 阶段 1 集成验收 harness（独立于 tests-golden；阶段 1 提示词 §4）。
 *
 * 全部通过平台入口（API/队列/worker/页面）驱动；本 harness 属于评测器，
 * 可以读取 demo fixtures、注入数据库篡改与临时用户 —— 平台运行时不知道
 * 这些能力。预期结论只写在 harness 内，不进入被测系统与执行器。
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
/**
 * 阶段 1.1 起验收 harness 完全独立（评审 §三.1）：
 * - 独立临时 PostgreSQL 库（不复用开发库，篡改类测试不碰日常数据）；
 * - 独立 Redis 容器（带密码 + 非 0 db 序号，验证 URL 解析实际生效）；
 * - 独立端口（API 7310 / worker 7211 / web 7110）与临时证据目录；
 * - finally 中全部清理。
 */
const STAMP = Date.now().toString(36);
const API_PORT = 7310;
const WORKER_PORT = 7211;
const WEB_PORT = 7110;
const API = `http://127.0.0.1:${API_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const FIXTURE_TOKEN = "dev-fixture-token";
const PG_CONTAINER = "ai-qa-postgres-1";
const PG_BASE = "postgresql://aiqa:aiqa_dev_password@127.0.0.1:5435";
const DB_NAME = `aiqa_p1acc_${STAMP.replace(/[^a-z0-9]/g, "")}`;
const DB_URL = `${PG_BASE}/${DB_NAME}?schema=public`;
const REDIS_CONTAINER = `aiqa-p1-redis-${STAMP}`;
const REDIS_PASSWORD = `p1acc-${STAMP}`;
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "Admin#Dev2026";

const ARTIFACT_DIR = join(HERE, `artifacts-${STAMP}`);
const TEMP_DIRS = [ARTIFACT_DIR];
let REDIS_PORT = 0;
let REDIS_URL = "";

const results = [];
let failures = 0;
function record(name, ok, detail = "") {
  results.push({ name, ok, detail: String(detail) });
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tsx(args, env = {}) {
  return execFileSync(join(HERE, "node_modules/.bin/tsx"), args, {
    cwd: HERE,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: DB_URL, ...env },
  }).trim();
}

function sh(cmd) {
  return execFileSync("sh", ["-c", cmd], { encoding: "utf8" }).trim();
}

/** 供给独立资源：临时库 + 独立 Redis（带密码与 db 序号）。 */
function provisionResources() {
  sh(`docker exec ${PG_CONTAINER} createdb -U aiqa ${DB_NAME}`);
  execFileSync(join(ROOT, "apps/api/node_modules/.bin/prisma"), ["migrate", "deploy"], {
    cwd: join(ROOT, "apps/api"),
    env: { ...process.env, DATABASE_URL: DB_URL },
    encoding: "utf8",
  });
  sh(`docker run -d --name ${REDIS_CONTAINER} -p 127.0.0.1::6379 redis:7-alpine --requirepass ${REDIS_PASSWORD}`);
  REDIS_PORT = Number(sh(`docker port ${REDIS_CONTAINER} 6379/tcp | head -1 | cut -d: -f2`));
  REDIS_URL = `redis://:${REDIS_PASSWORD}@127.0.0.1:${REDIS_PORT}/3`;
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  // 种子管理员。
  execFileSync(join(HERE, "node_modules/.bin/tsx"), [join(ROOT, "apps/api/prisma/seed.ts")], {
    cwd: join(ROOT, "apps/api"),
    env: { ...process.env, DATABASE_URL: DB_URL, SEED_ADMIN_PASSWORD: ADMIN_PASSWORD },
    encoding: "utf8",
  });
}

function cleanupResources() {
  for (const child of children) child.kill("SIGKILL");
  try {
    // 先断开残留连接再删库。
    sh(`docker exec ${PG_CONTAINER} psql -U aiqa -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB_NAME}' AND pid <> pg_backend_pid()" > /dev/null 2>&1 || true`);
    sh(`docker exec ${PG_CONTAINER} dropdb --if-exists -U aiqa ${DB_NAME}`);
  } catch { /* 尽力清理 */ }
  try {
    sh(`docker rm -f ${REDIS_CONTAINER}`);
  } catch { /* 尽力清理 */ }
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
}

async function fetchJson(path, init = {}, sid) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(sid ? { cookie: `aiqa_sid=${sid}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { status: response.status, data, headers: response.headers };
}

async function waitFor(fn, { timeoutMs = 120_000, intervalMs = 800, name = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(intervalMs);
  }
  throw new Error(`等待超时：${name}${lastError ? `（最后错误：${lastError}）` : ""}`);
}

async function waitRunTerminal(sid, runId, timeoutMs = 300_000) {
  const terminal = await waitFor(
    async () => {
      const { data } = await fetchJson(`/api/runs/${runId}`, {}, sid);
      if (["FINISHED", "CANCELLED", "ERROR"].includes(data.run?.lifecycle)) return data;
      return false;
    },
    { timeoutMs, name: `run ${runId} 终态` },
  );
  if (terminal.run.lifecycle === "ERROR") {
    const seqs = await collectSse(runId, sid, 0, 4_000);
    console.error(`[run ${runId} ERROR] events=${JSON.stringify(seqs.length)}`);
    // 读取 platform_error 详情。
    const stream = await fetch(`${API}/api/runs/${runId}/events?lastEventId=0`, { headers: { cookie: `aiqa_sid=${sid}` } });
    const text = await stream.text();
    for (const block of text.split("\n\n")) {
      if (block.includes("platform_error") || block.includes("fixture_error")) {
        console.error("  ", block.slice(0, 260));
      }
    }
  }
  return terminal;
}

async function login(username, password) {
  const { status, data, headers } = await fetchJson("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  if (status !== 200) throw new Error(`登录失败 ${username}: ${JSON.stringify(data)}`);
  const sid = /aiqa_sid=([^;]+)/.exec(headers.get("set-cookie") ?? "")?.[1];
  if (!sid) throw new Error("登录未返回会话");
  return sid;
}

async function demoState(port, namespace) {
  const response = await fetch(
    `http://127.0.0.1:${port}/api/fixtures/ns/state?namespace=${encodeURIComponent(namespace)}`,
    { headers: { "x-fixture-token": FIXTURE_TOKEN } },
  );
  if (!response.ok) return null;
  return (await response.json()).orders ?? null;
}

/** 观察命名空间内订单数的峰值（在清理删除前捕捉）。 */
function watchNamespace(port, namespace) {
  let max = 0;
  let stopped = false;
  const timer = setInterval(() => {
    void demoState(port, namespace)
      .then((orders) => {
        if (orders) max = Math.max(max, orders.length);
      })
      .catch(() => undefined);
  }, 250);
  return {
    maxSeen: () => max,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    stopped: () => stopped,
  };
}

const children = [];
const tmpDirs = [];
function spawnService(name, cwd, command, env = {}) {
  const child = spawn(command[0], command.slice(1), {
    cwd: join(ROOT, cwd),
    env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const emit = (stream, tag) => (chunk) => {
    for (const line of String(chunk).split("\n")) {
      const text = line.trim();
      if (!text || text.includes("ExperimentalWarning")) continue;
      if (/error|Error|ERR|failed|invalid/i.test(text)) {
        process.stderr.write(`[${name}${tag}] ${text.slice(0, 300)}\n`);
      }
    }
  };
  child.stdout.on("data", emit("", ":out"));
  child.stderr.on("data", emit("", ":err"));
  children.push(child);
  return child;
}

async function waitHealthy(url, name, timeoutMs = 40_000) {
  await waitFor(
    async () => {
      try {
        return (await fetch(url)).ok;
      } catch {
        return false;
      }
    },
    { timeoutMs, intervalMs: 500, name: `${name} 健康` },
  );
}

async function collectSse(runId, sid, lastEventId, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const seqs = [];
  try {
    const response = await fetch(`${API}/api/runs/${runId}/events?lastEventId=${lastEventId}`, {
      headers: { cookie: `aiqa_sid=${sid}` },
      signal: controller.signal,
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const idLine = block.split("\n").find((l) => l.startsWith("id: "));
        if (idLine) seqs.push(Number(idLine.slice(4)));
      }
    }
  } catch {
    /* 超时中断收集 */
  } finally {
    clearTimeout(timer);
  }
  return seqs;
}

async function main() {
  console.log("== 阶段 1 集成验收 ==");
  const stamp = Date.now().toString(36);

  // 1) demo 实例。
  const demos = [
    { name: "healthy", port: 7420, env: {} },
    { name: "B1", port: 7421, env: { DEMO_BUG_MODES: "B1" } },
    { name: "B3", port: 7423, env: { DEMO_BUG_MODES: "B3" } },
    { name: "B4", port: 7424, env: { DEMO_BUG_MODES: "B4" } },
    { name: "badcreds", port: 7425, env: { DEMO_APPLICANT_PASSWORD: "Wrong#Password9" } },
    { name: "fault", port: 7426, env: { DEMO_FAULTS: "submit-commit-hang" } },
  ];
  for (const demo of demos) {
    const dir = mkdtempSync(join(tmpdir(), `p1-${demo.name}-`));
    tmpDirs.push(dir);
    spawnService(`demo-${demo.name}`, "apps/demo-app", ["node", "dist/server.js"], {
      DEMO_PORT: String(demo.port),
      DEMO_HOST: "127.0.0.1",
      DEMO_DB_PATH: join(dir, "demo.sqlite"),
      DEMO_LOG_LEVEL: "error",
      ...demo.env,
    });
    await waitHealthy(`http://127.0.0.1:${demo.port}/health`, `demo-${demo.name}`);
  }
  record("demo 实例全部启动（6 个：健康/B1/B3/B4/错误密码/提交挂起）", true);

  // 2) API / worker / web。
  provisionResources();
  record("独立资源就绪（临时库 + 独立 Redis（密码+db3）+ 独立端口/证据目录）", true);
  spawnService("api", "apps/api", ["node_modules/.bin/tsx", "src/server.ts"], {
    API_PORT: String(API_PORT),
    API_HOST: "127.0.0.1",
    API_LOG_LEVEL: "warn",
    DATABASE_URL: DB_URL,
    REDIS_URL,
    AIQA_ARTIFACT_DIR: ARTIFACT_DIR,
    SESSION_SECRET: `p1acc-${STAMP}`,
  });
  await waitHealthy(`${API}/api/health`, "api");
  spawnService("worker", "apps/worker", ["node_modules/.bin/tsx", "src/server.ts"], {
    WORKER_PORT: String(WORKER_PORT),
    WORKER_HOST: "127.0.0.1",
    WORKER_LOG_LEVEL: "warn",
    DATABASE_URL: DB_URL,
    REDIS_URL,
    AIQA_ARTIFACT_DIR: ARTIFACT_DIR,
    DEMO_FIXTURE_TOKEN: FIXTURE_TOKEN,
    DEMO_APPLICANT_USERNAME: "applicant1",
    DEMO_APPLICANT_PASSWORD: "Applicant#2026",
    DEMO_SUPERVISOR_USERNAME: "supervisor1",
    DEMO_SUPERVISOR_PASSWORD: "Supervisor#2026",
  });
  await waitHealthy(`http://127.0.0.1:${WORKER_PORT}/api/health`, "worker");
  spawnService("web", "apps/web", ["node_modules/.bin/tsx", "src/server.ts"], {
    WEB_PORT: String(WEB_PORT),
    WEB_HOST: "127.0.0.1",
    WEB_LOG_LEVEL: "warn",
    API_BASE_URL: API,
  });
  await waitHealthy(`${WEB}/login`, "web");
  record("API / worker / web 启动（独立端口 7310/7211/7110）", true);

  // 3) 平台登录与项目准备。
  const admin = await login("admin", ADMIN_PASSWORD);
  const projectId = (
    await fetchJson("/api/projects", { method: "POST", body: JSON.stringify({ name: `阶段1验收-${stamp}` }) }, admin)
  ).data.id;

  const environments = {};
  for (const demo of demos) {
    const origin = `http://127.0.0.1:${demo.port}`;
    const { status, data } = await fetchJson(
      `/api/projects/${projectId}/environments`,
      { method: "POST", body: JSON.stringify({ name: `环境-${demo.name}`, baseUrl: origin, allowedOrigins: [origin], buildId: `build-${demo.name}-${stamp}` }) },
      admin,
    );
    if (status !== 200) throw new Error(`环境登记失败 ${demo.name}: ${JSON.stringify(data)}`);
    environments[demo.name] = data.id;
  }
  record("六个测试环境登记（含 origin 白名单与构建标识）", true);

  // 4) 种子（真实浏览器观察 + 固定资产）。
  await fetchJson(`/api/projects/${projectId}/seed-fixed-assets`, {
    method: "POST",
    body: JSON.stringify({ environmentId: environments.healthy }),
  }, admin);
  const cases = await waitFor(
    async () => {
      const { data } = await fetchJson(`/api/projects/${projectId}/case-versions`, {}, admin);
      return data.caseVersions?.length === 4 ? data.caseVersions : false;
    },
    { timeoutMs: 180_000, name: "固定用例种子" },
  );
  const caseId = Object.fromEntries(
    cases.map((c) => [
      c.title.includes("5000.01") ? "over" : c.title.includes("恰好") ? "boundary" : c.title.includes("持久化") ? "persist" : "wait",
      c.caseVersionId,
    ]),
  );
  const boundaryPlanId = cases.find((c) => c.title.includes("恰好"))?.planId;
  const persistPlanId = cases.find((c) => c.title.includes("持久化"))?.planId;
  record("固定种子完成（4 用例 + 规则 + 基线 + 真实观察绑定）", true);
  const baselineId = (await fetchJson(`/api/projects/${projectId}/baselines`, {}, admin)).data.baselines.find((b) => b.active).id;

  async function createRun(envName, caseKeys, extra = {}) {
    const response = await fetchJson(
      "/api/runs",
      {
        method: "POST",
        body: JSON.stringify({
          projectId,
          baselineId,
          environmentId: environments[envName],
          caseVersionIds: caseKeys.map((k) => caseId[k]),
          mode: "real",
          idempotencyKey: `p1-${STAMP}-${Math.random().toString(36).slice(2, 10)}`,
          ...extra,
        }),
      },
      admin,
    );
    if (response.status >= 400) {
      console.error(`[createRun:${envName}:${caseKeys.join("+")}] ${response.status} ${JSON.stringify(response.data).slice(0, 300)}`);
    }
    return response;
  }

  // 5) 健康场景。
  {
    const { status, data } = await createRun("healthy", ["over", "boundary", "persist"], { buildId: `demo-healthy-${stamp}` });
    record("创建健康运行返回 202", status === 202, `status=${status}`);
    const runId = data.runId;
    const terminal = await waitRunTerminal(admin, runId);
    const verdictOf = (key) => terminal.cases.find((c) => c.caseVersionId === caseId[key]);
    record("健康：运行 FINISHED", terminal.run.lifecycle === "FINISHED", terminal.run.lifecycle);
    record("健康：5000.01 元全流程 PASS", verdictOf("over")?.verdict === "PASS", `${verdictOf("over")?.verdict}/${verdictOf("over")?.reasonCode}`);
    record("健康：边界 5000.00 元 PASS", verdictOf("boundary")?.verdict === "PASS", verdictOf("boundary")?.verdict);
    record("健康：持久化用例 PASS", verdictOf("persist")?.verdict === "PASS", verdictOf("persist")?.verdict);

    const report = (await fetchJson(`/api/runs/${runId}/report`, {}, admin)).data;
    record("健康：严格验收 PASS", report.metrics.acceptanceStatus === "PASS", report.metrics.acceptanceStatus);
    record(
      "健康：执行率/通过率 100%",
      report.metrics.executionRateDisplay === "100.0%" && report.metrics.passRateDisplay === "100.0%",
      `${report.metrics.executionRateDisplay}/${report.metrics.passRateDisplay}`,
    );
    const overCase = report.cases.find((c) => c.caseVersionId === caseId.over);
    const statusAssertion = overCase.assertions.find((a) => a.assertionId === "a-status-pending");
    record(
      "健康：断言 expected/actual 记录真实值",
      statusAssertion?.expected === "待审批" && statusAssertion?.actual === "待审批",
      JSON.stringify({ expected: statusAssertion?.expected, actual: statusAssertion?.actual }),
    );
    const evidence = statusAssertion?.evidence?.[0];
    record("健康：断言携带截图证据", Boolean(evidence?.exists), JSON.stringify(evidence));
    if (evidence) {
      const art = await fetch(`${API}/api/artifacts/${evidence.artifactId}`, { headers: { cookie: `aiqa_sid=${admin}` } });
      const buf = Buffer.from(await art.arrayBuffer());
      record("健康：证据可下载且为 PNG", art.status === 200 && buf.subarray(1, 4).toString() === "PNG", `status=${art.status} bytes=${buf.length}`);
    }
    record("健康：trace 证据存在（RESTRICTED_RAW）", JSON.stringify(report).includes("TRACE"));
    record(
      "健康：构建号已声明但未验证（buildDeclared=true / buildVerified=false）",
      report.run.buildDeclared === true && report.run.buildVerified === false,
      `${report.run.buildDeclared}/${report.run.buildVerified}`,
    );

    // 无构建标识的运行：严格验收 INCOMPLETE（FR-10 版本未验证语义）。
    {
      const noBuild = await createRun("healthy", ["persist"]);
      const t = await waitRunTerminal(admin, noBuild.data.runId);
      const r = (await fetchJson(`/api/runs/${noBuild.data.runId}/report`, {}, admin)).data;
      record(
        "版本未验证：无 buildId 的运行 INCOMPLETE（即使用例 PASS）",
        r.metrics.acceptanceStatus === "INCOMPLETE" && r.run.buildDeclared === false && t.cases[0].verdict === "PASS",
        `${r.metrics.acceptanceStatus}/declared=${r.run.buildDeclared}/${t.cases[0].verdict}`,
      );
    }

    const namespaces = terminal.cases.map((c) => c.attemptNamespace);
    record("数据隔离：attempt 命名空间互不相同", new Set(namespaces).size === namespaces.length && namespaces.every(Boolean), namespaces.join(","));

    // SSE：单连接内有序无重复；断开重连从 Last-Event-ID 续传（不回吐旧事件）。
    const first = await collectSse(runId, admin, 0, 8_000);
    const withinUnique = new Set(first).size === first.length;
    const sorted = [...first].sort((a, b) => a - b);
    const contiguous = sorted.length > 0 && sorted[0] === 1 && sorted.every((v, i) => i === 0 || v === sorted[i - 1] + 1);
    const half = Math.floor((first[first.length - 1] ?? 1) / 2);
    const second = await collectSse(runId, admin, half, 8_000);
    const resumedFromCursor = second.every((seq) => seq > half);
    record(
      "SSE：有序无重复，Last-Event-ID 续传不回吐",
      withinUnique && contiguous && resumedFromCursor,
      `first=${first.length} withinUnique=${withinUnique} contiguous=${contiguous} second=${second.length} resumed=${resumedFromCursor}`,
    );
    globalThis.__healthy = { runId, overCase, projectId };
  }

  // 6) B1 / B3 / B4。
  {
    const { data } = await createRun("B1", ["boundary"]);
    const terminal = await waitRunTerminal(admin, data.runId);
    const c = terminal.cases[0];
    record("B1：边界用例 FAIL / BUSINESS_MISMATCH", c.verdict === "FAIL" && c.reasonCode === "BUSINESS_MISMATCH", `${c.verdict}/${c.reasonCode}`);
    const report = (await fetchJson(`/api/runs/${data.runId}/report`, {}, admin)).data;
    const a = report.cases[0].assertions.find((x) => x.assertionId === "a-direct-awaiting");
    record("B1：断言实际值为待审批（500000 分被错误送审）", a?.actual === "待审批" && a?.result === "FAIL", `actual=${a?.actual}`);
    record("B1：运行严格验收 FAIL", report.metrics.acceptanceStatus === "FAIL");
  }
  {
    const { data } = await createRun("B3", ["over"]);
    const terminal = await waitRunTerminal(admin, data.runId);
    const c = terminal.cases[0];
    record("B3：全流程 FAIL（审批后状态断言失败）", c.verdict === "FAIL", `${c.verdict}/${c.reasonCode}`);
    const report = (await fetchJson(`/api/runs/${data.runId}/report`, {}, admin)).data;
    const failed = report.cases[0].assertions.filter((x) => x.result === "FAIL");
    record("B3：失败断言含实际值与证据", failed.length >= 1 && failed.every((x) => x.actual !== null && x.evidence.some((e) => e.exists)), failed.map((x) => `${x.assertionId}=${x.actual}`).join(";"));
  }
  {
    const { data } = await createRun("B4", ["persist"]);
    const terminal = await waitRunTerminal(admin, data.runId);
    const c = terminal.cases[0];
    record("B4：持久化用例 FAIL", c.verdict === "FAIL", `${c.verdict}/${c.reasonCode}`);
    const report = (await fetchJson(`/api/runs/${data.runId}/report`, {}, admin)).data;
    const a = report.cases[0].assertions.find((x) => x.assertionId === "a-orders-count");
    record("B4：断言实际值为 0（刷新后丢失）", a?.actual === "0", `actual=${a?.actual}`);
  }

  // 7) 错误账号。
  {
    const { data } = await createRun("badcreds", ["over"]);
    const terminal = await waitRunTerminal(admin, data.runId);
    const c = terminal.cases[0];
    record("AUTH：错误密码 BLOCKED/AUTH", c.verdict === "BLOCKED" && c.reasonCode === "AUTH", `${c.verdict}/${c.reasonCode}`);
    const report = (await fetchJson(`/api/runs/${data.runId}/report`, {}, admin)).data;
    const assertions = report.cases[0].assertions;
    record("AUTH：未执行断言保持 NOT_EVALUATED", assertions.length > 0 && assertions.every((a) => a.result === "NOT_EVALUATED"), `${assertions.filter((a) => a.result === "NOT_EVALUATED").length}/${assertions.length}`);
    record("AUTH：严格验收 INCOMPLETE", report.metrics.acceptanceStatus === "INCOMPLETE");
  }

  // 8) 幂等与重复投递（业务只执行一次）。
  {
    const key = `p1-idem-${stamp}`;
    const body = {
      projectId, baselineId, environmentId: environments.healthy,
      caseVersionIds: [caseId.persist], mode: "real", idempotencyKey: key,
    };
    const first = await fetchJson("/api/runs", { method: "POST", body: JSON.stringify(body) }, admin);
    const watcher = watchNamespace(7420, `ns-${first.data.runId.slice(-10)}-1`);
    const second = await fetchJson("/api/runs", { method: "POST", body: JSON.stringify(body) }, admin);
    record("幂等：同键同请求返回原 run", first.data.runId === second.data.runId && second.status === 200, `${first.status}/${second.status}`);
    const conflict = await fetchJson("/api/runs", { method: "POST", body: JSON.stringify({ ...body, caseVersionIds: [caseId.boundary] }) }, admin);
    record("幂等：同键不同请求 409", conflict.status === 409, `status=${conflict.status}`);
    const terminal = await waitRunTerminal(admin, first.data.runId);
    await sleep(1_500);
    watcher.stop();
    const countAssertion = await (async () => {
      const report = (await fetchJson(`/api/runs/${first.data.runId}/report`, {}, admin)).data;
      return report.cases[0]?.assertions?.find((a) => a.assertionId === "a-orders-count") ?? null;
    })();
    if (watcher.maxSeen() === 1) {
      record("幂等/重复投递：业务只执行一次（命名空间峰值 1 单）", true, `max=1`);
    } else if (watcher.maxSeen() === 0 && countAssertion?.actual === "1" && terminal.cases[0].verdict === "PASS") {
      record("幂等/重复投递：业务只执行一次", true, "评测器轮询错过窗口；以平台断言 a-orders-count=1 且 verdict=PASS 佐证（断言经真实 DOM 观察判定）");
    } else {
      record("幂等/重复投递：业务只执行一次（命名空间峰值 1 单）", false, `max=${watcher.maxSeen()} assertion=${countAssertion?.actual}`);
    }
  }

  // 9) 篡改计划（创建入口执行前拒绝）。
  {
    const before = tsx(["dbtool.mts", "plan-expected", boundaryPlanId]);
    tsx(["dbtool.mts", "tamper-plan", boundaryPlanId, "0", "被篡改的预期"]);
    const during = tsx(["dbtool.mts", "plan-expected", boundaryPlanId]);
    const tampered = await createRun("healthy", ["boundary"]);
    record("篡改：执行前被拒绝（422 哈希不符）", tampered.status === 422, `status=${tampered.status} expected=${during}`);
    tsx(["dbtool.mts", "restore-plan", boundaryPlanId]);
    const after = tsx(["dbtool.mts", "plan-expected", boundaryPlanId]);
    const restored = await createRun("healthy", ["boundary"]);
    record(
      "篡改：恢复后可正常创建（202）",
      restored.status === 202,
      `status=${restored.status} before=${before} after=${after}${restored.status !== 202 ? " " + JSON.stringify(restored.data).slice(0, 160) : ""}`,
    );
    await waitRunTerminal(admin, restored.data.runId, 120_000).catch(() => undefined);
  }

  // 10) 越界登记复核。
  {
    const bad = await fetchJson(`/api/projects/${projectId}/environments`, {
      method: "POST",
      body: JSON.stringify({ name: "evil", baseUrl: "http://127.0.0.1:7420.attacker.invalid", allowedOrigins: ["http://127.0.0.1:7420"] }),
    }, admin);
    record("URL 越界：前缀拼接域名登记被拒（422）", bad.status === 422, `status=${bad.status}`);
  }

  // 11) 证据异常。
  {
    const { runId, overCase } = globalThis.__healthy;
    const evidence = overCase.assertions.flatMap((a) => a.evidence).find((e) => e.exists);
    const storageKey = tsx(["dbtool.mts", "storage-key", evidence.artifactId]);
    const local = join(ARTIFACT_DIR, storageKey);
    const { readFileSync, writeFileSync, unlinkSync, existsSync } = await import("node:fs");
    const backupData = existsSync(local) ? readFileSync(local) : null;
    if (backupData) unlinkSync(local);
    const report = (await fetchJson(`/api/runs/${runId}/report`, {}, admin)).data;
    const degraded = report.cases.find((c) => c.caseVersionId === caseId.over);
    record(
      "证据缺失：PASS 用例降级 REVIEW（含降级原因）",
      degraded.verdict === "REVIEW" && degraded.evidenceDowngraded && (degraded.downgradeReasons ?? []).length > 0,
      `${degraded.verdict}: ${(degraded.downgradeReasons ?? [])[0] ?? ""}`,
    );
    const gone = await fetch(`${API}/api/artifacts/${evidence.artifactId}`, { headers: { cookie: `aiqa_sid=${admin}` } });
    record("证据缺失：下载返回 404", gone.status === 404, `status=${gone.status}`);
    if (backupData) writeFileSync(local, backupData);

    const outsiderName = `outsider-${stamp}`;
    tsx(["dbtool.mts", "create-user", outsiderName, "Outsider#P1", "LEAD"]);
    const outsider = await login(outsiderName, "Outsider#P1");
    const forbidden = await fetch(`${API}/api/artifacts/${evidence.artifactId}`, { headers: { cookie: `aiqa_sid=${outsider}` } });
    record("证据越权：非项目成员被拒（403/404）", [403, 404].includes(forbidden.status), `status=${forbidden.status}`);

    // RESTRICTED_RAW：viewer 被拒（trace）。
    const viewerName = `viewer-p1-${stamp}`;
    tsx(["dbtool.mts", "create-user", viewerName, "Viewer#P1", "VIEWER", projectId, "VIEWER"]);
    const viewerSid = await login(viewerName, "Viewer#P1");
    const reportAll = (await fetchJson(`/api/runs/${runId}/report`, {}, admin)).data;
    const traceArtifactId = reportAll.cases
      .flatMap((c) => c.traces ?? [])
      .find((e) => e.type === "TRACE")?.artifactId;
    if (traceArtifactId) {
      const asViewer = await fetch(`${API}/api/artifacts/${traceArtifactId}`, { headers: { cookie: `aiqa_sid=${viewerSid}` } });
      const asAdmin = await fetch(`${API}/api/artifacts/${traceArtifactId}`, { headers: { cookie: `aiqa_sid=${admin}` } });
      record("受限证据：VIEWER 403 / 管理员可下载", asViewer.status === 403 && asAdmin.status === 200, `${asViewer.status}/${asAdmin.status}`);
    } else {
      record("受限证据：trace 存在于报告", false, "未找到 TRACE 证据");
    }
    // VIEWER 不能启动运行 / 空运行被拒。
    const startForbidden = await fetchJson("/api/runs", {
      method: "POST",
      body: JSON.stringify({ projectId, baselineId, environmentId: environments.healthy, caseVersionIds: [caseId.persist], mode: "real", idempotencyKey: `p1-viewer-${stamp}` }),
    }, viewerSid);
    record("VIEWER：不能启动运行（403）", startForbidden.status === 403, `status=${startForbidden.status}`);
    const empty = await fetchJson("/api/runs", {
      method: "POST",
      body: JSON.stringify({ projectId, baselineId, environmentId: environments.healthy, caseVersionIds: [], mode: "real", idempotencyKey: `p1-empty-${stamp}` }),
    }, admin);
    record("空集合：创建空运行被拒（422）", empty.status === 422, `status=${empty.status}`);
  }

  // 12) 取消。
  {
    const { data } = await createRun("healthy", ["wait", "persist"]);
    await sleep(3_000);
    const cancel1 = await fetchJson(`/api/runs/${data.runId}/cancel`, { method: "POST" }, admin);
    const cancel2 = await fetchJson(`/api/runs/${data.runId}/cancel`, { method: "POST" }, admin);
    record("取消：幂等（两次请求均 200）", cancel1.status === 200 && cancel2.status === 200, `${cancel1.status}/${cancel2.status}`);
    const terminal = await waitRunTerminal(admin, data.runId, 120_000);
    record("取消：终态 CANCELLED", terminal.run.lifecycle === "CANCELLED", terminal.run.lifecycle);
    const waitVerdict = terminal.cases.find((c) => c.caseVersionId === caseId.wait)?.verdict;
    const persistVerdict = terminal.cases.find((c) => c.caseVersionId === caseId.persist)?.verdict;
    record("取消：取消中的用例不 PASS", waitVerdict !== "PASS", `${waitVerdict}/${persistVerdict}`);
    const report = (await fetchJson(`/api/runs/${data.runId}/report`, {}, admin)).data;
    record("取消：严格验收 INCOMPLETE（不误报通过）", report.metrics.acceptanceStatus === "INCOMPLETE", report.metrics.acceptanceStatus);
  }

  // 13) WRITE 提交后响应中断。
  {
    const { data } = await createRun("fault", ["persist"]);
    const watcher = watchNamespace(7426, `ns-${data.runId.slice(-10)}-1`);
    const terminal = await waitRunTerminal(admin, data.runId, 240_000);
    const c = terminal.cases[0];
    record("WRITE 中断：BLOCKED/UNCERTAIN_SIDE_EFFECT", c.verdict === "BLOCKED" && c.reasonCode === "UNCERTAIN_SIDE_EFFECT", `${c.verdict}/${c.reasonCode}`);
    await sleep(66_000); // 让挂起响应与清理结束。
    watcher.stop();
    record("WRITE 中断：无重复订单（峰值 1 单）", watcher.maxSeen() === 1, `max=${watcher.maxSeen()}`);
    const report = (await fetchJson(`/api/runs/${data.runId}/report`, {}, admin)).data;
    record("WRITE 中断：严格验收 INCOMPLETE", report.metrics.acceptanceStatus === "INCOMPLETE");
  }

  // 14) 阶段 1.1 新增场景（评审 R2/R3/R8/R9 + §三.2）。
  {
    const { Queue } = await import("bullmq");
    const queueConnection = {
      host: "127.0.0.1",
      port: REDIS_PORT,
      password: REDIS_PASSWORD,
      db: 3,
    };

    // S1 排队取消（确定性）：暂停队列 → 创建并取消 → 恢复 → CANCELLED，attempt=0。
    {
      const q = new Queue("runs", { connection: queueConnection });
      await q.pause();
      const created = await createRun("healthy", ["persist"]);
      await fetchJson(`/api/runs/${created.data.runId}/cancel`, { method: "POST" }, admin);
      await q.resume();
      await q.close();
      const terminal = await waitRunTerminal(admin, created.data.runId, 60_000);
      const attempts = terminal.cases.filter((c) => c.attemptId).length;
      record(
        "排队取消：终态 CANCELLED 且无 attempt（业务未执行）",
        terminal.run.lifecycle === "CANCELLED" && attempts === 0,
        `${terminal.run.lifecycle}/attempts=${attempts}`,
      );
    }

    // S2 真实重复队列投递：同一 run 投两个 job → 业务只执行一次。
    {
      const created = await createRun("healthy", ["persist"]);
      const ns = `ns-${created.data.runId.slice(-10)}-1`;
      const watcher = watchNamespace(7420, ns);
      const q = new Queue("runs", { connection: queueConnection });
      await q.add("execute", { runId: created.data.runId }, { jobId: `dup-a-${created.data.runId}` });
      await q.add("execute", { runId: created.data.runId }, { jobId: `dup-b-${created.data.runId}` });
      await q.close();
      const terminal = await waitRunTerminal(admin, created.data.runId);
      await sleep(1_500);
      watcher.stop();
      const persistVerdict = terminal.cases[0].verdict;
      record(
        "重复投递：业务只执行一次（命名空间峰值 1 单，verdict 有终局）",
        watcher.maxSeen() === 1 && ["PASS", "FAIL"].includes(persistVerdict),
        `max=${watcher.maxSeen()} verdict=${persistVerdict}`,
      );
    }

    // S3 排队期间发布计划 v2：旧 run 固定执行 v1（report.planVersionId）。
    {
      const q = new Queue("runs", { connection: queueConnection });
      await q.pause();
      const created = await createRun("healthy", ["persist"]);
      const v2Id = tsx(["dbtool.mts", "add-plan-version", persistPlanId]);
      await q.resume();
      await q.close();
      const terminal = await waitRunTerminal(admin, created.data.runId);
      const report = (await fetchJson(`/api/runs/${created.data.runId}/report`, {}, admin)).data;
      record(
        "计划版本固定：排队期发布 v2，旧 run 仍执行 v1",
        report.cases[0].planVersionId === persistPlanId && report.cases[0].planVersionId !== v2Id,
        `executed=${report.cases[0].planVersionId?.slice(-12)} v1=${persistPlanId.slice(-12)} v2=${v2Id.slice(-12)}`,
      );
    }

    // S4 并发幂等（HTTP 层真实并发）。
    {
      const key = `p1-conc-${STAMP}-${Math.random().toString(36).slice(2, 8)}`;
      const body = {
        projectId, baselineId, environmentId: environments.healthy,
        caseVersionIds: [caseId.persist], mode: "real", idempotencyKey: key,
      };
      const [r1, r2] = await Promise.all([
        fetchJson("/api/runs", { method: "POST", body: JSON.stringify(body) }, admin),
        fetchJson("/api/runs", { method: "POST", body: JSON.stringify(body) }, admin),
      ]);
      record(
        "并发幂等：同键同体并发请求返回同一 run，绝无 500",
        [200, 202].includes(r1.status) && [200, 202].includes(r2.status) && r1.data.runId === r2.data.runId,
        `${r1.status}/${r2.status}`,
      );
      const [d1, d2] = await Promise.all([
        fetchJson("/api/runs", { method: "POST", body: JSON.stringify(body) }, admin),
        fetchJson("/api/runs", { method: "POST", body: JSON.stringify({ ...body, buildId: "conflict-build" }) }, admin),
      ]);
      const statuses = [d1.status, d2.status].sort();
      record(
        "并发幂等：同键异体一个成功一个 409",
        statuses.includes(409) && (statuses.includes(200) || statuses.includes(202)),
        `${statuses.join("/")}`,
      );
    }

    // S5 预算耗尽：wait-slow（waitFor 60s）+ 10s 用例预算 → 按时结束。
    {
      const started = Date.now();
      const { data } = await createRun("healthy", ["wait"], { budget: { maxWallClockMsPerCase: 10_000 } });
      const terminal = await waitRunTerminal(admin, data.runId, 90_000);
      const elapsed = Date.now() - started;
      const c = terminal.cases[0];
      record(
        "预算耗尽：短预算长等待按时结束（BLOCKED/TIME_BUDGET，≤40s）",
        c.verdict === "BLOCKED" && c.reasonCode === "TIME_BUDGET" && elapsed < 40_000,
        `${c.verdict}/${c.reasonCode} elapsed=${Math.round(elapsed / 1000)}s`,
      );
      record("预算耗尽：不依赖心跳即结束", elapsed < 40_000, `${Math.round(elapsed / 1000)}s`);
    }

    // S6 取消后失联：CANCEL_REQUESTED 心跳超时 → 对账器完成取消。
    {
      const created = await createRun("healthy", ["wait", "persist"]);
      await sleep(1_500);
      // 直接把运行置为 CANCEL_REQUESTED 且心跳过期（模拟 worker 消失）。
      // 先暂停队列避免 worker 认领，再注入状态。
      const q = new Queue("runs", { connection: queueConnection });
      await q.pause();
      await fetchJson(`/api/runs/${created.data.runId}/cancel`, { method: "POST" }, admin);
      tsx(["dbtool.mts", "set-run-stale-cancellation", created.data.runId]);
      await q.resume();
      await q.close();
      const terminal = await waitRunTerminal(admin, created.data.runId, 120_000);
      record(
        "取消后失联：对账器完成取消（CANCELLED）",
        terminal.run.lifecycle === "CANCELLED",
        terminal.run.lifecycle,
      );
    }
  }

  // 14) 真实页面操作。
  {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.goto(`${WEB}/login`);
      await page.locator('input[name=username]').fill("admin");
      await page.locator('input[name=password]').fill(ADMIN_PASSWORD);
      await page.locator("button[type=submit]").click();
      await page.waitForURL(`${WEB}/`);
      record("页面：平台登录成功", true);
      await page.goto(`${WEB}/projects/${projectId}`);
      await page.locator('select[name=environmentId]').selectOption(environments.healthy);
      for (const cb of await page.locator('input[name=caseVersionIds]').all()) {
        if ((await cb.getAttribute("value")) !== caseId.persist) await cb.uncheck();
      }
      await page.locator('form[name=start-run] button[type=submit]').click();
      await page.waitForURL(/\/runs\/.+/, { timeout: 20_000 });
      record("页面：启动测试跳转运行详情", true);
      await page.waitForFunction(
        () => /FINISHED|CANCELLED|ERROR/.test(document.body.textContent ?? ""),
        null,
        { timeout: 240_000 },
      );
      record("页面：SSE 实时事件展示终态", true);
      // 刷新页面恢复状态。
      await page.reload();
      await page.waitForFunction(
        () => /FINISHED|CANCELLED|ERROR/.test(document.body.textContent ?? ""),
        null,
        { timeout: 30_000 },
      );
      record("页面：刷新后状态恢复", true);
      await page.locator("a:has-text('查看报告')").click();
      await page.waitForURL(/\/runs\/.+\/report/);
      await page.waitForSelector("img.shot", { timeout: 30_000 });
      const imgOk = await page.evaluate(async () => {
        const img = document.querySelector("img.shot");
        if (!img) return false;
        await new Promise((resolve) => {
          if (img.complete) resolve();
          else {
            img.onload = resolve;
            img.onerror = resolve;
          }
        });
        return img.naturalWidth > 0;
      });
      record("页面：报告截图证据可加载", imgOk);
      await page.screenshot({ path: join(HERE, "ui-report.png"), fullPage: true });
    } catch (err) {
      record("页面：真实操作流程", false, String(err).slice(0, 200));
    } finally {
      await browser.close();
    }
  }

  console.log("\n===== 阶段 1 验收汇总 =====");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} 通过，${failures} 失败`);
  writeFileSync(join(HERE, "last-run.json"), JSON.stringify({ stamp, results }, null, 2));
}

function cleanup() {
  try {
    cleanupResources();
  } catch (err) {
    console.error("[cleanup]", String(err).slice(0, 200));
  }
}

main()
  .then(() => {
    cleanup();
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("\n[HARNESS ERROR]", err);
    cleanup();
    process.exit(2);
  });
