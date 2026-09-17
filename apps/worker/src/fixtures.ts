/**
 * demo-app 可信夹具客户端（namespace 级初始化/清理 + 评测器状态读取）。
 *
 * 网络边界（评审 R1）：只向显式允许的目标站发起请求；不跟随重定向
 * （避免令牌被重定向目的地收到）；所有请求带超时（评审 R9）。
 * 仅 worker/评测器使用；不向被测智能体暴露。
 */
import type { NavigationPolicy } from "@ai-qa/test-runtime";
import { checkDestination } from "@ai-qa/test-runtime";

export interface NsOrder {
  id: string;
  title: string;
  amountCents: number;
  status: string;
}

export class DemoFixtureClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs: number = 10_000,
  ) {}

  /** 目标必须在白名单内（baseUrl 本身即允许目标）。 */
  private guard(): NavigationPolicy {
    return { allowedOrigins: [this.baseUrl], dependencyOrigins: [] };
  }

  private async call(path: string, init?: RequestInit, deadline?: number): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const decision = checkDestination(url, this.guard());
    if (!decision.allowed) {
      throw new Error(`夹具目标被策略拒绝：${url}`);
    }
    const remaining = deadline === undefined ? this.timeoutMs : Math.min(this.timeoutMs, deadline - Date.now());
    if (remaining <= 0) throw new Error("夹具请求未发出：运行时间预算耗尽");
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      headers: {
        "x-fixture-token": this.token,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(remaining),
    });
    // redirect: manual 时 3xx 返回 opaque 重定向 —— 视为违规（不应发生）。
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      throw new Error(`夹具目标 ${path} 返回重定向（拒绝跟随，令牌不得外发）`);
    }
    if (!response.ok) {
      throw new Error(`夹具接口 ${path} 失败：HTTP ${response.status}`);
    }
    return response.json();
  }

  async resetNamespace(namespace: string, deadline?: number): Promise<{ deleted: number }> {
    const result = (await this.call("/api/fixtures/ns/reset", {
      method: "POST",
      body: JSON.stringify({ namespace }),
    }, deadline)) as { ok: boolean; deleted: number };
    if (!result.ok) throw new Error("namespace 重置未成功");
    return { deleted: result.deleted };
  }

  async namespaceState(namespace: string): Promise<NsOrder[]> {
    const result = (await this.call(
      `/api/fixtures/ns/state?namespace=${encodeURIComponent(namespace)}`,
    )) as { ok: boolean; orders: NsOrder[] };
    return result.orders;
  }
}
