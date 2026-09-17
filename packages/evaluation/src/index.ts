import type { CaseVerdict, ReasonCode } from "@ai-qa/contracts";

/**
 * 确定性聚合（PRD §5.2 / FR-10）。
 *
 * 输入是执行器产出的原始事实（每个用例的断言结果与关键步骤状态），
 * 输出用例 verdict 与运行级指标。本模块是纯函数，不做 IO；
 * 平台是否 PASS 由这里的聚合决定，自然语言解释不能覆盖。
 *
 * 规则（按序）：
 * 1. 存在可信、已批准的必需断言 FAIL → case FAIL（后续受阻也保留 FAIL）。
 * 2. 无 FAIL，但关键步骤受阻（环境/凭据/数据/预算/取消/副作用不确定等）→ BLOCKED。
 * 3. 无前两项，但必要步骤被跳过或证据缺失 → REVIEW。
 * 4. 从未开始 → NOT_RUN。
 * 5. 必要步骤完成、全部必需断言 PASS 且证据完整 → PASS；
 *    空断言集合禁止 PASS。
 */

export interface AssertionOutcome {
  assertionId: string;
  required: boolean;
  result: "PASS" | "FAIL" | "REVIEW" | "NOT_EVALUATED";
}

export interface CaseOutcomeInput {
  caseVersionId: string;
  title?: string;
  selected: boolean;
  started: boolean;
  /** 关键（必需）步骤是否存在受阻/失败/取消（业务断言 FAIL 除外）。 */
  blocked?: { reasonCode: ReasonCode | string; detail?: string };
  /** 必要步骤是否被跳过（如 onlyIf 不满足、取消中断）。 */
  requiredStepsSkipped?: boolean;
  assertions: AssertionOutcome[];
  /** 必需断言是否全部具备可验证证据（文件存在性由调用方检查）。 */
  evidenceComplete: boolean;
}

export interface CaseVerdictResult {
  caseVersionId: string;
  verdict: CaseVerdict;
  reasonCode: ReasonCode | string;
  detail?: string;
}

export function aggregateCase(input: CaseOutcomeInput): CaseVerdictResult {
  if (!input.selected) {
    return { caseVersionId: input.caseVersionId, verdict: "NOT_RUN", reasonCode: "NONE" };
  }
  if (!input.started) {
    return { caseVersionId: input.caseVersionId, verdict: "NOT_RUN", reasonCode: "NONE" };
  }
  // 空断言集合禁止 PASS：没有断言的用例最高只能是 REVIEW。
  const required = input.assertions.filter((a) => a.required);
  const requiredFail = required.find((a) => a.result === "FAIL");
  if (requiredFail) {
    return {
      caseVersionId: input.caseVersionId,
      verdict: "FAIL",
      reasonCode: "BUSINESS_MISMATCH",
      detail: `必需断言 ${requiredFail.assertionId} FAIL`,
    };
  }
  if (input.blocked) {
    return {
      caseVersionId: input.caseVersionId,
      verdict: "BLOCKED",
      reasonCode: input.blocked.reasonCode,
      detail: input.blocked.detail,
    };
  }
  // 证据不完整或必需步骤被跳过 → REVIEW。
  if (!input.evidenceComplete || input.requiredStepsSkipped) {
    return {
      caseVersionId: input.caseVersionId,
      verdict: "REVIEW",
      reasonCode: "TEST_DATA",
      detail: !input.evidenceComplete ? "必需断言缺少可验证证据" : "必要步骤被跳过",
    };
  }
  if (required.length === 0) {
    return {
      caseVersionId: input.caseVersionId,
      verdict: "REVIEW",
      reasonCode: "UNSUPPORTED",
      detail: "空断言集合禁止 PASS",
    };
  }
  const allRequiredPass = required.every((a) => a.result === "PASS");
  if (!allRequiredPass) {
    // 必需断言存在 REVIEW/NOT_EVALUATED 但无 FAIL、无阻塞 → 证据/判定不充分。
    return {
      caseVersionId: input.caseVersionId,
      verdict: "REVIEW",
      reasonCode: "TEST_DATA",
      detail: "存在未完成判定的必需断言",
    };
  }
  return { caseVersionId: input.caseVersionId, verdict: "PASS", reasonCode: "NONE" };
}

export interface RunMetrics {
  totalSelected: number;
  counts: Record<CaseVerdict, number>;
  unstable: number;
  /** 用例执行率 = (PASS+FAIL)/选定；分母为零 → null（显示 N/A）。 */
  executionRate: number | null;
  /** 通过比例 = PASS/选定；分母为零 → null。 */
  passRate: number | null;
  /** 规则覆盖率 = 有已批准用例的规则 / 应测试的已批准规则（基线范围）。 */
  ruleCoverage: number | null;
  /** 严格验收状态（FR-10）。 */
  acceptanceStatus: "PASS" | "FAIL" | "INCOMPLETE" | "PENDING";
  /** 缺可信构建标识时为 false（报告显示“版本未验证”）。 */
  buildVerified: boolean | null;
}

export interface RunAggregateInput {
  cases: CaseVerdictResult[];
  /** 基线中应测试的已批准规则数与其中已被用例覆盖的规则数。 */
  baselineRuleTotal?: number;
  baselineRuleCovered?: number;
  /** buildId 是否存在；null 表示未知。 */
  hasBuildId?: boolean | null;
  cancelled?: boolean;
  /** 平台执行故障（lifecycle ERROR）。 */
  platformError?: boolean;
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return numerator / denominator;
}

export function aggregateRun(input: RunAggregateInput): RunMetrics {
  const verdicts: CaseVerdict[] = ["PASS", "FAIL", "BLOCKED", "REVIEW", "NOT_RUN"];
  const counts: Record<CaseVerdict, number> = {
    PASS: 0,
    FAIL: 0,
    BLOCKED: 0,
    REVIEW: 0,
    NOT_RUN: 0,
  };
  let unstable = 0;
  for (const c of input.cases) {
    counts[c.verdict] += 1;
    if ("unstable" in c && (c as { unstable?: boolean }).unstable) unstable += 1;
  }
  const total = input.cases.length;
  const executionRate = ratio(counts.PASS + counts.FAIL, total);
  const passRate = ratio(counts.PASS, total);
  const ruleCoverage =
    input.baselineRuleTotal && input.baselineRuleTotal > 0
      ? (input.baselineRuleCovered ?? 0) / input.baselineRuleTotal
      : null;

  // 严格验收（FR-10）：
  // 有 FAIL → FAIL；否则任何阻塞/待确认/未执行/unstable/构建漂移/证据问题 → INCOMPLETE；
  // 非空范围全部 PASS 才是 PASS。
  let acceptanceStatus: RunMetrics["acceptanceStatus"] = "PENDING";
  if (total === 0) {
    acceptanceStatus = "INCOMPLETE";
  } else if (counts.FAIL > 0) {
    acceptanceStatus = "FAIL";
  } else if (
    counts.BLOCKED > 0 ||
    counts.REVIEW > 0 ||
    counts.NOT_RUN > 0 ||
    unstable > 0 ||
    input.cancelled ||
    input.platformError ||
    input.hasBuildId === false
  ) {
    acceptanceStatus = "INCOMPLETE";
  } else if (counts.PASS === total) {
    acceptanceStatus = "PASS";
  } else {
    acceptanceStatus = "INCOMPLETE";
  }

  return {
    totalSelected: total,
    counts,
    unstable,
    executionRate,
    passRate,
    ruleCoverage,
    acceptanceStatus,
    buildVerified: input.hasBuildId ?? null,
  };
}

/** 百分比显示辅助：null → "N/A"（不得显示 100%）。 */
export function percent(value: number | null): string {
  if (value === null) return "N/A";
  return `${(value * 100).toFixed(1)}%`;
}
