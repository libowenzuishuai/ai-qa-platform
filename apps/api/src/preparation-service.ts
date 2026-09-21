import { createHash } from "node:crypto";
import { EnvironmentRuntime, LoginPreparationConfig } from "@ai-qa/contracts";
import type { LoginPreparation } from "@prisma/client";
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export const configHash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export function validateLoginConfiguration(raw: unknown, runtimeRaw: unknown) {
  const config = LoginPreparationConfig.parse(raw),
    runtime = EnvironmentRuntime.parse(runtimeRaw);
  if (!runtime.secretRefs[config.credentialRef])
    throw new Error("账号引用尚未登记");
  for (const step of config.steps)
    if (step.type === "fill") {
      const [role, field] = step.value.ref.split(".");
      if (
        role !== config.credentialRef ||
        !runtime.secretRefs[role!]?.[
          field === "username" ? "usernameEnv" : "passwordEnv"
        ]
      )
        throw new Error("步骤只能使用本登录配置已登记的账号引用");
    }
  return config;
}
export function loginFresh(row: LoginPreparation, revision: number) {
  return (
    row.lastCheckStatus === "PASS" &&
    row.lastCheckEnvRev === revision &&
    !!row.lastCheckAt &&
    row.lastCheckAt.getTime() + row.validityHours * 3600000 > Date.now()
  );
}
