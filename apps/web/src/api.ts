/**
 * 平台 API 客户端（服务端）：web 会话 cookie 即 API 会话 cookie，
 * 由 web 服务端转发；浏览器不直连数据库/Redis，也不获取凭据。
 */
export const API_BASE = process.env.API_BASE_URL ?? "http://127.0.0.1:7300";
// 每次调用时读取（测试可动态指向 in-process API 实例）。
function apiBase(): string {
  return process.env.API_BASE_URL ?? API_BASE;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; sid?: string | undefined } = {},
): Promise<{ status: number; data: T }> {
  const response = await fetch(`${apiBase()}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(init.sid ? { cookie: `aiqa_sid=${init.sid}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const err = data as { code?: string; message?: string; details?: unknown };
    throw new ApiError(
      response.status,
      err.code ?? "UNKNOWN",
      err.message ?? `API ${response.status}`,
      err.details,
    );
  }
  return { status: response.status, data: data as T };
}
