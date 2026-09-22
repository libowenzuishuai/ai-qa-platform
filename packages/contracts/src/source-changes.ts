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

// ---------- R01：多文件快照差异 ----------

export const FileSnapshotEntry = z.object({
  /** 仓库内相对路径（UTF-8，大小写敏感，逐字节比较）。 */
  path: z.string().min(1).max(1024),
  bundle: ParsedDocumentBundle,
  /** 真实文件字节 sha256（DocumentVersion.checksum）：未变化/重命名判定的唯一字节证据。 */
  fileChecksum: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type FileSnapshotEntry = z.infer<typeof FileSnapshotEntry>;

export const MultiFileComparisonInput = z.object({
  oldFiles: z.array(FileSnapshotEntry).min(1).max(200),
  newFiles: z.array(FileSnapshotEntry).min(1).max(200),
  /** 本轮比较排除（不参与）的路径集合；范围变化本身要在报告中体现。 */
  excludedPaths: z.array(z.string().min(1).max(1024)).max(200).default([]),
}).strict().superRefine((input, ctx) => {
  for (const side of ["oldFiles", "newFiles"] as const) {
    const seen = new Set<string>();
    for (const entry of input[side]) {
      if (seen.has(entry.path)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [side],
          message: `路径重复：${entry.path}`,
        });
      }
      seen.add(entry.path);
    }
  }
});
export type MultiFileComparisonInput = z.infer<typeof MultiFileComparisonInput>;

/** 单个文件在多文件对比中的结局（闭集）。 */
export const FileOutcomeKind = z.enum([
  "unchanged",    // 同路径同内容哈希
  "modified",     // 同路径内容变化（内嵌片段级报告）
  "added",        // 仅存在于新版
  "removed",      // 仅存在于旧版
  "renamed",      // 唯一内容哈希跨路径匹配（仅同字节重命名）
  "uncertain",    // 解析失败/重复候选/预算截断，需人工分派
]);
export type FileOutcomeKind = z.infer<typeof FileOutcomeKind>;

export const FileOutcome = z.object({
  kind: FileOutcomeKind,
  /** 旧侧路径（added 时为 null）。 */
  oldPath: z.string().min(1).max(1024).nullable(),
  /** 新侧路径（removed 时为 null）。 */
  newPath: z.string().min(1).max(1024).nullable(),
  /** 内容指纹（sha256，覆盖文本与解析质量；unchanged/renamed 两侧一致）。 */
  contentHash: z.string().nullable(),
  /** modified 时的片段级差异报告（复用单文件口径）。 */
  fragmentReport: SourceChangeReport.nullable(),
  /** uncertain/removed/added 的说明（重命名候选、解析失败原因等）。 */
  reason: z.string().nullable(),
}).strict();
export type FileOutcome = z.infer<typeof FileOutcome>;

export const MultiFileChangeReport = z.object({
  outcomes: z.array(FileOutcome).min(1).max(400),
  /** 输入对账：两侧文件总数与各结局计数（默默遗漏即拒绝）。 */
  totals: z.object({
    oldFiles: z.number().int().min(0),
    newFiles: z.number().int().min(0),
    unchanged: z.number().int().min(0),
    modified: z.number().int().min(0),
    added: z.number().int().min(0),
    removed: z.number().int().min(0),
    renamed: z.number().int().min(0),
    uncertain: z.number().int().min(0),
  }),
  /** 回显本轮排除路径（供审计比对口径）。 */
  excludedPaths: z.array(z.string().min(1).max(1024)).max(200).default([]),
  /** 排除范围与本轮快照冲突（排除项仍出现在对比快照里 → 口径漂移）。 */
  exclusionsChanged: z.boolean(),
  /** 是否有文件因超过单次预算未完成比较（分页续比）。 */
  truncated: z.boolean(),
}).strict().superRefine((report, ctx) => {
  // 覆盖对账：每个结局恰好覆盖一个旧文件或一个新文件（renamed 覆盖两侧各一）。
  const coveredOld = new Set<string>();
  const coveredNew = new Set<string>();
  for (const outcome of report.outcomes) {
    if (outcome.oldPath) {
      if (coveredOld.has(outcome.oldPath)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcomes"], message: `旧路径重复归属：${outcome.oldPath}` });
      }
      coveredOld.add(outcome.oldPath);
    }
    if (outcome.newPath) {
      if (coveredNew.has(outcome.newPath)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcomes"], message: `新路径重复归属：${outcome.newPath}` });
      }
      coveredNew.add(outcome.newPath);
    }
    if (outcome.kind === "renamed" && (!outcome.oldPath || !outcome.newPath || outcome.oldPath === outcome.newPath)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcomes"], message: "renamed 必须是不同路径" });
    }
    if (outcome.kind === "modified" && !outcome.fragmentReport) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcomes"], message: "modified 必须内嵌片段级报告" });
    }
    if (outcome.kind === "uncertain" && !outcome.reason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcomes"], message: "uncertain 必须说明原因" });
    }
  }
  if (
    coveredOld.size !== report.totals.oldFiles ||
    coveredNew.size !== report.totals.newFiles
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["totals"],
      message: `覆盖对账失败：旧 ${coveredOld.size}/${report.totals.oldFiles}，新 ${coveredNew.size}/${report.totals.newFiles}`,
    });
  }
  const count = (k: z.infer<typeof FileOutcomeKind>) => report.outcomes.filter(o => o.kind === k).length;
  for (const k of FileOutcomeKind.options) {
    if (count(k) !== report.totals[k]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["totals"],
        message: `${k} 计数与明细不一致`,
      });
    }
  }
});
export type MultiFileChangeReport = z.infer<typeof MultiFileChangeReport>;
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
  const exact=(span:z.infer<typeof SourceSpanRecord>)=>canonical({locator:span.locator,quotedText:span.quotedText});
  const index=(spans:z.infer<typeof SourceSpanRecord>[])=>{const result=new Map<string,z.infer<typeof SourceSpanRecord>[]>();for(const span of spans){const k=exact(span);result.set(k,[...(result.get(k)??[]),span]);}return result;};
  const oldIndex=index(input.oldBundle.spans),newIndex=index(input.newBundle.spans);
  for(const [side,bundle] of [['old',input.oldBundle],['new',input.newBundle]] as const){
    const changed=new Set(report.changes.map(c=>c[side]?.id).filter(Boolean));
    for(const span of bundle.spans){
      const a=oldIndex.get(exact(span))??[],b=newIndex.get(exact(span))??[];
      const unchanged=a.length===1&&b.length===1&&a[0]!.extractionQuality==='GOOD'&&b[0]!.extractionQuality==='GOOD';
      if(!unchanged&&!changed.has(span.id))problems.push('差异报告遗漏了变化或低质量片段');
      if(unchanged&&changed.has(span.id))problems.push('差异报告将唯一未变片段标为变化');
    }
  }
  return { ok: !problems.length, problems };
}

/** Platform loads all assets; callers only choose registered versions. */
export const ChangeReviewJobRequest=z.object({
  baselineId:EntityId,oldDocumentVersionId:EntityId,newDocumentVersionId:EntityId,
  idempotencyKey:z.string().min(1).max(120),
}).strict();
export const ChangeReviewResolution=z.object({
  assetType:z.enum(['RULE','CASE','SOURCES']),assetVersionId:EntityId,
  decision:z.enum(['KEEP','REPLACED']),reason:z.string().trim().min(5).max(4000),
  replacementVersionId:EntityId.optional(),
}).strict().superRefine((v,c)=>{
  if(v.decision==='REPLACED'&&!v.replacementVersionId)c.addIssue({code:'custom',message:'替换必须选择已批准的新版本'});
  if(v.decision==='KEEP'&&v.replacementVersionId)c.addIssue({code:'custom',message:'保留不能带替换版本'});
  if(v.assetType==='SOURCES'&&v.decision!=='KEEP')c.addIssue({code:'custom',message:'来源待办需说明如何处理新增或不确定内容'});
});
export const ChangeReviewAnalysisInput=z.object({comparison:SourceComparisonInput,approvedRuleVersions:z.array(RuleVersion).max(500),approvedCaseVersions:z.array(TestCaseVersion).max(500)}).strict();
export const ChangeReviewAnalysisOutput=z.object({sourceReport:SourceChangeReport,impact:ImpactAnalysisOutput}).strict();
