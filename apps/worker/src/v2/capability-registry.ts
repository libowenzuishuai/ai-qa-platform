import type { CapabilityAdapter } from "@ai-qa/adapter-sdk";

/**
 * v2 能力注册表（HAR-01）：新能力通过 registerLocalAdapter 注册，
 * 不修改核心调度器。本地适配器在执行器进程内加载；远程能力按安装
 * 记录的 endpoint 走 remote-http 协议。
 *
 * 注册表按 (capabilityId, version) 精确匹配；版本不匹配即拒绝
 * （运行固定版本，不用"已安装"绕过）。
 */

export interface LocalRegistration {
  kind: "local";
  adapter: CapabilityAdapter;
}

const localAdapters = new Map<string, CapabilityAdapter>();

/** SDK 注册入口（样例/插件调用；幂等：重复注册同版本以先注册者为准）。 */
export function registerLocalAdapter(adapter: CapabilityAdapter): void {
  const key = `${adapter.manifest.id}@${adapter.manifest.version}`;
  if (!localAdapters.has(key)) localAdapters.set(key, adapter);
}

export function resolveLocal(capabilityId: string, version: string): LocalRegistration | null {
  const adapter = localAdapters.get(`${capabilityId}@${version}`);
  return adapter ? { kind: "local", adapter } : null;
}

export function registeredLocalCapabilities(): Array<{ id: string; version: string }> {
  return [...localAdapters.values()].map((a) => ({ id: a.manifest.id, version: a.manifest.version }));
}
