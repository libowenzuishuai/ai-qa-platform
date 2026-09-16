#!/usr/bin/env node
/**
 * 黄金验收运行器（评测器专用）。
 *
 * 对健康版本与 B1–B4 四种缺陷模式分别：
 *   1. 以独立端口、独立数据库启动 demo-app；
 *   2. 运行对应的 Playwright 黄金测试；
 *   3. 汇总结果 —— 任何模式失败即整体失败。
 *
 * 用法：pnpm --filter @ai-qa/demo-app test:golden
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODES = ["healthy", "B1", "B2", "B3", "B4"];
const BASE_PORT = 7410;

function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) return resolve(true);
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) return reject(new Error(`health timeout on :${port}`));
      setTimeout(tick, 300);
    };
    tick();
  });
}

function runPlaywright(spec, port) {
  const result = spawnSync(
    "pnpm",
    ["exec", "playwright", "test", join("tests-golden", spec), `--reporter=list`],
    {
      cwd: pkgRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        DEMO_BASE_URL: `http://127.0.0.1:${port}`,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      },
    },
  );
  return result.status === 0;
}

const summary = [];
let failed = false;

for (const [i, mode] of MODES.entries()) {
  const port = BASE_PORT + i;
  const dbDir = mkdtempSync(join(tmpdir(), `demo-golden-${mode}-`));
  const server = spawn("pnpm", ["exec", "tsx", "src/server.ts"], {
    cwd: pkgRoot,
    stdio: ["ignore", "ignore", "inherit"],
    env: {
      ...process.env,
      DEMO_PORT: String(port),
      DEMO_HOST: "127.0.0.1",
      DEMO_DB_PATH: join(dbDir, "demo.sqlite"),
      DEMO_BUG_MODES: mode === "healthy" ? "" : mode,
      DEMO_LOG_LEVEL: "error",
      NO_PROXY: "127.0.0.1,localhost",
    },
  });
  let ok = false;
  let note = "";
  try {
    await waitForHealth(port, 20_000);
    ok = runPlaywright(`${mode === "healthy" ? "healthy" : mode.toLowerCase()}.spec.ts`, port);
  } catch (err) {
    note = err.message;
  } finally {
    server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 400));
    server.kill("SIGKILL");
    rmSync(dbDir, { recursive: true, force: true });
  }
  summary.push({ mode, ok, note });
  if (!ok) failed = true;
}

console.log("\n===== 黄金验收汇总 =====");
for (const { mode, ok, note } of summary) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${mode.padEnd(8)}${note ? `  (${note})` : ""}`);
}
process.exit(failed ? 1 : 0);
