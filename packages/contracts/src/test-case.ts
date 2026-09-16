import { z } from "zod";
import { EntityId, IsoDateTime } from "./common.js";
import { AssetOrigin, CaseApprovalStatus } from "./enums.js";
import {
  ASSERTION_KINDS,
  ASSERTION_OPERATORS,
  refineAssertionSemantics,
} from "./assertion-semantics.js";

/**
 * 用例版本（PRD FR-04 / §6）。
 * 每条用例有规则版本引用、前置条件、角色、数据策略、操作步骤、
 * 预期检查（断言）、清理策略和优先级；修改产生新版本。
 *
 * 断言的验收语义（operator/expected/unit）必须在用例层完整保留（评审 R1）：
 * 计划层的 operator 不能弥补用例层已经丢掉的信息。
 */

/** 数据策略：夹具由管理员维护可信模板；模型只能传参数（PRD FR-06）。 */
export const DataSpec = z.discriminatedUnion("strategy", [
  z.object({
    strategy: z.literal("fixture"),
    fixtureId: EntityId,
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  }),
  z.object({
    strategy: z.literal("create"),
    /** 业务创建步骤本身是测试目标时，从步骤执行，不用夹具跳过。 */
    note: z.string().min(1),
  }),
]);
export type DataSpec = z.infer<typeof DataSpec>;

/** 断言定义：expected 必须可观察、可判定，禁止“系统正常”类描述。 */
export const CaseAssertion = z
  .object({
    id: EntityId,
    description: z.string().min(1),
    kind: z.enum(ASSERTION_KINDS),
    required: z.boolean().default(true),
    ruleVersionId: EntityId,
    operator: z.enum(ASSERTION_OPERATORS),
    /** 期望值；视觉断言可为 null（由视觉标准描述）。 */
    expected: z
      .union([z.string(), z.number(), z.boolean(), z.null()])
      .optional(),
    /** 数值必须带明确单位（如 fen）；金额用最小货币单位（PRD FR-07）。 */
    unit: z.string().min(1).optional(),
  })
  .superRefine(refineAssertionSemantics);
export type CaseAssertion = z.infer<typeof CaseAssertion>;

export const TestCaseVersion = z
  .object({
    id: EntityId,
    caseId: EntityId,
    version: z.number().int().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    ruleVersionIds: z.array(EntityId).min(1),
    roles: z.array(z.string().min(1)).min(1),
    preconditions: z.array(z.string()).default([]),
    dataSpec: DataSpec,
    steps: z
      .array(
        z.object({
          id: EntityId,
          role: z.string().min(1),
          action: z.string().min(1),
          expectedResult: z.string().optional(),
        }),
      )
      .min(1),
    assertions: z.array(CaseAssertion).min(1),
    cleanup: z.object({
      strategy: z.enum(["namespace", "fixture", "manual"]),
      note: z.string().optional(),
    }),
    priority: z.enum(["P0", "P1", "P2"]).default("P1"),
    approvalStatus: CaseApprovalStatus.default("DRAFT"),
    supersedesId: EntityId.nullable().default(null),
    origin: AssetOrigin,
    promptVersion: z.string().nullable().default(null),
    approvalHash: z.string().min(1).optional(),
    createdAt: IsoDateTime,
  })
  .superRefine((tc, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

    // 空断言集合禁止：没有断言的用例不可能 PASS（PRD §5.2 规则 5）。
    if (tc.assertions.length === 0) {
      issue(["assertions"], "用例必须至少包含一条断言；空断言集合禁止 PASS");
    }
    // 断言引用的规则必须在用例声明的规则范围内。
    const declared = new Set(tc.ruleVersionIds);
    tc.assertions.forEach((a, i) => {
      if (!declared.has(a.ruleVersionId)) {
        issue(
          ["assertions", i, "ruleVersionId"],
          `断言 ${a.id} 引用了未在 ruleVersionIds 中声明的规则 ${a.ruleVersionId}`,
        );
      }
    });
    // 步骤角色必须在用例角色范围内。
    const roles = new Set(tc.roles);
    tc.steps.forEach((s, i) => {
      if (!roles.has(s.role)) {
        issue(["steps", i, "role"], `步骤 ${s.id} 的角色 ${s.role} 未在用例 roles 中声明`);
      }
    });
    // 断言 id 与步骤 id 唯一。
    const assertIds = new Set<string>();
    tc.assertions.forEach((a, i) => {
      if (assertIds.has(a.id)) issue(["assertions", i], `断言 id 重复：${a.id}`);
      assertIds.add(a.id);
    });
    const stepIds = new Set<string>();
    tc.steps.forEach((s, i) => {
      if (stepIds.has(s.id)) issue(["steps", i], `步骤 id 重复：${s.id}`);
      stepIds.add(s.id);
    });
    // APPROVED 完整性（评审 R1）：批准的用例语义必须完整可执行。
    if (tc.approvalStatus === "APPROVED") {
      if (!tc.approvalHash) {
        issue(["approvalHash"], "批准（APPROVED）的用例必须携带 approvalHash");
      }
      tc.assertions.forEach((a, i) => {
        if (!a.operator) {
          issue(["assertions", i, "operator"], `批准用例的断言 ${a.id} 缺少 operator`);
        }
      });
    }
  });
export type TestCaseVersion = z.infer<typeof TestCaseVersion>;
