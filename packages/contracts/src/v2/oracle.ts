import { z } from "zod";
import { EntityId, IsoDateTime, DecimalString } from "../common.js";
import { canonicalStringify } from "../acceptance-hash.js";
import { createHash } from "node:crypto";

/**
 * v2 OracleSpec（DES-03/LOOP-03）：不可变业务判定契约。
 *
 * 与操作计划分离：定位、入口、等待策略、数据构造可以调整；expected、阈值、
 * 角色权限、断言集合不可调整。APPROVED 后内容不可变（哈希冻结）；
 * 需求变更 = 新版本 + 新批准 + 新运行，不允许原地改写。
 *
 * 来源约束：只允许引用已批准（APPROVED）RuleVersion，且同项目；
 * 引用闭包在服务端创建时校验，契约层冻结形状。
 */

export const OracleAssertion = z.object({
  /** 断言稳定 ID（Oracle 内唯一）。 */
  id: z.string().min(1).max(128),
  /** 来源规则版本（断言不得凭空出现）。 */
  ruleVersionId: EntityId,
  /** 确定性断言：期望值/运算符/单位全部冻结。 */
  kind: z.literal("deterministic"),
  operator: z.enum(["equals", "not_equals", "greater_than", "less_than", "exists", "not_exists", "visible", "hidden"]),
  expected: z.union([DecimalString, z.boolean(), z.null()]),
  unit: z.string().min(1).max(64).nullable().default(null),
  /** 允许的角色（权限断言的依据，不可扩大）。 */
  allowedRoles: z.array(z.string().min(1).max(80)).max(20).default([]),
  /** 是否为必需断言（缺失即不能 PASS）。 */
  required: z.boolean().default(true),
}).strict();
export type OracleAssertion = z.infer<typeof OracleAssertion>;

/** 视觉/语义候选断言：不确定，只能进 REVIEW，不能单独判 PASS。 */
export const OracleSemanticCandidate = z.object({
  id: z.string().min(1).max(128),
  ruleVersionId: EntityId,
  kind: z.literal("semantic_candidate"),
  description: z.string().min(1).max(2000),
  /** 语义候选不冻结 expected——必须人工复核，永不自动 PASS。 */
  expected: z.null(),
}).strict();
export type OracleSemanticCandidate = z.infer<typeof OracleSemanticCandidate>;

export const OracleSpecContent = z.object({
  projectId: EntityId,
  /** 引用的批准规则版本（闭包；全部须 APPROVED 且同项目）。 */
  ruleVersionIds: z.array(EntityId).min(1).max(500),
  assertions: z.array(OracleAssertion).min(1).max(2000),
  semanticCandidates: z.array(OracleSemanticCandidate).max(500).default([]),
  /** 六维覆盖声明：每条规则×维度须有依据或阻塞（DES-01）。 */
  coverageDeclarations: z.array(z.object({
    ruleVersionId: EntityId,
    dimension: z.enum(["normal", "boundary", "permission", "multi_role", "state", "persistence"]),
    status: z.enum(["planned", "blocked", "not_applicable"]),
    reason: z.string().min(1).max(2000),
  }).strict()).max(3000).default([]),
}).strict();
export type OracleSpecContent = z.infer<typeof OracleSpecContent>;

export const OracleSpecStatus = z.enum(["DRAFT", "APPROVED", "SUPERSEDED"]);

export const OracleSpec = OracleSpecContent.extend({
  id: EntityId,
  version: z.number().int().min(1),
  status: OracleSpecStatus.default("DRAFT"),
  /** 内容哈希：APPROVED 后不可变依据；操作计划引用该哈希。 */
  oracleHash: z.string().regex(/^[a-f0-9]{64}$/),
  supersedesId: EntityId.nullable().default(null),
  createdBy: z.string(),
  createdAt: IsoDateTime,
  approvedBy: z.string().nullable().default(null),
  approvedAt: IsoDateTime.nullable().default(null),
}).strict().superRefine((spec, ctx) => {
  // 引用闭包：断言引用的规则必须在规则集合内（防伪造来源）。
  const rules = new Set(spec.ruleVersionIds);
  for (const assertion of spec.assertions) {
    if (!rules.has(assertion.ruleVersionId))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["assertions"], message: `断言 ${assertion.id} 引用了未声明规则 ${assertion.ruleVersionId}` });
  }
  if (spec.assertions.every((a) => !a.required) && spec.assertions.length > 0)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["assertions"], message: "至少一条必需断言（空 Oracle 不能判 PASS）" });
  if (spec.status === "APPROVED" && (!spec.approvedBy || !spec.approvedAt))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["approvedBy"], message: "APPROVED 必须记录批准人与时间" });
});
export type OracleSpec = z.infer<typeof OracleSpec>;

/** 计算 oracleHash（内容字段规范化哈希；不含 id/version/status/审批元数据）。 */
export function computeOracleHash(content: OracleSpecContent): string {
  return createHash("sha256").update(canonicalStringify({
    projectId: content.projectId,
    ruleVersionIds: [...content.ruleVersionIds].sort(),
    assertions: content.assertions,
    semanticCandidates: content.semanticCandidates,
    coverageDeclarations: content.coverageDeclarations,
  })).digest("hex");
}
