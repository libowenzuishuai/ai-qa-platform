import { z } from "zod";
import { EntityId } from "./common.js";
import { Clarification, RuleVersion } from "./rule.js";
import { CaseAssertion, DataSpec } from "./test-case.js";

/**
 * 测试用例设计契约（阶段 2 第 0 步 · docs/stage2-step0-contracts.md §2.4）。
 * 起草：李琦双（C）；消费：入库前校验与 worker。
 *
 * 字段名对齐提示词 §5.2；直接复用 test-case.ts 的积木
 * （DataSpec / CaseAssertion，连同 refineAssertionSemantics）。
 */

/** §5.2 输入：只喂 APPROVED 规则实体。 */
export const CaseGenerationInput = z.object({
  approvedRuleVersions: z.array(RuleVersion).min(1),
  clarificationSources: z.array(Clarification).default([]),
  roles: z.array(z.string().min(1)).min(1),
  /** 可用 fixtureId 清单（PRD FR-06：模型只能引用，不能造 fixture）。 */
  fixtureCapabilities: z.array(EntityId).default([]),
  /** 执行器能力边界（阶段 2 子集），防生成做不到的用例。 */
  executorCapabilities: z.array(z.string()).default([]),
  promptVersion: z.string().min(1),
});
export type CaseGenerationInput = z.infer<typeof CaseGenerationInput>;

/**
 * 与 TestCaseVersion 同构；入库时补 id / version / approvalStatus=DRAFT /
 * origin=model；approvalHash 在人工批准时由服务端计算
 * （沿用阶段 1 先算后建的冻结纪律）。
 */
export const CaseDraft = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  ruleVersionIds: z.array(EntityId).min(1),
  roles: z.array(z.string().min(1)).min(1),
  preconditions: z.array(z.string()).default([]),
  dataSpec: DataSpec,
  steps: z
    .array(
      z.object({
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
  /** 覆盖维度（提示词 §5.2 七维度），供 coverageMap 汇总。 */
  dimensions: z
    .array(
      z.enum([
        "HAPPY_PATH",
        "INVALID_INPUT",
        "BOUNDARY",
        "PERMISSION",
        "STATE",
        "CROSS_MODULE",
        "PERSISTENCE",
      ]),
    )
    .min(1),
});
export type CaseDraft = z.infer<typeof CaseDraft>;

export const BlockedRequirement = z.object({
  ruleVersionId: EntityId,
  reason: z.enum([
    "MISSING_LOGIN",
    "MISSING_FIXTURE",
    "INSUFFICIENT_INFO",
    "OUT_OF_EXECUTOR_CAPABILITY",
  ]),
  detail: z.string().min(1),
});
export type BlockedRequirement = z.infer<typeof BlockedRequirement>;

export const CoverageEntry = z.object({
  ruleVersionId: EntityId,
  caseCount: z.number().int(),
  dimensionsCovered: z.array(z.string()),
});
export type CoverageEntry = z.infer<typeof CoverageEntry>;

/** §5.2 输出：caseDrafts / coverageMap / blockedRequirements。 */
export const CaseGenerationOutput = z.object({
  caseDrafts: z.array(CaseDraft),
  coverageMap: z.array(CoverageEntry),
  /** 缺登录/缺数据/超能力 → 列阻塞，不脑补。 */
  blockedRequirements: z.array(BlockedRequirement),
});
export type CaseGenerationOutput = z.infer<typeof CaseGenerationOutput>;

export interface CaseGenerationValidation {
  ok: boolean;
  problems: string[];
}

/**
 * 联合校验（worker 入库前调用；每条都有反例测试）：
 * 1. draft 的 ruleVersionIds 与断言 ruleVersionId ∈ 输入
 *    approvedRuleVersions 的 id；断言引用还须 ∈ 该 draft 声明的
 *    ruleVersionIds（镜像 TestCaseVersion 的 refine，提前到草稿层）；
 * 2. fixture 策略的 fixtureId ∈ fixtureCapabilities；
 * 3. coverageMap ∪ blockedRequirements 覆盖所有输入规则——
 *    覆盖率不许把资料遗漏藏进去（PRD FR-04）；coverageMap 自身
 *    只能引用输入规则；
 * 4. 步骤角色与用例角色 ∈ 输入 roles。
 */
export function validateCaseGeneration(
  input: CaseGenerationInput,
  output: CaseGenerationOutput,
): CaseGenerationValidation {
  const problems: string[] = [];
  const approvedIds = new Set(input.approvedRuleVersions.map((r) => r.id));
  const roles = new Set(input.roles);
  const fixtures = new Set(input.fixtureCapabilities);

  for (const [index, draft] of output.caseDrafts.entries()) {
    for (const ruleId of draft.ruleVersionIds) {
      if (!approvedIds.has(ruleId)) {
        problems.push(`用例草稿[${index}] ${draft.title} 引用了未批准的规则 ${ruleId}`);
      }
    }
    const declared = new Set(draft.ruleVersionIds);
    for (const [ai, assertion] of draft.assertions.entries()) {
      if (!declared.has(assertion.ruleVersionId)) {
        problems.push(
          `用例草稿[${index}] 断言[${ai}] 引用了未声明的规则 ${assertion.ruleVersionId}`,
        );
      }
    }
    if (draft.dataSpec.strategy === "fixture") {
      if (!fixtures.has(draft.dataSpec.fixtureId)) {
        problems.push(
          `用例草稿[${index}] ${draft.title} 引用了不可用 fixture ${draft.dataSpec.fixtureId}`,
        );
      }
    }
    for (const role of draft.roles) {
      if (!roles.has(role)) {
        problems.push(`用例草稿[${index}] ${draft.title} 使用了未声明的角色 ${role}`);
      }
    }
    for (const [si, step] of draft.steps.entries()) {
      if (!roles.has(step.role)) {
        problems.push(`用例草稿[${index}] 步骤[${si}] 角色越界：${step.role}`);
      }
      if (!draft.roles.includes(step.role)) {
        problems.push(
          `用例草稿[${index}] 步骤[${si}] 角色 ${step.role} 未在该用例 roles 中声明`,
        );
      }
    }
  }

  // 覆盖完整性（PRD FR-04）。
  const covered = new Set<string>();
  for (const entry of output.coverageMap) {
    if (!approvedIds.has(entry.ruleVersionId)) {
      problems.push(`coverageMap 引用了未批准的规则 ${entry.ruleVersionId}`);
      continue;
    }
    covered.add(entry.ruleVersionId);
  }
  for (const blocked of output.blockedRequirements) {
    if (!approvedIds.has(blocked.ruleVersionId)) {
      problems.push(`blockedRequirements 引用了未批准的规则 ${blocked.ruleVersionId}`);
      continue;
    }
    covered.add(blocked.ruleVersionId);
  }
  for (const ruleId of approvedIds) {
    if (!covered.has(ruleId)) {
      problems.push(
        `规则 ${ruleId} 既不在 coverageMap 也不在 blockedRequirements——覆盖率不得隐藏资料遗漏`,
      );
    }
  }

  return { ok: problems.length === 0, problems };
}
