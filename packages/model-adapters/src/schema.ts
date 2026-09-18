import { Ajv, type ValidateFunction } from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * outputSchema 编译与校验。
 * - 传入非法 schema → 编译错误（调用方 bug，抛错而非静默跳过）；
 * - 校验失败返回 false + 错误摘要（进 MODEL_OUTPUT_INVALID details）。
 */
export function compileOutputSchema(schema: unknown): ValidateFunction | null {
  if (schema === undefined || schema === null) return null;
  return ajv.compile(schema as object);
}

export function validateAgainstSchema(
  validate: ValidateFunction | null,
  data: unknown,
): { ok: true } | { ok: false; errors: string[] } {
  if (!validate) return { ok: true };
  if (validate(data)) return { ok: true };
  const errors = (validate.errors ?? []).slice(0, 5).map(
    (e) => `${e.instancePath || "(root)"} ${e.message ?? ""}`.trim(),
  );
  return { ok: false, errors };
}
