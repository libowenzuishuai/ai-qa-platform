/**
 * 目标地址白名单策略（PRD FR-01 / §10；评审 R2）。
 *
 * 使用 URL 解析后的 protocol/hostname/port（即 origin）精确比较，
 * 不做字符串前缀匹配 —— `https://qa.example.com.attacker.invalid`、
 * `https://qa.example.com@attacker.invalid`、`https://qa.example.com:444`
 * 都不能通过 `https://qa.example.com` 的白名单。
 * 仅允许 http/https，拒绝 userinfo；origin 白名单与路径规则分开处理。
 * 执行器导航/重定向前必须用同一函数再校验最终 URL。
 */

const DEFAULT_PORTS: Record<string, string> = {
  "http:": "80",
  "https:": "443",
};

export type OriginResult =
  | { ok: true; origin: string }
  | { ok: false; reason: string };

/** 规范化为 http(s) origin；拒绝协议相对、userinfo、非 http(s)。 */
export function normalizeHttpOrigin(input: string): OriginResult {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: "URL 无法解析" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `仅允许 http/https，收到 ${url.protocol}` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "URL 不允许携带 username/password（userinfo）" };
  }
  const defaultPort = DEFAULT_PORTS[url.protocol];
  const port = url.port === "" ? defaultPort : url.port;
  const origin =
    port === defaultPort
      ? `${url.protocol}//${url.hostname}`
      : `${url.protocol}//${url.hostname}:${port}`;
  return { ok: true, origin };
}

export type EnvironmentOriginsResult =
  | { ok: true; baseUrlOrigin: string }
  | { ok: false; field: "baseUrl" | "allowedOrigins"; reason: string };

/**
 * 校验环境登记的 baseUrl 与 allowedOrigins：
 * - 每个白名单条目本身必须是合法 http(s) URL 且不含 userinfo；
 * - baseUrl 的规范化 origin 必须与至少一个白名单 origin 完全相等。
 */
export function validateEnvironmentOrigins(
  baseUrl: string,
  allowedOrigins: string[],
): EnvironmentOriginsResult {
  const normalizedAllowed: string[] = [];
  for (const entry of allowedOrigins) {
    const result = normalizeHttpOrigin(entry);
    if (!result.ok) {
      return { ok: false, field: "allowedOrigins", reason: `白名单条目 ${entry} 不合法：${result.reason}` };
    }
    normalizedAllowed.push(result.origin);
  }
  const base = normalizeHttpOrigin(baseUrl);
  if (!base.ok) {
    return { ok: false, field: "baseUrl", reason: `baseUrl 不合法：${base.reason}` };
  }
  if (!normalizedAllowed.includes(base.origin)) {
    return {
      ok: false,
      field: "baseUrl",
      reason: `baseUrl origin（${base.origin}）不在 allowedOrigins 白名单内`,
    };
  }
  return { ok: true, baseUrlOrigin: base.origin };
}
