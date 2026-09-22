import { createHash } from "node:crypto";
import { ParsedDocumentBundle, RuleVersion, TestCaseVersion, ChangeReviewAnalysisInput, ChangeReviewAnalysisOutput, canonicalStringify, validateSourceComparison, validateImpactAnalysis, } from "@ai-qa/contracts";
import { ApiError } from "./errors.js";
export const contentHash = (v) => createHash("sha256").update(canonicalStringify(v)).digest("hex");
export function ruleWire(row) {
    return RuleVersion.parse({
        ...row,
        role: row.role ?? undefined,
        precondition: row.precondition ?? undefined,
        condition: row.condition ?? undefined,
        reviewedAt: row.reviewedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
    });
}
export function caseWire(row) {
    return TestCaseVersion.parse({
        ...row,
        description: row.description ?? undefined,
        approvalHash: row.approvalHash ?? undefined,
        createdAt: row.createdAt.toISOString(),
    });
}
export async function loadReviewBundle(db, store, projectId, id) {
    const row = await db.documentVersion.findUnique({
        where: { id },
        include: { document: true, sourceSpans: true },
    });
    if (!row || row.document.projectId !== projectId)
        throw new ApiError("VALIDATION_ERROR", "资料不属于当前项目");
    if (!["PARSED", "NEEDS_OCR"].includes(row.parseStatus) ||
        !row.bundleStorageKey ||
        !row.bundleChecksum ||
        !store.verify(row.bundleStorageKey, row.bundleChecksum))
        throw new ApiError("VALIDATION_ERROR", "资料未完成解析或解析证据损坏");
    const bundle = ParsedDocumentBundle.parse(JSON.parse(store.read(row.bundleStorageKey).toString("utf8")));
    if (bundle.documentVersionId !== row.id ||
        bundle.format !== row.format ||
        bundle.spans.length !== row.sourceSpans.length)
        throw new ApiError("VALIDATION_ERROR", "解析片段与数据库不一致");
    const spans = new Map(row.sourceSpans.map((s) => [s.id, s]));
    for (const s of bundle.spans) {
        const saved = spans.get(s.id);
        if (!saved ||
            contentHash({
                id: saved.id,
                documentVersionId: saved.documentVersionId,
                locator: saved.locator,
                quotedText: saved.quotedText,
                extractionQuality: saved.extractionQuality,
            }) !== contentHash(s))
            throw new ApiError("VALIDATION_ERROR", "来源片段被修改或缺失");
    }
    return { row, bundle };
}
export async function freezeReviewInput(db, store, projectId, baselineId, oldId, newId) {
    const baseline = await db.baseline.findFirst({
        where: { id: baselineId, projectId },
    });
    if (!baseline)
        throw new ApiError("VALIDATION_ERROR", "验收基线不属于当前项目");
    if (baseline.caseVersionIds.length > 500 ||
        baseline.ruleVersionIds.length > 500)
        throw new ApiError("VALIDATION_ERROR", "首版变更分析最多支持 500 个规则和用例");
    const old = await loadReviewBundle(db, store, projectId, oldId), next = await loadReviewBundle(db, store, projectId, newId);
    if (old.row.documentId !== next.row.documentId ||
        old.row.version >= next.row.version ||
        old.row.format !== next.row.format)
        throw new ApiError("VALIDATION_ERROR", "请选择同一资料由旧到新的同格式版本");
    const rules = await db.ruleVersion.findMany({
        where: {
            id: { in: baseline.ruleVersionIds },
            rule: { projectId },
            reviewStatus: "APPROVED",
        },
        orderBy: { id: "asc" },
    });
    const cases = await db.testCaseVersion.findMany({
        where: {
            id: { in: baseline.caseVersionIds },
            projectId,
            approvalStatus: "APPROVED",
        },
        orderBy: { id: "asc" },
    });
    if (rules.length !== baseline.ruleVersionIds.length ||
        cases.length !== baseline.caseVersionIds.length ||
        cases.some((c) => c.ruleVersionIds.some((id) => !baseline.ruleVersionIds.includes(id))))
        throw new ApiError("VALIDATION_ERROR", "基线存在缺失、未批准或越界资产");
    if ([old.row, next.row].some((r) => !["real", "mock"].includes(r.mode)) ||
        rules.some((r) => r.origin === "model" &&
            !["real", "mock"].includes(r.generationMode ?? "")) ||
        cases.some((c) => c.origin === "model" &&
            !["real", "mock"].includes(c.generationMode ?? "")))
        throw new ApiError("VALIDATION_ERROR", "资料或资产的来源模式未确认");
    const input = ChangeReviewAnalysisInput.parse({
        comparison: {
            path: old.row.documentId,
            oldBundle: old.bundle,
            newBundle: next.bundle,
        },
        approvedRuleVersions: rules.map(ruleWire),
        approvedCaseVersions: cases.map(caseWire),
    });
    return {
        input,
        mode: [old.row, next.row].some((r) => r.mode === "mock") ||
            rules.some((r) => r.generationMode === "mock") ||
            cases.some((c) => c.generationMode === "mock")
            ? "mock"
            : "real",
    };
}
export function verifyReviewOutput(input, output) {
    const i = ChangeReviewAnalysisInput.parse(input), o = ChangeReviewAnalysisOutput.parse(output);
    const source = validateSourceComparison(i.comparison, o.sourceReport);
    const impact = validateImpactAnalysis({
        sourceReports: [o.sourceReport],
        approvedRuleVersions: i.approvedRuleVersions,
        approvedCaseVersions: i.approvedCaseVersions,
    }, o.impact);
    if (!source.ok || !impact.ok)
        throw new ApiError("MODEL_OUTPUT_INVALID", "变更分析未通过来源与影响联合校验", { problems: [...source.problems, ...impact.problems] });
    return o;
}
export function reviewTasks(output) {
    if (!output)
        return [];
    const o = ChangeReviewAnalysisOutput.parse(output);
    return [
        ...o.impact.affectedRules.map((r) => ({
            key: "RULE:" + r.ruleVersionId,
            assetType: "RULE",
            assetVersionId: r.ruleVersionId,
        })),
        ...o.impact.affectedCases.map((c) => ({
            key: "CASE:" + c.caseVersionId,
            assetType: "CASE",
            assetVersionId: c.caseVersionId,
        })),
        ...(o.impact.unresolved.length
            ? [
                {
                    key: "SOURCES:review",
                    assetType: "SOURCES",
                    assetVersionId: "review",
                },
            ]
            : []),
    ];
}
//# sourceMappingURL=change-review-service.js.map