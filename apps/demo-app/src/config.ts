/**
 * demo-app 配置。
 *
 * 缺陷模式（B1–B4）只通过环境变量 DEMO_BUG_MODES 控制，
 * 不出现在任何页面、API 响应或前端代码中 —— 只有评测器知道。
 */
export interface DemoConfig {
  port: number;
  host: string;
  /** sqlite 数据文件路径 */
  dbPath: string;
  /** 评测夹具令牌；请求 /api/fixtures/* 必须携带 x-fixture-token */
  fixtureToken: string;
  /** 缺陷模式集合，如 ["B1","B3"]；空集合 = 健康版本 */
  bugModes: Set<BugMode>;
  /** 故障注入（评测器专用）：如 submit-commit-hang */
  faults: Set<FaultMode>;
  sessionSecret: string;
}

export const BUG_MODES = ["B1", "B2", "B3", "B4"] as const;
export type BugMode = (typeof BUG_MODES)[number];

/**
 * 故障注入（评审/验收驱动使用，与缺陷模式相互独立）：
 * - submit-commit-hang：提交采购单时先落库、再挂起响应 60s，
 *   用于验证执行器对“写操作结果不确定”的处理（不得盲目重放）。
 */
export const FAULT_MODES = ["submit-commit-hang"] as const;
export type FaultMode = (typeof FAULT_MODES)[number];

export function loadConfig(): DemoConfig {
  const rawModes = (process.env.DEMO_BUG_MODES ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
  const unknown = rawModes.filter((m) => !(BUG_MODES as readonly string[]).includes(m));
  if (unknown.length > 0) {
    throw new Error(`未知的缺陷模式: ${unknown.join(",")}；可选值: ${BUG_MODES.join("/")}`);
  }
  const rawFaults = (process.env.DEMO_FAULTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  const unknownFaults = rawFaults.filter((f) => !(FAULT_MODES as readonly string[]).includes(f));
  if (unknownFaults.length > 0) {
    throw new Error(`未知的故障模式: ${unknownFaults.join(",")}；可选值: ${FAULT_MODES.join("/")}`);
  }
  return {
    port: Number(process.env.DEMO_PORT ?? 7400),
    host: process.env.DEMO_HOST ?? "127.0.0.1",
    dbPath: process.env.DEMO_DB_PATH ?? "data/demo-app.sqlite",
    fixtureToken: process.env.DEMO_FIXTURE_TOKEN ?? "dev-fixture-token",
    bugModes: new Set(rawModes as BugMode[]),
    faults: new Set(rawFaults as FaultMode[]),
    sessionSecret: process.env.DEMO_SESSION_SECRET ?? "demo-session-secret-dev-only",
  };
}

export function hasFault(config: DemoConfig, fault: FaultMode): boolean {
  return config.faults.has(fault);
}

export function hasBug(config: DemoConfig, mode: BugMode): boolean {
  return config.bugModes.has(mode);
}
