/**
 * 真实 moonshot（Kimi）连通冒烟（阶段 2 A 通道验收）。
 *
 * - 运行时从环境读取凭据（通常经根 .env 由 dotenv 语义加载）；
 *   绝不打印密钥，只输出状态/模型/usage/requestId/耗时。
 * - 文本 + 视觉各一次最小调用；输出符合给定 outputSchema 才算通过。
 * - 未配置凭据 → 打印 SKIP 原因并退出 0（不冒充通过）。
 */
import { config as loadDotenv } from "dotenv";

for (const candidate of ["../../.env", "../../../.env"]) {
  try {
    loadDotenv({ path: new URL(candidate, import.meta.url).pathname });
  } catch {
    /* 无 .env 则跳过 */
  }
}

const hasTextKey = Boolean(process.env.AIQA_TEXT_API_KEY);
const hasVisionKey = Boolean(process.env.AIQA_VISION_API_KEY);
if (!hasTextKey) {
  console.log("SKIP: AIQA_TEXT_API_KEY 未配置（real 冒烟不冒充通过）");
  process.exit(0);
}

const { loadModelEnvConfig, MoonshotTextAdapter, MoonshotVisionAdapter } = await import(
  "../src/index.js"
);

const outcomes: Array<{ name: string; ok: boolean; detail: string }> = [];

// ---------- 文本通道 ----------
try {
  const config = loadModelEnvConfig();
  const adapter = new MoonshotTextAdapter({ config: config.text });
  const response = await adapter.completeText({
    purpose: "RULE_EXTRACTION",
    system: "你是连通性测试。只输出 JSON。",
    user: "请输出 {\"ok\": true}",
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    timeoutMs: 30_000,
  });
  const ok = (response.parsedJson as { ok?: boolean }).ok === true;
  outcomes.push({
    name: "text.completeText",
    ok,
    detail: `model=${response.model} usage=${JSON.stringify(response.usage)} requestId=${response.requestId ?? "null"} latency=${response.latencyMs}ms repairs=[${response.repairsApplied.join(",")}]`,
  });
} catch (err) {
  outcomes.push({
    name: "text.completeText",
    ok: false,
    detail: `${(err as { code?: string }).code ?? "ERROR"}: ${(err as Error).message}`.slice(0, 200),
  });
}

// ---------- 视觉通道（可选；独立凭据未配置则 SKIP 单项） ----------
if (hasVisionKey) {
  try {
    const config = loadModelEnvConfig();
    // 1x1 红色 PNG（确定性最小图）。
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const adapter = new MoonshotVisionAdapter({
      config: config.vision,
      readImage: () => ({ data: png, mime: "image/png" }),
    });
    const response = await adapter.describeImage({
      purpose: "VISION_DESCRIBE",
      imageStorageKey: "smoke/1x1.png",
      hint: "这张图片的主色是什么？输出 {\"color\":\"...\"}",
      outputSchema: { type: "object", properties: { color: { type: "string" } }, required: ["color"] },
      timeoutMs: 60_000,
    });
    const color = (response.parsedJson as { color?: string }).color ?? "";
    outcomes.push({
      name: "vision.describeImage",
      ok: color.length > 0,
      detail: `color=${color} model=${response.model} usage=${JSON.stringify(response.usage)} latency=${response.latencyMs}ms`,
    });
  } catch (err) {
    outcomes.push({
      name: "vision.describeImage",
      ok: false,
      detail: `${(err as { code?: string }).code ?? "ERROR"}: ${(err as Error).message}`.slice(0, 200),
    });
  }
} else {
  outcomes.push({ name: "vision.describeImage", ok: true, detail: "SKIP: AIQA_VISION_API_KEY 未配置" });
}

console.log("\n===== moonshot real 冒烟 =====");
for (const o of outcomes) console.log(`${o.ok ? "PASS" : "FAIL"}  ${o.name} — ${o.detail}`);
process.exit(outcomes.every((o) => o.ok) ? 0 : 1);
