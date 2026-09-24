import type { CapabilityManifest, JsonSchemaSubset } from "@ai-qa/contracts";
import { validateAgainstSchema, type SchemaValidation } from "./schema-validator.js";

export { validateAgainstSchema };
export type { SchemaValidation };

/**
 * v2 能力适配器 SDK（HAR-01）：新能力通过实现本接口接入，
 * 不修改核心调度器。TS 本地适配器在执行器进程内加载；
 * "本地"不等于能访问 API 服务或宿主机。
 */

export interface CapabilityContext {
  /** 取消信号（协作式取消；不支持取消的能力应尽快结束）。 */
  signal: AbortSignal;
  /** 绝对截止时间（毫秒时间戳）。 */
  deadline: number;
  /** 凭据引用解析（只给声明的 secretRef；明文不进模型/日志）。 */
  resolveSecret: (ref: string) => Promise<string>;
  /** 允许的网络 origin 白名单（执行层连接策略仍生效）。 */
  allowedOrigins: string[];
  /** 幂等键（写操作必须透传给目标系统或用于去重）。 */
  idempotencyKey: string;
}

export interface CapabilityResult {
  /** 技术结果（SUCCEEDED 的工具可承载业务 FAIL）。
   * UNKNOWN：写入效果不明（超时/断连且无对账结果）——先 reconcile，不得盲目重试。 */
  status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "UNKNOWN";
  /** 结构化输出（必须通过 manifest.outputSchema 校验）。 */
  output: unknown;
  /** 外部资源台账键（写操作必填）。 */
  resourceKeys: string[];
  /** 可重试性（按 manifest.recovery 语义）。 */
  retryable: boolean;
  error?: { code: string; message: string };
}

export interface CapabilityAdapter {
  /** 本适配器提供的唯一能力（id+version 与安装记录一致）。 */
  readonly manifest: CapabilityManifest;
  /** 执行：输入已按 manifest.inputSchema 校验；输出在返回前由适配器保证形状。
   * 抛错 = FAILED（非取消）；signal.aborted 后应返回 CANCELLED。 */
  execute(input: unknown, ctx: CapabilityContext): Promise<CapabilityResult>;
  /** 可选：核对未知副作用（recovery=reconcilable 时必须实现）。 */
  reconcile?(input: unknown, ctx: CapabilityContext): Promise<CapabilityResult>;
}

/** SDK 侧执行前校验（注册时自检也用一个最小正例）。 */
export function validateCapabilityInput(
  manifest: CapabilityManifest,
  input: unknown,
): SchemaValidation {
  return validateAgainstSchema(input, manifest.inputSchema);
}

export function validateCapabilityOutput(
  manifest: CapabilityManifest,
  output: unknown,
): SchemaValidation {
  return validateAgainstSchema(output, manifest.outputSchema);
}

/** Schema 自检：声明子集内的字段组合必须自身合法（安装校验用）。 */
const MAX_SCHEMA_DEPTH = 16;

export function selfCheckSchema(schema: JsonSchemaSubset, depth = 0, path = "$"): SchemaValidation {
  const problems: string[] = [];
  if (depth > MAX_SCHEMA_DEPTH) {
    problems.push(`${path}: Schema 嵌套深度超过 ${MAX_SCHEMA_DEPTH}`);
    return { ok: false, problems };
  }
  // 不支持的关键字显式拒绝是自检职责之外的（TS 类型已限定子集），
  // 但 pattern 合法性必须在安装时编译验证，否则运行时抛 SyntaxError。
  if (schema.pattern !== undefined) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(schema.pattern);
    } catch {
      problems.push(`${path}: pattern 不合法（无法编译）：${JSON.stringify(schema.pattern)}`);
    }
  }
  if (schema.type === "array" && !schema.items)
    problems.push(`${path}: array schema 缺少 items`);
  if (schema.type === "object") {
    const props = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!(required in props))
        problems.push(`${path}: required 字段 ${required} 未在 properties 中声明（闭包）`);
    }
    for (const [key, child] of Object.entries(props)) {
      const nested = selfCheckSchema(child, depth + 1, `${path}.properties.${key}`);
      problems.push(...nested.problems);
    }
  }
  if (schema.type === "integer" && schema.minimum !== undefined && !Number.isInteger(schema.minimum))
    problems.push(`${path}: integer 的 minimum 必须是整数`);
  if (schema.type === "integer" && schema.maximum !== undefined && !Number.isInteger(schema.maximum))
    problems.push(`${path}: integer 的 maximum 必须是整数`);
  if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum)
    problems.push(`${path}: minimum ${schema.minimum} > maximum ${schema.maximum}（区间矛盾）`);
  if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength)
    problems.push(`${path}: minLength ${schema.minLength} > maxLength ${schema.maxLength}`);
  if (schema.items)
    problems.push(...selfCheckSchema(schema.items, depth + 1, `${path}.items`).problems);
  return { ok: problems.length === 0, problems };
}
