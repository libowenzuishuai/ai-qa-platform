import { z } from "zod";
import { EntityId } from "./common.js";
import { SideEffect } from "./enums.js";
import {
  ASSERTION_KINDS,
  ASSERTION_OPERATORS,
  refineAssertionSemantics,
} from "./assertion-semantics.js";

// 断言运算符与语义校验在 assertion-semantics.ts 中与用例层共享（评审 R1）。
export { ASSERTION_OPERATORS };

/**
 * 结构化测试计划 TestPlan v1（PRD §7）。
 *
 * 设计原则：
 * - 只允许列明的动作类型；禁止任意函数体、shell、SQL、eval、文件系统访问。
 * - 目标只能使用 targetRef，且每个 targetRef 必须在 bindings 中登记
 *   现场观察证据（PRD FR-05：不能凭空创建 selector）。
 * - 值只能来自字面量 / 命名空间数据 / 先前 captureValue / 凭据引用。
 * - 无循环、无任意表达式；首版只允许有界轮询（waitFor）与
 *   显式顺序分支（onlyIf 单变量条件，schema 在此列明）。
 * - 每个动作标注副作用类别 READ/WRITE；WRITE 不允许状态不明时重放。
 * - acceptanceHash 由服务端计算；模型传入的哈希不被信任。
 */

export const TEST_PLAN_SCHEMA_VERSION = "1.0";

/** TestPlan v1 允许的全部动作类型（PRD §7.1）。 */
export const PLAN_ACTION_TYPES = [
  "goto",
  "fill",
  "click",
  "select",
  "switchRole",
  "captureValue",
  "waitFor",
  "assert",
  "visualAction",
  "visualAssert",
  "downloadCheck",
  "apiCheck",
] as const;
export type PlanActionType = (typeof PLAN_ACTION_TYPES)[number];

/** 会产出判定的“检查类动作”：必须与 assertions 双向闭合。 */
export const CHECKING_ACTION_TYPES: ReadonlySet<PlanActionType> = new Set([
  "assert",
  "visualAssert",
  "downloadCheck",
  "apiCheck",
]);

/** 阶段 1 执行器先实现的子集；计划入库前按执行能力校验。 */
export const PHASE1_EXECUTOR_ACTIONS: ReadonlySet<PlanActionType> = new Set([
  "goto",
  "fill",
  "click",
  "switchRole",
  "captureValue",
  "waitFor",
  "assert",
]);

/** 定位方式（PRD FR-05 绑定优先顺序）。保存于 bindings，动作本身只引用 targetRef。 */
export const ObservedLocator = z.discriminatedUnion("type", [
  z.object({ type: z.literal("testId"), value: z.string().min(1) }),
  z.object({
    type: z.literal("role"),
    role: z.string().min(1),
    name: z.string().optional(),
  }),
  z.object({ type: z.literal("label"), value: z.string().min(1) }),
  z.object({ type: z.literal("text"), value: z.string().min(1) }),
]);
export type ObservedLocator = z.infer<typeof ObservedLocator>;

/** 现场观察绑定：targetRef → 实际定位 + 观察证据（PRD FR-05）。 */
export const TargetBinding = z.object({
  targetRef: EntityId,
  locator: ObservedLocator,
  observedUrl: z.string().min(1),
  observedAt: z.string().datetime({ offset: true }),
  /** 观察证据（截图/DOM 快照等 Artifact id）。 */
  evidenceId: EntityId,
  note: z.string().optional(),
});
export type TargetBinding = z.infer<typeof TargetBinding>;

/** 值来源（PRD §7.1）：字面量 / 命名空间数据 / 先前 captureValue / 凭据引用。 */
export const PlanValue = z.discriminatedUnion("source", [
  z.object({ source: z.literal("literal"), value: z.string() }),
  z.object({ source: z.literal("dataRef"), ref: EntityId }),
  z.object({ source: z.literal("captured"), varName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/) }),
  /** 凭据只在执行时注入，不进入计划明文。 */
  z.object({ source: z.literal("credential"), ref: EntityId }),
]);
export type PlanValue = z.infer<typeof PlanValue>;

/** 显式顺序分支：仅允许单变量一次比较，无嵌套、无表达式。 */
export const OnlyIfCondition = z.object({
  varName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte"]),
  value: z.union([z.string(), z.number(), z.boolean()]),
});
export type OnlyIfCondition = z.infer<typeof OnlyIfCondition>;

/** 有界轮询条件。 */
export const WaitForCondition = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("visible") }),
  z.object({ kind: z.literal("hidden") }),
  z.object({ kind: z.literal("text"), value: z.string().min(1) }),
  z.object({ kind: z.literal("value"), value: z.string() }),
  z.object({ kind: z.literal("urlContains"), value: z.string().min(1) }),
]);
export type WaitForCondition = z.infer<typeof WaitForCondition>;

const TargetRef = EntityId.describe("bindings 中登记的观察目标引用");

/** 动作公共字段。 */
const ActionBase = z.object({
  id: EntityId,
  effect: SideEffect,
  /** 显式顺序分支：条件为假时跳过该动作，执行器记录 SKIPPED。 */
  onlyIf: OnlyIfCondition.optional(),
});

/**
 * 同源哨兵基址：仅用于 schema 层检测 goto.path 是否会把请求带离目标站点
 * （协议相对路径、反斜杠、控制字符被 URL 解析器归一化后都会改变 origin）。
 * 与实际环境无关；执行器仍必须在导航与重定向前用 url-policy 二次校验。
 */
const PLAN_ORIGIN_SENTINEL = "https://test-plan.invalid/";

/** 判断相对路径是否始终解析在同源内（评审 R5 / F5）。 */
export function resolvesSameOrigin(path: string): boolean {
  try {
    return new URL(path, PLAN_ORIGIN_SENTINEL).origin === new URL(PLAN_ORIGIN_SENTINEL).origin;
  } catch {
    return false;
  }
}

export const PlanAction = z.discriminatedUnion("type", [
  ActionBase.extend({
    type: z.literal("goto"),
    /**
     * 相对环境 baseUrl 的路径。必须始终解析在同源内：
     * 拒绝协议相对路径（//host）、反斜杠与控制字符（URL 解析器会
     * 去除 TAB/CR/LF、把 \ 归一化为 /，从而跳转到其它 host）。
     * 计划级校验还会用 URL 解析结果复核同源（见 superRefine）。
     */
    path: z
      .string()
      .regex(/^\/(?!\/)[^\\]*$/, "path 必须是以单个 / 开头、不含反斜杠的同站相对路径")
      .regex(/^[^\x00-\x1f\x7f]*$/, "path 不允许包含控制字符")
      .optional(),
    /**
     * 带占位符的导航模板（阶段 1）：`/orders/{orderId}`，占位符只能是
     * 先前 captureValue 保存的变量名。禁止任意表达式；模板骨架仍受
     * 同源约束（用哨兵值代入后校验）。与 path 二选一（计划级校验）。
     */
    pathTemplate: z
      .string()
      .regex(
        /^\/(?!\/)(?:[^\\{}]|\{[a-zA-Z][a-zA-Z0-9_]*\})*$/,
        "pathTemplate 只允许 {变量} 占位符，且必须是以单个 / 开头的同站相对路径",
      )
      .regex(/^[^\x00-\x1f\x7f]*$/, "pathTemplate 不允许包含控制字符")
      .optional(),
  }),
  ActionBase.extend({
    type: z.literal("fill"),
    targetRef: TargetRef,
    value: PlanValue,
  }).describe("存在自动保存的字段必须标 effect=WRITE（PRD §7.2 注）"),
  ActionBase.extend({
    type: z.literal("click"),
    targetRef: TargetRef,
  }),
  ActionBase.extend({
    type: z.literal("select"),
    targetRef: TargetRef,
    value: PlanValue,
  }),
  ActionBase.extend({
    type: z.literal("switchRole"),
    role: z.string().min(1),
  }),
  ActionBase.extend({
    type: z.literal("captureValue"),
    targetRef: TargetRef,
    saveAs: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  }),
  ActionBase.extend({
    type: z.literal("waitFor"),
    targetRef: TargetRef.optional(),
    condition: WaitForCondition,
    timeoutMs: z.number().int().min(100).max(120_000),
    pollMs: z.number().int().min(100).max(10_000).default(500),
    /** 有界轮询：必须给出最大尝试次数。 */
    maxAttempts: z.number().int().min(1).max(120),
  }),
  ActionBase.extend({
    type: z.literal("assert"),
    assertionId: EntityId,
  }),
  ActionBase.extend({
    type: z.literal("visualAction"),
    /** 有界自然语言指令，仅用于定位/操作，不含业务判定。 */
    instruction: z.string().min(1).max(500),
    targetRef: TargetRef.optional(),
  }),
  ActionBase.extend({
    type: z.literal("visualAssert"),
    assertionId: EntityId,
  }),
  ActionBase.extend({
    type: z.literal("downloadCheck"),
    assertionId: EntityId,
    expectedFilename: z.string().min(1).optional(),
  }),
  ActionBase.extend({
    type: z.literal("apiCheck"),
    assertionId: EntityId,
    /** 只能使用项目预先登记的请求模板。 */
    templateId: EntityId,
    params: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .default({}),
  }),
]);
export type PlanAction = z.infer<typeof PlanAction>;

/** 计划内断言定义：与 TestCaseVersion 断言一一对应，绑定到检查动作。 */
export const PlanAssertion = z
  .object({
    id: EntityId,
    /** 引用该断言的检查动作 id。 */
    stepId: EntityId,
    required: z.boolean().default(true),
    ruleVersionId: EntityId,
    kind: z.enum(ASSERTION_KINDS),
    targetRef: TargetRef.optional(),
    operator: z.enum(ASSERTION_OPERATORS),
    expected: z
      .union([z.string(), z.number(), z.boolean(), z.null()])
      .optional(),
    /** 数值必须带明确单位（如 fen）；金额用最小货币单位（PRD FR-07）。 */
    unit: z.string().min(1).optional(),
    timeoutMs: z.number().int().min(100).max(120_000).optional(),
  })
  .superRefine(refineAssertionSemantics);
export type PlanAssertion = z.infer<typeof PlanAssertion>;

/** 按 kind 需要 targetRef 的断言类别（评审 三.1：UI/数据断言必须有目标）。 */
const KINDS_REQUIRING_TARGET: ReadonlySet<string> = new Set([
  "ui.text",
  "ui.element",
  "ui.state",
  "data.value",
]);

/** 检查动作类型允许的断言 kind（评审 三.1：动作与判定类别一致）。 */
const KINDS_BY_CHECKING_ACTION: Readonly<
  Record<"assert" | "visualAssert" | "downloadCheck" | "apiCheck", ReadonlySet<string>>
> = {
  assert: new Set(["ui.text", "ui.element", "ui.state", "data.value"]),
  visualAssert: new Set(["visual"]),
  downloadCheck: new Set(["download.content"]),
  apiCheck: new Set(["api.response"]),
};

/** 业务时限（纳入 acceptanceHash；技术等待不得放宽业务 SLA）。 */
export const BusinessTimeLimit = z.object({
  key: z.string().min(1),
  limitMs: z.number().int().min(1),
  sourceRuleVersionId: EntityId,
});
export type BusinessTimeLimit = z.infer<typeof BusinessTimeLimit>;

export const TestPlanV1 = z
  .object({
    schemaVersion: z.literal(TEST_PLAN_SCHEMA_VERSION),
    caseVersionId: EntityId,
    ruleVersionIds: z.array(EntityId).min(1),
    roles: z.array(z.string().min(1)).min(1),
    /** 服务端计算；模型传入的哈希不得直接信任。 */
    acceptanceHash: z.string().regex(/^[0-9a-f]{64}$/),
    bindings: z.array(TargetBinding).default([]),
    actions: z.array(PlanAction).min(1),
    assertions: z.array(PlanAssertion).min(1),
    businessTimeLimits: z.array(BusinessTimeLimit).default([]),
  })
  .superRefine((plan, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

    // —— 唯一性 ——
    const actionIds = new Set<string>();
    plan.actions.forEach((a, i) => {
      if (actionIds.has(a.id)) issue(["actions", i], `动作 id 重复：${a.id}`);
      actionIds.add(a.id);
    });
    const bindingRefs = new Set<string>();
    plan.bindings.forEach((b, i) => {
      if (bindingRefs.has(b.targetRef))
        issue(["bindings", i], `targetRef 重复登记：${b.targetRef}`);
      bindingRefs.add(b.targetRef);
    });
    const ruleIds = new Set(plan.ruleVersionIds);
    const uniqueRules = new Set(plan.ruleVersionIds);
    if (uniqueRules.size !== plan.ruleVersionIds.length)
      issue(["ruleVersionIds"], "ruleVersionIds 存在重复");

    // —— 观察绑定闭环：动作/断言引用的 targetRef 必须已登记 ——
    const checkTargetRef = (ref: string, path: (string | number)[]) => {
      if (!bindingRefs.has(ref))
        issue(path, `targetRef ${ref} 未在 bindings 登记；禁止引用未观察目标`);
    };
    plan.actions.forEach((a, i) => {
      if ("targetRef" in a && a.targetRef) checkTargetRef(a.targetRef, ["actions", i, "targetRef"]);
    });
    plan.assertions.forEach((a, i) => {
      if (a.targetRef) checkTargetRef(a.targetRef, ["assertions", i, "targetRef"]);
    });

    // —— 变量：captureValue 先定义后引用；条件捕获禁用（评审 三.3） ——
    const definedVars = new Set<string>();
    const ensureVar = (
      value: PlanValue | undefined,
      actionIndex: number,
      field: string,
    ) => {
      if (value && value.source === "captured" && !definedVars.has(value.varName))
        issue(["actions", actionIndex, field], `引用了尚未定义的捕获变量 ${value.varName}`);
    };
    const ensureOnlyIfVar = (action: PlanAction, actionIndex: number) => {
      if (action.onlyIf && !definedVars.has(action.onlyIf.varName))
        issue(["actions", actionIndex, "onlyIf"], `分支引用了尚未定义的捕获变量 ${action.onlyIf?.varName}`);
    };
    plan.actions.forEach((a, i) => {
      if (a.type === "captureValue" && a.onlyIf) {
        issue(
          ["actions", i, "onlyIf"],
          "captureValue 不允许携带 onlyIf（条件为假时变量实际不存在，存在性不可静态判定）",
        );
      }
      ensureOnlyIfVar(a, i);
      if ("value" in a && a.value) ensureVar(a.value, i, "value");
      // 条件捕获被禁止后，只有无条件 captureValue 定义变量。
      if (a.type === "captureValue") definedVars.add(a.saveAs);
    });

    // —— waitFor 按条件类别要求目标（评审 三.2） ——
    plan.actions.forEach((a, i) => {
      if (a.type !== "waitFor") return;
      const needsTarget = ["visible", "hidden", "text", "value"].includes(a.condition.kind);
      if (needsTarget && !a.targetRef)
        issue(["actions", i, "targetRef"], `waitFor ${a.condition.kind} 必须提供 targetRef`);
    });

    // —— goto 路径必须始终解析在同源内（评审 F5：控制字符/归一化跳站） ——
    // pathTemplate 的占位符必须由此前无条件 captureValue 定义（数据流校验），
    // 且模板骨架（哨兵值代入后）也必须同源。
    plan.actions.forEach((a, i) => {
      if (a.type !== "goto") return;
      if (a.path !== undefined && a.pathTemplate !== undefined) {
        issue(["actions", i, "pathTemplate"], "goto 的 path 与 pathTemplate 二选一");
        return;
      }
      if (a.path !== undefined) {
        if (!resolvesSameOrigin(a.path))
          issue(
            ["actions", i, "path"],
            `goto path 经 URL 解析后离开目标站点（协议相对/反斜杠/控制字符归一化）`,
          );
        return;
      }
      if (a.pathTemplate !== undefined) {
        const placeholders = [...a.pathTemplate.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(
          (m) => m[1]!,
        );
        for (const name of placeholders) {
          if (!definedVars.has(name))
            issue(["actions", i, "pathTemplate"], `占位符 {${name}} 未由此前的 captureValue 定义`);
        }
        // 骨架同源：占位符代入哨兵值后不得离开目标站点。
        const skeleton = a.pathTemplate.replace(/\{[a-zA-Z][a-zA-Z0-9_]*\}/g, "x");
        if (!resolvesSameOrigin(skeleton))
          issue(["actions", i, "pathTemplate"], "goto pathTemplate 骨架经 URL 解析后离开目标站点");
      } else {
        issue(["actions", i, "path"], "goto 必须提供 path 或 pathTemplate");
      }
    });

    // —— 检查动作与断言双向闭合 ——
    const assertionIds = new Set<string>();
    plan.assertions.forEach((a, i) => {
      if (assertionIds.has(a.id)) issue(["assertions", i], `断言 id 重复：${a.id}`);
      assertionIds.add(a.id);
      if (!actionIds.has(a.stepId))
        issue(["assertions", i, "stepId"], `断言 ${a.id} 引用了不存在的动作 ${a.stepId}`);
      if (!ruleIds.has(a.ruleVersionId))
        issue(
          ["assertions", i, "ruleVersionId"],
          `断言 ${a.id} 引用了未在计划 ruleVersionIds 中声明的规则 ${a.ruleVersionId}`,
        );
      // UI/数据断言必须有观察目标（评审 三.1）。
      if (KINDS_REQUIRING_TARGET.has(a.kind) && !a.targetRef)
        issue(["assertions", i, "targetRef"], `kind=${a.kind} 的断言必须提供 targetRef`);
    });
    const referencedAssertions = new Map<string, string>(); // assertionId -> actionId
    plan.actions.forEach((a, i) => {
      if (CHECKING_ACTION_TYPES.has(a.type)) {
        const assertionId =
          a.type === "assert" || a.type === "visualAssert" || a.type === "downloadCheck" || a.type === "apiCheck"
            ? a.assertionId
            : null;
        if (assertionId == null) return;
        if (!assertionIds.has(assertionId))
          issue(["actions", i], `检查动作引用了不存在的断言 ${assertionId}`);
        // 断言 kind 必须与检查动作类型一致（评审 三.1）。
        const allowedKinds =
          KINDS_BY_CHECKING_ACTION[
            a.type as keyof typeof KINDS_BY_CHECKING_ACTION
          ];
        const referenced = plan.assertions.find((x) => x.id === assertionId);
        if (referenced && allowedKinds && !allowedKinds.has(referenced.kind))
          issue(
            ["assertions", plan.assertions.indexOf(referenced), "kind"],
            `kind=${referenced.kind} 的断言不能由 ${a.type} 动作判定（允许：${[...allowedKinds].join("/")}]）`,
          );
        const prev = referencedAssertions.get(assertionId);
        if (prev && prev !== a.id)
          issue(["actions", i], `断言 ${assertionId} 被多个检查动作引用（${prev} 与 ${a.id}）`);
        referencedAssertions.set(assertionId, a.id);
        // 断言的 stepId 必须正好是引用它的动作。
        const assertion = plan.assertions.find((x) => x.id === assertionId);
        if (assertion && assertion.stepId !== a.id)
          issue(
            ["assertions", plan.assertions.indexOf(assertion), "stepId"],
            `断言 ${assertionId} 的 stepId(${assertion.stepId}) 与实际检查动作(${a.id})不一致`,
          );
      }
    });
    for (const a of plan.assertions) {
      if (!referencedAssertions.has(a.id))
        issue(
          ["assertions", plan.assertions.indexOf(a)],
          `断言 ${a.id} 没有任何检查动作引用；未执行的断言不可能构成 PASS`,
        );
    }

    // —— switchRole 角色必须在计划角色范围内 ——
    const roles = new Set(plan.roles);
    plan.actions.forEach((a, i) => {
      if (a.type === "switchRole" && !roles.has(a.role))
        issue(["actions", i, "role"], `角色 ${a.role} 未在计划 roles 中声明`);
    });
  });
export type TestPlanV1 = z.infer<typeof TestPlanV1>;

/**
 * 按执行器能力校验计划：执行器不支持的动作类型必须提前拒绝，
 * 而不是执行到一半才失败（PRD FR-04“执行能力可支持”）。
 */
export function validatePlanForExecutor(
  plan: TestPlanV1,
  supportedActions: ReadonlySet<PlanActionType>,
): { ok: true } | { ok: false; unsupported: PlanActionType[] } {
  const unsupported = new Set<PlanActionType>();
  for (const a of plan.actions) {
    if (!supportedActions.has(a.type)) unsupported.add(a.type);
  }
  if (unsupported.size > 0) return { ok: false, unsupported: [...unsupported] };
  return { ok: true };
}
