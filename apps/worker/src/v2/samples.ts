import { registerLocalAdapter } from "./capability-registry.js";
import { HttpReadAdapter } from "@ai-qa/adapter-sdk/samples/http-checker";
import { DraftOpsAdapter } from "@ai-qa/adapter-sdk/samples/draft-ops";

/**
 * SDK 样例注册（HAR-01）：新能力通过 registerLocalAdapter 接入，
 * 不触碰核心调度器。生产适配器应通过独立模块按安装记录加载。
 */
export function registerBuiltinSamples(): void {
  registerLocalAdapter(new HttpReadAdapter());
  registerLocalAdapter(new DraftOpsAdapter()); // W04 synthetic（显式标记）
}
