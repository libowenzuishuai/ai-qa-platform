/**
 * 凭据解析（阶段 1）：PlanValue {source:"credential", ref:"<role>.<field>"}。
 *
 * 值只来自 worker 进程环境变量；DB 只保存 env 变量名（secretRefs）。
 * 环境引用缺失时返回 undefined → 执行器 BLOCKED/AUTH。
 * 凭据值不进入日志、事件、计划或报告。
 */

export interface SecretRefs {
  [role: string]: { usernameEnv?: string; passwordEnv?: string } | undefined;
}

/** 角色默认约定：DEMO_<ROLE>_USERNAME / DEMO_<ROLE>_PASSWORD。 */
function defaultEnvName(role: string, field: string): string {
  return `DEMO_${role.toUpperCase()}_${field.toUpperCase()}`;
}

export function makeCredentialResolver(secretRefs: SecretRefs, allowDemoDefaults = false) {
  return (ref: string): string | undefined => {
    const parts = ref.split(".");
    if (parts.length !== 2) return undefined;
    const role = parts[0]!;
    const fieldRaw = parts[1]!;
    if (!["username", "password"].includes(fieldRaw)) return undefined;
    const field = fieldRaw as "username" | "password";
    const configured =
      field === "username" ? secretRefs[role]?.usernameEnv : secretRefs[role]?.passwordEnv;
    const envName = configured ?? (allowDemoDefaults ? defaultEnvName(role, field) : undefined);
    if (!envName) return undefined;
    const value = process.env[envName];
    return value && value.length > 0 ? value : undefined;
  };
}
