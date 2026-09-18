import type { TextModelAdapter, VisionModelAdapter } from "@ai-qa/contracts";
import type { ModelChannelConfig } from "./config.js";
import { MockTextAdapter, MockVisionAdapter } from "./mock-adapter.js";
import {
  MoonshotTextAdapter,
  MoonshotVisionAdapter,
  type MoonshotAdapterOptions,
} from "./moonshot-adapter.js";

/**
 * 适配器工厂：按通道配置构造。
 * - provider="mock" → 显式 mock（输出标 simulated，从 real 指标排除）；
 * - provider="moonshot" → 真实适配器（缺配置在 loadModelEnvConfig 已拒）。
 * 绝不因缺配置静默换 mock。
 */
export function createTextAdapter(
  config: ModelChannelConfig,
  options?: Omit<MoonshotAdapterOptions, "config">,
): TextModelAdapter {
  if (config.provider === "mock") return new MockTextAdapter();
  return new MoonshotTextAdapter({ ...options, config });
}

export function createVisionAdapter(
  config: ModelChannelConfig,
  options: Omit<MoonshotAdapterOptions, "config"> & {
    readImage: NonNullable<MoonshotAdapterOptions["readImage"]>;
  },
): VisionModelAdapter {
  if (config.provider === "mock") return new MockVisionAdapter();
  return new MoonshotVisionAdapter({ ...options, config });
}
