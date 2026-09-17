/**
 * 导航与网络目的地策略（PRD FR-01/§10）。
 *
 * 执行器在发出请求前拦截：主框架导航、子资源、重定向与弹窗的目的地
 * 都必须落在 allowedOrigins ∪ dependencyOrigins 内；越界请求被 abort
 * 并记录。与 apps/api 的 url-policy 语义一致（规范化 origin 精确比较）。
 */

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

export function normalizeOrigin(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    const defaultPort = DEFAULT_PORTS[url.protocol];
    const port = url.port === "" ? defaultPort : url.port;
    return port === defaultPort
      ? `${url.protocol}//${url.hostname}`
      : `${url.protocol}//${url.hostname}:${port}`;
  } catch {
    return null;
  }
}

export interface NavigationPolicy {
  allowedOrigins: string[];
  dependencyOrigins: string[];
}

export interface PolicyDecision {
  allowed: boolean;
  /** 命中的白名单类别。 */
  via: "allowed" | "dependency" | "special" | null;
  origin: string | null;
}

const SPECIAL_OK = ["about:blank"];

export function checkDestination(rawUrl: string, policy: NavigationPolicy): PolicyDecision {
  if (SPECIAL_OK.some((prefix) => rawUrl === prefix || rawUrl.startsWith(prefix))) {
    return { allowed: true, via: "special", origin: null };
  }
  const origin = normalizeOrigin(rawUrl);
  if (!origin) return { allowed: false, via: null, origin: null };
  const allowedSet = new Set(policy.allowedOrigins.map((o) => normalizeOrigin(o)).filter(Boolean));
  const depSet = new Set(policy.dependencyOrigins.map((o) => normalizeOrigin(o)).filter(Boolean));
  if (allowedSet.has(origin)) return { allowed: true, via: "allowed", origin };
  if (depSet.has(origin)) return { allowed: true, via: "dependency", origin };
  return { allowed: false, via: null, origin };
}

/** 解析相对路径/模板到绝对 URL（受 contracts 同源规则约束的输入）。 */
export function resolveTargetUrl(
  pathOrTemplate: string,
  baseUrl: string,
  variables: Record<string, string>,
): { ok: true; url: string } | { ok: false; error: string } {
  let filled = pathOrTemplate;
  if (pathOrTemplate.includes("{")) {
    filled = pathOrTemplate.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (whole, name: string) => {
      const value = variables[name];
      if (value === undefined) throw new Error(`模板变量 {${name}} 未定义`);
      return encodeURIComponent(value);
    });
  }
  let url: URL;
  try {
    url = new URL(filled, baseUrl);
  } catch {
    return { ok: false, error: `无法解析目标 URL：${filled}` };
  }
  const baseOrigin = normalizeOrigin(baseUrl);
  if (!baseOrigin || url.origin !== baseOrigin) {
    return { ok: false, error: `目标 ${url.origin} 离开环境 baseUrl（${baseOrigin}）` };
  }
  return { ok: true, url: url.toString() };
}
