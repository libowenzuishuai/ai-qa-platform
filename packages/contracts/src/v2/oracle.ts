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

/** R0.5：观测类型——业务事实如何被程序化读取（页面文本/可见性/API 字段/状态码/数据库值）。 */
export const OracleObservationType = z.enum(["ui_text", "ui_visible", "api_field", "api_status", "db_value"]);

export const OracleAssertion = z.object({
  /** 断言稳定 ID（Oracle 内唯一）。 */
  id: z.string().min(1).max(128),
  /** 来源规则版本（断言不得凭空出现）。 */
  ruleVersionId: EntityId,
  /** 确定性断言：期望值/运算符/单位全部冻结。 */
  kind: z.literal("deterministic"),
  /** 被测业务事实（如"采购单状态文本"）；不是页面 selector（那是操作层）。 */
  fact: z.string().min(1).max(500),
  /** 观测类型：如何读取事实。 */
  observationType: OracleObservationType,
  /** 观测定位引用（如 API 字段名 / UI 元素业务名；不含实现 selector）。 */
  observationRef: z.string().min(1).max(300),
  operator: z.enum(["equals", "not_equals", "greater_than", "less_than", "exists", "not_exists", "visible", "hidden"]),
  /** 期望值：数值断言用十进制字符串；文本断言（ui.text equals）用受长度约束的原文。 */
  expected: z.union([DecimalString, z.boolean(), z.string().min(1).max(2000), z.null()]),
  /** 适用前提（如"金额超过 5000 元时"）；空=无条件。 */
  precondition: z.string().max(1000).nullable().default(null),
  unit: z.string().min(1).max(64).nullable().default(null),
  /** 数值容差（十进制；仅数值比较）。 */
  tolerance: DecimalString.nullable().default(null),
  /** 允许的角色（权限断言的依据，不可扩大）。 */
  allowedRoles: z.array(z.string().min(1).max(80)).max(20).default([]),
  /** 是否为必需断言（缺失即不能 PASS）。 */
  required: z.boolean().default(true),
}).strict().superRefine((a, ctx) => {
  // 运算符与期望值类型一致性（R0.5 验收：金额/布尔/存在性正反例）。
  const numericOps = ["greater_than", "less_than"];
  if (numericOps.includes(a.operator) && !/^-?\d+(\.\d+)?$/.test(String(a.expected)))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expected"], message: `${a.operator} 要求十进制数值期望` });
  if (["equals", "not_equals"].includes(a.operator) && a.expected === null)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expected"], message: `${a.operator} 需要 expected（用 exists/not_exists 表达存在性）` });
  if (a.tolerance !== null && !numericOps.concat(["equals"]).includes(a.operator))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tolerance"], message: "容差仅适用于数值比较" });
});
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
  // R0.5：断言 ID 唯一。
  const ids = new Set<string>();
  for (const a of spec.assertions) {
    if (ids.has(a.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["assertions"], message: `断言 ID 重复：${a.id}` });
    ids.add(a.id);
  }
  if (spec.status === "APPROVED") {
    // 批准时：每规则至少一条断言或有 blocked/not_applicable 依据（不能静默缺测）。
    for (const ruleId of spec.ruleVersionIds) {
      const hasAssertion = spec.assertions.some((a) => a.ruleVersionId === ruleId);
      const declared = spec.coverageDeclarations.filter((c) => c.ruleVersionId === ruleId);
      if (!hasAssertion && !declared.some((c) => c.status === "blocked" || c.status === "not_applicable"))
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["assertions"], message: `规则 ${ruleId} 无断言且无 blocked/not_applicable 声明（不能批准）` });
      // 六维齐全：normal/boundary/permission/multi_role/state/persistence 每维必有声明。
      const dims = new Set(declared.map((c) => c.dimension));
      for (const dim of ["normal", "boundary", "permission", "multi_role", "state", "persistence"] as const) {
        if (!dims.has(dim))
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["coverageDeclarations"], message: `规则 ${ruleId} 缺 ${dim} 维度覆盖声明（不能批准）` });
      }
    }
  }
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
