import { z } from "zod";

/**
 * PRD §5 执行状态契约。
 * 三种状态分别存储：Run.lifecycle / Case.verdict / reasonCode，
 * 以及 Assertion.result。本文件只定义合法取值与 Run 生命周期状态机，
 * 不把“正常结束”与“测试通过”混为一谈。
 */

/** Run 生命周期（PRD §5.1）。终态：FINISHED / CANCELLED / ERROR，不可回退。 */
export const RunLifecycle = z.enum([
  "QUEUED",
  "PREPARING",
  "RUNNING",
  "FINALIZING",
  "FINISHED",
  "CANCEL_REQUESTED",
  "CANCELLED",
  "ERROR",
]);
export type RunLifecycle = z.infer<typeof RunLifecycle>;

export const RUN_LIFECYCLE_TERMINAL: ReadonlySet<RunLifecycle> = new Set([
  "FINISHED",
  "CANCELLED",
  "ERROR",
]);

/**
 * 允许的状态迁移。
 * ERROR 表示平台执行故障，不等于业务 FAIL；
 * CANCEL_REQUESTED 可从任意非终态进入，最终落到 CANCELLED。
 */
export const RUN_LIFECYCLE_TRANSITIONS: Readonly<
  Record<Exclude<RunLifecycle, "FINISHED" | "CANCELLED" | "ERROR">, RunLifecycle[]>
> = {
  QUEUED: ["PREPARING", "CANCEL_REQUESTED", "ERROR"],
  PREPARING: ["RUNNING", "CANCEL_REQUESTED", "ERROR"],
  RUNNING: ["FINALIZING", "CANCEL_REQUESTED", "ERROR"],
  FINALIZING: ["FINISHED", "CANCEL_REQUESTED", "ERROR"],
  CANCEL_REQUESTED: ["CANCELLED", "ERROR"],
};

export function canTransitionRunLifecycle(
  from: RunLifecycle,
  to: RunLifecycle,
): boolean {
  if (RUN_LIFECYCLE_TERMINAL.has(from)) return false;
  const nonTerminal = from as Exclude<RunLifecycle, "FINISHED" | "CANCELLED" | "ERROR">;
  const allowed = RUN_LIFECYCLE_TRANSITIONS[nonTerminal];
  if (!allowed) return false;
  return allowed.includes(to);
}

/** 用例业务判定（PRD §5.1）。NOT_RUN 表示从未开始的选定用例。 */
export const CaseVerdict = z.enum([
  "PASS",
  "FAIL",
  "BLOCKED",
  "REVIEW",
  "NOT_RUN",
]);
export type CaseVerdict = z.infer<typeof CaseVerdict>;

/**
 * 失败/阻塞原因码（PRD §5.1）。
 * NONE 仅用于 PASS；BUSINESS_MISMATCH 是唯一表示业务不符合需求的原因码。
 */
export const ReasonCode = z.enum([
  "BUSINESS_MISMATCH",
  "ENVIRONMENT",
  "AUTH",
  "TEST_DATA",
  "LOCATOR",
  "MODEL",
  "TIME_BUDGET",
  "UNCERTAIN_SIDE_EFFECT",
  "UNSUPPORTED",
  "CANCELLED",
  "NONE",
]);
export type ReasonCode = z.infer<typeof ReasonCode>;

/** 单条断言的判定结果（PRD §5.1）。 */
export const AssertionResultKind = z.enum([
  "PASS",
  "FAIL",
  "REVIEW",
  "NOT_EVALUATED",
]);
export type AssertionResultKind = z.infer<typeof AssertionResultKind>;

/** 规则分类（PRD FR-03）。模型置信度不能代替业务批准。 */
export const RuleClassification = z.enum(["EXPLICIT", "INFERRED", "UNKNOWN"]);
export type RuleClassification = z.infer<typeof RuleClassification>;

/** 规则评审状态。被引用的已批准版本不可原地覆盖。 */
export const RuleReviewStatus = z.enum([
  "DRAFT",
  "NEEDS_REVIEW",
  "APPROVED",
  "REJECTED",
  "SUPERSEDED",
]);
export type RuleReviewStatus = z.infer<typeof RuleReviewStatus>;

/** 用例版本审批状态。 */
export const CaseApprovalStatus = z.enum([
  "DRAFT",
  "NEEDS_REVIEW",
  "APPROVED",
  "REJECTED",
  "SUPERSEDED",
]);
export type CaseApprovalStatus = z.infer<typeof CaseApprovalStatus>;

/** 平台角色（PRD §2）。与待测系统内的业务角色（申请人/主管）是两个概念。 */
export const PlatformRole = z.enum(["ADMIN", "LEAD", "VIEWER"]);
export type PlatformRole = z.infer<typeof PlatformRole>;

/** 运行模式（PRD FR-11）。mock 输出必须标记 simulated 并从 real 指标排除。 */
export const RunMode = z.enum(["real", "mock"]);
export type RunMode = z.infer<typeof RunMode>;

/** 证据敏感级别（PRD FR-09）。restricted_raw 不进入普通报告。 */
export const ArtifactSensitivity = z.enum(["NORMAL", "RESTRICTED_RAW"]);
export type ArtifactSensitivity = z.infer<typeof ArtifactSensitivity>;

/** 缺陷状态机（PRD FR-09）。历史不可删除覆盖。 */
export const DefectStatus = z.enum([
  "CANDIDATE",
  "CONFIRMED",
  "FIX_PENDING",
  "READY_FOR_RETEST",
  "VERIFIED",
  "REJECTED",
  "REOPENED",
]);
export type DefectStatus = z.infer<typeof DefectStatus>;

/** 资产来源：手工种子与模型生成必须明确区分。 */
export const AssetOrigin = z.enum(["manual", "model"]);
export type AssetOrigin = z.infer<typeof AssetOrigin>;

/** 动作副作用类别（PRD §7.1）。WRITE 不允许在状态不明时重放。 */
export const SideEffect = z.enum(["READ", "WRITE"]);
export type SideEffect = z.infer<typeof SideEffect>;
