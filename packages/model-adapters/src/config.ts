import { ModelError } from "./error.js";

/**
 * 运行时模型配置（PRD FR-11）：
 * - 文本/视觉独立三元组（provider/baseUrl/model/apiKey）；
 * - real 模式缺任何必需项 → MODEL_NOT_CONFIGURED，绝不自动降级 mock；
 * - mock 是显式选择（provider="mock"），输出必须标记 simulated。
 */

export interface ModelChannelConfig {
  provider: "moonshot" | "mock";
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface ModelEnvConfig {
  text: ModelChannelConfig;
  vision: ModelChannelConfig;
}

function loadChannel(prefix: "AIQA_TEXT" | "AIQA_VISION"): ModelChannelConfig {
  const provider = process.env[`${prefix}_PROVIDER`] ?? "";
  if (provider === "mock") {
    // mock 不需要网络与密钥；baseUrl/model 用稳定占位。
    return { provider: "mock", baseUrl: "http://mock.invalid", model: "mock", apiKey: "mock" };
  }
  const missing: string[] = [];
  if (process.env[`${prefix}_API_KEY`]) {
    // 密钥存在：不读取其值进日志/报告，仅传递。
  } else {
    missing.push(`${prefix}_API_KEY`);
  }
  for (const key of [`${prefix}_BASE_URL`, `${prefix}_MODEL`, `${prefix}_PROVIDER`]) {
    if (!process.env[key]) missing.push(key);
  }
  if (missing.length > 0) {
    throw new ModelError(
      "MODEL_NOT_CONFIGURED",
      `real 模式缺少 ${prefix} 通道配置（禁止自动降级 mock）`,
      { provider: provider || "unset", missing },
    );
  }
  return {
    provider: provider as "moonshot",
    baseUrl: process.env[`${prefix}_BASE_URL`]!,
    model: process.env[`${prefix}_MODEL`]!,
    apiKey: process.env[`${prefix}_API_KEY`]!,
  };
}

/** 从环境变量加载双通道配置。real 缺配置抛 MODEL_NOT_CONFIGURED。 */
export function loadModelEnvConfig(env: NodeJS.ProcessEnv = process.env): ModelEnvConfig {
  const prev = process.env;
  // 注入式读取（测试用），不污染真实 process.env。
  process.env = env as NodeJS.ProcessEnv;
  try {
    return { text: loadChannel("AIQA_TEXT"), vision: loadChannel("AIQA_VISION") };
  } finally {
    process.env = prev;
  }
}
