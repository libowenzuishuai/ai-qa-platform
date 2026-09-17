/**
 * demo-app 可信夹具客户端（namespace 级初始化/清理 + 评测器状态读取）。
 * 仅 worker/评测器使用；不向被测智能体暴露。
 */

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
  ) {}

  private async call(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "x-fixture-token": this.token,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new Error(`夹具接口 ${path} 失败：HTTP ${response.status}`);
    }
    return response.json();
  }

  async resetNamespace(namespace: string): Promise<{ deleted: number }> {
    const result = (await this.call("/api/fixtures/ns/reset", {
      method: "POST",
      body: JSON.stringify({ namespace }),
    })) as { ok: boolean; deleted: number };
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
