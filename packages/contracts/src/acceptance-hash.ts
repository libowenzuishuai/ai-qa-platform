import { createHash } from "node:crypto";
import { z } from "zod";
import { EntityId } from "./common.js";
import type { TestCaseVersion } from "./test-case.js";
import { TestPlanV1 as TestPlanV1Schema } from "./test-plan.js";
import type { BusinessTimeLimit, PlanValue } from "./test-plan.js";

/**
 * acceptanceHash（PRD §7.2 / FR-08；评审 R4）。
 *
 * 受保护语义由服务端从已批准用例与计划统一提取，调用者不得手工拼装
 * 可能遗漏字段的摘要。纳入：
 * - 断言（id/kind/required/ruleVersionId/operator/expected/unit）
 * - 角色与步骤角色映射（case steps）
 * - 数据策略（fixtureId/params/note）
 * - 计划动作的值引用语义（literal 值、dataRef、credentialRef、captured 变量名）
 *   与动作副作用类别（READ/WRITE）、switchRole 角色、visualAction 指令
 * - 业务时限
 *
 * 不纳入（自动维护可调整，locator/等待单独 version）：
 * bindings 的实际定位、waitFor 的 timeoutMs/pollMs/maxAttempts、
 * 工作流状态（approvalStatus 等元数据）。
 */

/** 确定性序列化：对象按键名排序，数组保持顺序。 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`).join(",")}}`;
}

/** 计划动作的受保护语义（不含定位与等待参数）。 */
export const ProtectedPlanAction = z.object({
  id: EntityId,
  type: z.string(),
  effect: z.enum(["READ", "WRITE"]),
  /** 业务目标引用（locator 可变，目标语义不可变）。 */
  targetRef: z.string().optional(),
  /** switchRole 的角色。 */
  role: z.string().optional(),
  /** captureValue 保存的变量名。 */
  saveAs: z.string().optional(),
  /** 值来源语义：字面量值或引用标识（凭据引用记 ref，不记明文）。 */
  valueRef: z.string().optional(),
  /** visualAction 指令。 */
  instruction: z.string().optional(),
  /** goto 的导航业务路径（换业务路径 = 换验收语义，评审 F2）。 */
  path: z.string().optional(),
  /** goto 的导航模板（含占位符，同样属于业务语义）。 */
  pathTemplate: z.string().optional(),
  /** waitFor 的业务条件（kind+期望值；超时/轮询参数不纳入）。 */
  condition: z
    .object({
      kind: z.string(),
      value: z.string().optional(),
    })
    .optional(),
  /** 检查动作引用的断言 id（assert/visualAssert/downloadCheck/apiCheck）。 */
  assertionId: z.string().optional(),
  /** downloadCheck 的预期文件名。 */
  expectedFilename: z.string().optional(),
  /** apiCheck 模板与参数。 */
  apiTemplateId: z.string().optional(),
  apiParams: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  /** 显式分支条件。 */
  onlyIf: z
    .object({
      varName: z.string(),
      operator: z.string(),
      value: z.union([z.string(), z.number(), z.boolean()]),
    })
    .optional(),
});
export type ProtectedPlanAction = z.infer<typeof ProtectedPlanAction>;

/**
 * 计划断言的受保护语义（评审 F2）：
 * 除用例层语义外，还保护 targetRef / kind / stepId ——
 * "检查另一个字段"不能被当作验收标准没有改变。
 */
export const ProtectedPlanAssertion = z.object({
  id: EntityId,
  stepId: EntityId,
  kind: z.string(),
  targetRef: z.string().optional(),
  operator: z.string(),
  expected: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  unit: z.string().optional(),
  required: z.boolean(),
  ruleVersionId: EntityId,
});
export type ProtectedPlanAssertion = z.infer<typeof ProtectedPlanAssertion>;

export const AcceptanceProtectedFields = z.object({
  caseVersionId: EntityId,
  ruleVersionIds: z.array(EntityId).min(1),
  roles: z.array(z.string().min(1)).min(1),
  /** 关键前置条件。 */
  preconditions: z.array(z.string()).default([]),
  /** 数据策略语义：换 fixture、改参数都必须改变哈希。 */
  dataPolicy: z.object({
    strategy: z.string(),
    fixtureId: z.string().optional(),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    note: z.string().optional(),
  }),
  /** 步骤角色映射：改步骤执行角色必须改变哈希。 */
  caseSteps: z.array(
    z.object({
      id: EntityId,
      role: z.string(),
      action: z.string(),
      expectedResult: z.string().optional(),
    }),
  ),
  assertions: z.array(
    z.object({
      id: EntityId,
      kind: z.string().min(1),
      required: z.boolean(),
      ruleVersionId: EntityId,
      operator: z.string().min(1),
      expected: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
      unit: z.string().optional(),
    }),
  ),
  /** 计划动作语义（计划存在时）。 */
  planActions: z.array(ProtectedPlanAction).default([]),
  /** 计划断言语义（计划存在时）：含 targetRef/kind/stepId。 */
  planAssertions: z.array(ProtectedPlanAssertion).default([]),
  businessTimeLimits: z
    .array(
      z.object({
        key: z.string(),
        limitMs: z.number().int().min(1),
        sourceRuleVersionId: EntityId,
      }),
    )
    .default([]),
});
export type AcceptanceProtectedFields = z.infer<typeof AcceptanceProtectedFields>;

/** 值来源的受保护语义标识：字面量记值，引用记引用身份。 */
function serializeValueRef(value: PlanValue): string {
  switch (value.source) {
    case "literal":
      return `literal:${value.value}`;
    case "dataRef":
      return `dataRef:${value.ref}`;
    case "credential":
      return `credential:${value.ref}`;
    case "captured":
      return `captured:${value.varName}`;
  }
}

/** 计划输入：zod 输入形态，可缺 acceptanceHash（先提取再计算）。 */
export type PlanInput = Omit<z.input<typeof TestPlanV1Schema>, "acceptanceHash"> & {
  acceptanceHash?: string;
};

/**
 * 服务端统一提取受保护语义（评审 R4）。调用方传入已 parse 的用例版本
 * 与计划；禁止调用方自行拼装字段摘要。
 */
export function extractAcceptanceProtectedFields(input: {
  testCase: TestCaseVersion;
  plan?: PlanInput;
  businessTimeLimits?: BusinessTimeLimit[];
}): AcceptanceProtectedFields {
  const { testCase: tc, plan } = input;
  const planActions: ProtectedPlanAction[] = (plan?.actions ?? []).map((a) => {
    const base: ProtectedPlanAction = { id: a.id, type: a.type, effect: a.effect };
    if ("targetRef" in a && a.targetRef) base.targetRef = a.targetRef;
    if (a.type === "switchRole") base.role = a.role;
    if (a.type === "captureValue") base.saveAs = a.saveAs;
    if ("value" in a && a.value) base.valueRef = serializeValueRef(a.value);
    if (a.type === "visualAction") base.instruction = a.instruction;
    if (a.type === "goto") {
      if (a.path !== undefined) base.path = a.path;
      if (a.pathTemplate !== undefined) base.pathTemplate = a.pathTemplate;
    }
    if (a.type === "waitFor") {
      base.condition = {
        kind: a.condition.kind,
        ...("value" in a.condition && a.condition.value !== undefined
          ? { value: a.condition.value }
          : {}),
      };
    }
    if (
      a.type === "assert" ||
      a.type === "visualAssert" ||
      a.type === "downloadCheck" ||
      a.type === "apiCheck"
    ) {
      base.assertionId = a.assertionId;
    }
    if (a.type === "downloadCheck" && a.expectedFilename !== undefined) {
      base.expectedFilename = a.expectedFilename;
    }
    if (a.type === "apiCheck") {
      base.apiTemplateId = a.templateId;
      base.apiParams = a.params;
    }
    if (a.onlyIf)
      base.onlyIf = {
        varName: a.onlyIf.varName,
        operator: a.onlyIf.operator,
        value: a.onlyIf.value,
      };
    return base;
  });
  const planAssertions: ProtectedPlanAssertion[] = (plan?.assertions ?? []).map((pa) => ({
    id: pa.id,
    stepId: pa.stepId,
    kind: pa.kind,
    ...(pa.targetRef !== undefined ? { targetRef: pa.targetRef } : {}),
    operator: pa.operator,
    ...(pa.expected !== undefined ? { expected: pa.expected } : {}),
    ...(pa.unit !== undefined ? { unit: pa.unit } : {}),
    // schema 默认 required=true；显式化以保持输入/输出形态一致。
    required: pa.required ?? true,
    ruleVersionId: pa.ruleVersionId,
  }));
  const dataPolicy = {
    strategy: tc.dataSpec.strategy,
    ...(tc.dataSpec.strategy === "fixture"
      ? { fixtureId: tc.dataSpec.fixtureId, params: tc.dataSpec.params }
      : { note: tc.dataSpec.note }),
  };
  return AcceptanceProtectedFields.parse({
    caseVersionId: tc.id,
    ruleVersionIds: tc.ruleVersionIds,
    roles: tc.roles,
    preconditions: tc.preconditions,
    dataPolicy,
    caseSteps: tc.steps.map((s) => ({
      id: s.id,
      role: s.role,
      action: s.action,
      ...(s.expectedResult !== undefined ? { expectedResult: s.expectedResult } : {}),
    })),
    assertions: tc.assertions.map((a) => ({
      id: a.id,
      kind: a.kind,
      required: a.required,
      ruleVersionId: a.ruleVersionId,
      operator: a.operator,
      ...(a.expected !== undefined ? { expected: a.expected } : {}),
      ...(a.unit !== undefined ? { unit: a.unit } : {}),
    })),
    planActions,
    planAssertions,
    businessTimeLimits: input.businessTimeLimits ?? plan?.businessTimeLimits ?? [],
  });
}

/** 计算受保护字段的规范哈希（sha256，十六进制）。只在服务端调用。 */
export function computeAcceptanceHash(
  fields: AcceptanceProtectedFields,
): string {
  const parsed = AcceptanceProtectedFields.parse(fields);
  const canonical = canonicalStringify(parsed);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** 便捷入口：从用例与计划直接计算 acceptanceHash。 */
export function computePlanAcceptanceHash(input: {
  testCase: TestCaseVersion;
  plan: PlanInput;
  businessTimeLimits?: BusinessTimeLimit[];
}): string {
  return computeAcceptanceHash(extractAcceptanceProtectedFields(input));
}

/**
 * 绑定阶段一致性校验（评审 R1/F3）：公开可信入口的前置校验。
 * 除逐项断言语义（operator/expected/unit/required/ruleVersionId）外，
 * 还必须核对：用例批准状态、版本身份（caseVersionId）、规则与角色范围、
 * 断言 kind —— 任一不符即拒绝，不得继续计算可信哈希。
 */
export function validatePlanAgainstApprovedCase(
  plan: PlanInput | z.output<typeof TestPlanV1Schema>,
  approvedCase: TestCaseVersion,
): { ok: true } | { ok: false; mismatches: string[] } {
  const mismatches: string[] = [];
  // —— 身份与状态（F3） ——
  if (approvedCase.approvalStatus !== "APPROVED") {
    mismatches.push(
      `用例版本 ${approvedCase.id} 状态为 ${approvedCase.approvalStatus}，只有 APPROVED 才能绑定计划`,
    );
  }
  if (!approvedCase.approvalHash) {
    mismatches.push("已批准用例缺少 approvalHash，验收标准不可信");
  }
  if (plan.caseVersionId !== approvedCase.id) {
    mismatches.push(
      `计划 caseVersionId(${plan.caseVersionId}) 与用例版本(${approvedCase.id})不一致`,
    );
  }
  // —— 规则与角色范围（F3） ——
  const caseRules = new Set(approvedCase.ruleVersionIds);
  for (const r of plan.ruleVersionIds) {
    if (!caseRules.has(r))
      mismatches.push(`计划引用了用例未批准的规则 ${r}`);
  }
  for (const r of caseRules) {
    if (!plan.ruleVersionIds.includes(r))
      mismatches.push(`计划缺少用例批准的规则 ${r}`);
  }
  const caseRoles = new Set(approvedCase.roles);
  for (const role of plan.roles) {
    if (!caseRoles.has(role))
      mismatches.push(`计划包含用例未批准的角色 ${role}`);
  }
  // —— 断言语义与类别（R1 + F3） ——
  const caseById = new Map(approvedCase.assertions.map((a) => [a.id, a]));
  for (const pa of plan.assertions) {
    const ca = caseById.get(pa.id);
    if (!ca) {
      mismatches.push(`计划断言 ${pa.id} 不存在于已批准用例`);
      continue;
    }
    if (pa.kind !== ca.kind)
      mismatches.push(`断言 ${pa.id} kind 不符：计划 ${pa.kind} vs 用例 ${ca.kind}`);
    if (pa.operator !== ca.operator)
      mismatches.push(`断言 ${pa.id} operator 不符：计划 ${pa.operator} vs 用例 ${ca.operator}`);
    if ((pa.expected ?? null) !== (ca.expected ?? null))
      mismatches.push(`断言 ${pa.id} expected 不符：计划 ${pa.expected ?? null} vs 用例 ${ca.expected ?? null}`);
    if ((pa.unit ?? null) !== (ca.unit ?? null))
      mismatches.push(`断言 ${pa.id} unit 不符：计划 ${pa.unit ?? null} vs 用例 ${ca.unit ?? null}`);
    if (pa.required !== ca.required)
      mismatches.push(`断言 ${pa.id} required 不符：计划 ${pa.required} vs 用例 ${ca.required}`);
    if (pa.ruleVersionId !== ca.ruleVersionId)
      mismatches.push(`断言 ${pa.id} ruleVersionId 不符`);
  }
  for (const ca of approvedCase.assertions) {
    if (!plan.assertions.some((pa) => pa.id === ca.id))
      mismatches.push(`已批准断言 ${ca.id} 在计划中缺失`);
  }
  return mismatches.length > 0 ? { ok: false, mismatches } : { ok: true };
}

/**
 * 统一可信入口（评审 F3）：校验存储中的计划是否与已批准用例一致、
 * 其 acceptanceHash 是否与受保护语义相符。repository 与执行器必须复用
 * 该入口后才允许信任计划/哈希；不一致直接拒绝，不产出可信哈希。
 */
export function verifyStoredPlan(
  planInput: unknown,
  approvedCase: TestCaseVersion,
):
  | { ok: true; recomputedHash: string }
  | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const parsed = TestPlanV1Schema.safeParse(planInput);
  if (!parsed.success) {
    return {
      ok: false,
      problems: [
        ...parsed.error.issues.map(
          (i) => `schema: ${i.path.join(".")} — ${i.message}`,
        ),
      ],
    };
  }
  const plan = parsed.data;
  const consistency = validatePlanAgainstApprovedCase(plan, approvedCase);
  if (!consistency.ok) problems.push(...consistency.mismatches);
  const recomputedHash = computePlanAcceptanceHash({ testCase: approvedCase, plan });
  if (plan.acceptanceHash !== recomputedHash) {
    problems.push(
      `acceptanceHash 与受保护语义不符（存储 ${plan.acceptanceHash.slice(0, 12)}… vs 重算 ${recomputedHash.slice(0, 12)}…）`,
    );
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, recomputedHash };
}
