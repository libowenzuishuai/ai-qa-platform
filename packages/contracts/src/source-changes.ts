import { z } from "zod";
import { EntityId } from "./common.js";
import {
  DocumentFormat,
  ParsedDocumentBundle,
  SourceSpanRecord,
} from "./document.js";
import { RuleVersion } from "./rule.js";
import { TestCaseVersion } from "./test-case.js";

/** B2 v1: source evidence, never an instruction to rewrite approved assets. */
const base = { path: z.string().min(1) };
export const SourceChange = z.discriminatedUnion("kind", [
  z
    .object({
      ...base,
      kind: z.literal("added"),
      old: z.null(),
      new: SourceSpanRecord,
      reason: z.null(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("removed"),
      old: SourceSpanRecord,
      new: z.null(),
      reason: z.null(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("modified"),
      old: SourceSpanRecord,
      new: SourceSpanRecord,
      reason: z.null(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("uncertain"),
      old: SourceSpanRecord,
      new: SourceSpanRecord.nullable(),
      reason: z.string().trim().min(1),
    })
    .strict(),
]);
export type SourceChange = z.infer<typeof SourceChange>;
export const SourceComparisonInput = z
  .object({
    path: z.string().min(1),
    oldBundle: ParsedDocumentBundle,
    newBundle: ParsedDocumentBundle,
  })
  .strict();
export const SourceChangeReport = z
  .object({
    path: z.string().min(1),
    oldDocumentVersionId: EntityId,
    newDocumentVersionId: EntityId,
    format: DocumentFormat,
    changes: z.array(SourceChange).max(40000),
  })
  .strict()
  .superRefine((r, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (r.oldDocumentVersionId === r.newDocumentVersionId)
      fail("对比需要不同文档版本");
    for (const c of r.changes) {
      if (c.path !== r.path) fail("片段路径与报告不一致");
      if (c.old && c.old.documentVersionId !== r.oldDocumentVersionId)
        fail("旧片段版本不匹配");
      if (c.new && c.new.documentVersionId !== r.newDocumentVersionId)
        fail("新片段版本不匹配");
      if (
        c.kind === "modified" &&
        (canonical(c.old.locator) !== canonical(c.new.locator) ||
          c.old.quotedText === c.new.quotedText)
      )
        fail("modified 必须同位置不同原文");
    }
  });
export type SourceChangeReport = z.infer<typeof SourceChangeReport>;
export const ImpactAnalysisInput = z
  .object({
    sourceReports: z.array(SourceChangeReport).max(100),
    approvedRuleVersions: z.array(RuleVersion),
    approvedCaseVersions: z.array(TestCaseVersion),
  })
  .strict()
  .superRefine((i, ctx) => {
    if (
      i.approvedRuleVersions.some((r) => r.reviewStatus !== "APPROVED") ||
      i.approvedCaseVersions.some((c) => c.approvalStatus !== "APPROVED")
    )
      ctx.addIssue({ code: "custom", message: "影响分析只接受已批准资产" });
  });
export type ImpactAnalysisInput = z.infer<typeof ImpactAnalysisInput>;
export const ImpactAnalysisOutput = z
  .object({
    affectedRules: z.array(
      z
        .object({
          ruleVersionId: EntityId,
          reason: z.string().min(1),
          evidenceRefs: z
            .array(
              z
                .object({ documentVersionId: EntityId, spanId: EntityId })
                .strict(),
            )
            .min(1),
          suggestion: z.string().min(1),
        })
        .strict(),
    ),
    affectedCases: z.array(
      z
        .object({
          caseVersionId: EntityId,
          viaRuleVersionIds: z.array(EntityId).min(1),
          reason: z.literal("RULE_SOURCE_CHANGED"),
          suggestion: z.string().min(1),
        })
        .strict(),
    ),
    unresolved: z.array(z.string().min(1)),
    requiresHumanReview: z.literal(true),
  })
  .strict();
export type ImpactAnalysisOutput = z.infer<typeof ImpactAnalysisOutput>;
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x).sort(([a], [b]) => a.localeCompare(b)),
        )
      : x,
  );
const key = (doc: string, id: string) => JSON.stringify([doc, id]);
const equal = (a: string[], b: string[]) =>
  a.length === new Set(a).size &&
  b.length === new Set(b).size &&
  canonical([...a].sort()) === canonical([...b].sort());

/** Final TS joint validation: exact source intersection and case closure, no extra/omitted assets. */
export function validateImpactAnalysis(
  input: ImpactAnalysisInput,
  output: ImpactAnalysisOutput,
) {
  const problems: string[] = [];
  if (
    !ImpactAnalysisInput.safeParse(input).success ||
    !ImpactAnalysisOutput.safeParse(output).success
  )
    return { ok: false, problems: ["影响分析结构或批准状态无效"] };
  const changes = input.sourceReports.flatMap((r) => r.changes);
  const expected = new Map<string, SourceChange[]>();
  for (const rule of input.approvedRuleVersions) {
    const refs = new Set(
      rule.sources.flatMap((s) =>
        s.sourceSpanIds.map((id) => key(s.documentVersionId, id)),
      ),
    );
    const hits = changes.filter(
      (c) => c.old && refs.has(key(c.old.documentVersionId, c.old.id)),
    );
    if (hits.length) expected.set(rule.id, hits);
  }
  if (
    !equal(
      output.affectedRules.map((r) => r.ruleVersionId),
      [...expected.keys()],
    )
  )
    problems.push("受影响规则集合不等于来源交集");
  for (const r of output.affectedRules) {
    const hits = expected.get(r.ruleVersionId) ?? [];
    const refs = [
      ...new Set(
        hits.flatMap((c) =>
          [c.old, c.new]
            .filter((s) => s !== null)
            .map((s) => key(s.documentVersionId, s.id)),
        ),
      ),
    ];
    if (
      !equal(
        r.evidenceRefs.map((s) => key(s.documentVersionId, s.spanId)),
        refs,
      )
    )
      problems.push("影响证据引用不真实或遗漏");
    const reasons = [
      ...new Set(
        hits.map((c) =>
          [c.old, c.new].some((s) => s && s.extractionQuality !== "GOOD")
            ? "SOURCE_QUALITY_UNCERTAIN"
            : c.kind === "uncertain"
              ? "SOURCE_UNCERTAIN"
              : c.kind === "removed"
                ? "SOURCE_REMOVED"
                : "SOURCE_MODIFIED",
        ),
      ),
    ]
      .sort()
      .join("+");
    if (r.reason !== reasons) problems.push("影响原因与变更质量不一致");
  }
  const cases = input.approvedCaseVersions.filter((c) =>
    c.ruleVersionIds.some((id) => expected.has(id)),
  );
  if (
    !equal(
      output.affectedCases.map((c) => c.caseVersionId),
      cases.map((c) => c.id),
    )
  )
    problems.push("受影响用例集合不等于规则传导闭包");
  for (const c of output.affectedCases) {
    const original = cases.find((x) => x.id === c.caseVersionId);
    if (
      !equal(c.viaRuleVersionIds, [
        ...new Set(
          original?.ruleVersionIds.filter((id) => expected.has(id)) ?? [],
        ),
      ])
    )
      problems.push("用例规则传导引用无效");
  }
  if (
    changes.some(
      (c) =>
        c.kind === "uncertain" ||
        c.kind === "added" ||
        [c.old, c.new].some((s) => s && s.extractionQuality !== "GOOD"),
    ) &&
    !output.unresolved.length
  )
    problems.push("不确定变更必须保留待复核事项");
  if (
    new Set(input.approvedRuleVersions.map((r) => r.id)).size !==
      input.approvedRuleVersions.length ||
    new Set(input.approvedCaseVersions.map((c) => c.id)).size !==
      input.approvedCaseVersions.length
  )
    problems.push("输入资产版本重复");
  return { ok: !problems.length, problems };
}

export function validateSourceComparison(
  input: z.infer<typeof SourceComparisonInput>,
  report: SourceChangeReport,
) {
  const problems: string[] = [];
  if (
    !SourceComparisonInput.safeParse(input).success ||
    !SourceChangeReport.safeParse(report).success
  )
    return { ok: false, problems: ["来源对比格式无效"] };
  if (
    report.path !== input.path ||
    report.oldDocumentVersionId !== input.oldBundle.documentVersionId ||
    report.newDocumentVersionId !== input.newBundle.documentVersionId ||
    report.format !== input.newBundle.format ||
    input.oldBundle.format !== input.newBundle.format
  )
    problems.push("来源对比版本或路径不匹配");
  for (const b of [input.oldBundle, input.newBundle]) {
    if (
      !["PARSED", "NEEDS_OCR"].includes(b.parseStatus) ||
      new Set(b.spans.map((s) => s.id)).size !== b.spans.length ||
      b.spans.length > 20000
    )
      problems.push("资料尚未完成解析或片段非法");
  }
  for (const [side, bundle] of [
    ["old", input.oldBundle],
    ["new", input.newBundle],
  ] as const) {
    const spans = new Map(bundle.spans.map((s) => [s.id, s]));
    for (const c of report.changes) {
      const span = c[side];
      if (span && canonical(span) !== canonical(spans.get(span.id)))
        problems.push("变更引用了不存在或被篡改的来源片段");
    }
  }
  return { ok: !problems.length, problems };
}
