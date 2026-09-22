import { z } from "zod";
import { EntityId } from "./common.js";
import { canonicalStringify } from "./acceptance-hash.js";
import {
  DocumentFormat,
  ParseStatus,
  ParsedDocumentBundle,
} from "./document.js";
import {
  SourceChangeReport,
  validateSourceComparison,
} from "./source-changes.js";

export const SNAPSHOT_MAX_FILES = 200;
export const SNAPSHOT_MAX_SPANS = 40000;
export const SNAPSHOT_MAX_CHARS = 2000000;
const path = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (v) =>
      !/[\\:\x00-\x1f\x7f]/.test(v) &&
      v.split("/").every((s) => s !== "" && s !== "." && s !== ".."),
    "路径必须为规范化仓库相对路径",
  );
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const SnapshotFileEntry = z
  .object({
    path,
    checksum: hash.nullable(),
    sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    documentVersionId: EntityId.nullable(),
    format: DocumentFormat.nullable(),
    fetchStatus: z.enum(["OK", "NOT_FETCHED", "FETCH_FAILED"]),
    parseStatus: ParseStatus.nullable(),
  })
  .strict();
export type SnapshotFileEntry = z.infer<typeof SnapshotFileEntry>;
export const RepositorySnapshotManifest = z
  .object({
    snapshotId: EntityId,
    repositoryId: EntityId,
    commitSha: z.string().regex(/^[a-f0-9]{40}$/),
    scope: z
      .object({
        root: z.union([z.literal(""), path]),
        include: z.array(path).min(1).max(100),
        exclude: z.array(path).max(100),
        policyVersion: z.string().min(1).max(100),
      })
      .strict(),
    enumerationStatus: z.enum(["COMPLETE", "PARTIAL", "FAILED"]),
    enumerationReason: z.string().trim().min(1).max(1000).nullable(),
    entries: z.array(SnapshotFileEntry).max(SNAPSHOT_MAX_FILES),
  })
  .strict();
export type RepositorySnapshotManifest = z.infer<
  typeof RepositorySnapshotManifest
>;
const InputShape = z
  .object({
    oldSnapshot: RepositorySnapshotManifest,
    newSnapshot: RepositorySnapshotManifest,
    bundles: z.record(ParsedDocumentBundle),
  })
  .strict();
type Input = z.infer<typeof InputShape>;
const scopeKey = (s: RepositorySnapshotManifest["scope"]) =>
  canonicalStringify({
    ...s,
    include: [...s.include].sort(),
    exclude: [...s.exclude].sort(),
  });
function inputIssues(i: Input): string[] {
  const issues: string[] = [];
  const entries = [...i.oldSnapshot.entries, ...i.newSnapshot.entries];
  if (i.oldSnapshot.repositoryId !== i.newSnapshot.repositoryId)
    issues.push("快照不属于同一仓库");
  if (i.oldSnapshot.snapshotId === i.newSnapshot.snapshotId)
    issues.push("对比需要不同快照");
  if (scopeKey(i.oldSnapshot.scope) !== scopeKey(i.newSnapshot.scope))
    issues.push("扫描范围或策略不一致");
  const versions = new Map<string, string>();
  const byteSizes = new Map<string, number>();
  for (const s of [i.oldSnapshot, i.newSnapshot]) {
    if (new Set(s.entries.map((e) => e.path)).size !== s.entries.length)
      issues.push("快照路径重复");
    if ((s.enumerationStatus === "COMPLETE") !== (s.enumerationReason === null))
      issues.push("扫描完整性说明不一致");
    if (
      new Set(s.scope.include).size !== s.scope.include.length ||
      new Set(s.scope.exclude).size !== s.scope.exclude.length
    )
      issues.push("范围重复");
    for (const e of s.entries) {
      if (s.scope.root && !e.path.startsWith(s.scope.root + "/"))
        issues.push("文件不在扫描根目录");
      if (
        e.fetchStatus === "OK" &&
        (e.checksum === null || e.sizeBytes === null || e.format === null)
      )
        issues.push("成功取得的文件缺字节元数据");
      if (
        e.fetchStatus !== "OK" &&
        (e.parseStatus !== null || e.documentVersionId !== null)
      )
        issues.push("未取得文件不得声称已解析");
      if ((e.parseStatus === null) !== (e.documentVersionId === null))
        issues.push("解析状态与版本标识不一致");
      if (
        e.fetchStatus === "OK" &&
        e.checksum !== null &&
        e.sizeBytes !== null
      ) {
        if (
          byteSizes.has(e.checksum) &&
          byteSizes.get(e.checksum) !== e.sizeBytes
        )
          issues.push("相同字节哈希的文件大小矛盾");
        byteSizes.set(e.checksum, e.sizeBytes);
      }
      if (e.documentVersionId) {
        const meta = canonicalStringify([
          e.checksum,
          e.sizeBytes,
          e.format,
          e.parseStatus,
        ]);
        if (
          versions.has(e.documentVersionId) &&
          versions.get(e.documentVersionId) !== meta
        )
          issues.push("同一解析版本元数据冲突");
        versions.set(e.documentVersionId, meta);
        const b = i.bundles[e.documentVersionId];
        if (
          b &&
          (b.documentVersionId !== e.documentVersionId ||
            b.format !== e.format ||
            b.parseStatus !== e.parseStatus)
        )
          issues.push("bundle 归属/格式/状态不匹配");
      }
    }
  }
  let spans = 0,
    chars = 0;
  if (Object.keys(i.bundles).length > SNAPSHOT_MAX_FILES * 2)
    issues.push("bundle 数量超限");
  for (const [id, b] of Object.entries(i.bundles)) {
    if (!entries.some((e) => e.documentVersionId === id))
      issues.push("bundle 未被快照引用");
    if (b.coverageSummary.totalBlocks !== b.blocks.length)
      issues.push("解析块数与实际内容不一致");
    if (
      new Set(b.spans.map((s) => s.id)).size !== b.spans.length ||
      new Set(b.blocks.map((s) => s.id)).size !== b.blocks.length
    )
      issues.push("bundle 片段或块标识重复");
    spans += b.spans.length;
    chars +=
      b.blocks.reduce((n, x) => n + Array.from(x.text).length, 0) +
      b.spans.reduce((n, x) => n + Array.from(x.quotedText ?? "").length, 0);
  }
  if (spans > SNAPSHOT_MAX_SPANS || chars > SNAPSHOT_MAX_CHARS)
    issues.push("快照内容超过比较预算");
  return issues;
}
export const SnapshotDiffInput = InputShape.superRefine((i, c) => {
  for (const message of inputIssues(i)) c.addIssue({ code: "custom", message });
});
export type SnapshotDiffInput = z.infer<typeof SnapshotDiffInput>;
export const SnapshotUncertaintyCode = z.enum([
  "SNAPSHOT_INCOMPLETE",
  "FETCH_UNAVAILABLE",
  "PARSE_UNAVAILABLE",
  "SOURCE_QUALITY_UNCERTAIN",
  "FORMAT_CHANGED",
  "PARSE_CHANGED",
  "AMBIGUOUS_RENAME",
]);
export const SnapshotFileChange = z
  .object({
    kind: z.enum([
      "unchanged",
      "added",
      "removed",
      "modified",
      "renamed",
      "uncertain",
    ]),
    old: SnapshotFileEntry.nullable(),
    new: SnapshotFileEntry.nullable(),
    reasonCode: SnapshotUncertaintyCode.nullable(),
    reason: z.string().trim().min(1).max(1000).nullable(),
    spanReport: SourceChangeReport.nullable(),
  })
  .strict();
export type SnapshotFileChange = z.infer<typeof SnapshotFileChange>;
export const SnapshotDiffReport = z
  .object({
    oldSnapshotId: EntityId,
    newSnapshotId: EntityId,
    fileChanges: z.array(SnapshotFileChange).max(SNAPSHOT_MAX_FILES * 2),
    complete: z.boolean(),
    requiresHumanReview: z.literal(true),
    coverage: z
      .object({
        oldFiles: z.number().int().min(0).max(SNAPSHOT_MAX_FILES),
        newFiles: z.number().int().min(0).max(SNAPSHOT_MAX_FILES),
        oldCovered: z.number().int().min(0).max(SNAPSHOT_MAX_FILES),
        newCovered: z.number().int().min(0).max(SNAPSHOT_MAX_FILES),
      })
      .strict(),
  })
  .strict();
export type SnapshotDiffReport = z.infer<typeof SnapshotDiffReport>;
type Code = z.infer<typeof SnapshotUncertaintyCode>;
function issue(e: SnapshotFileEntry, bundles: Input["bundles"]): Code | null {
  if (e.fetchStatus !== "OK") return "FETCH_UNAVAILABLE";
  const b = e.documentVersionId ? bundles[e.documentVersionId] : undefined;
  if (!b || !["PARSED", "NEEDS_OCR"].includes(e.parseStatus ?? ""))
    return "PARSE_UNAVAILABLE";
  if (
    b.parseStatus !== "PARSED" ||
    b.spans.length === 0 ||
    b.spans.some((s) => s.extractionQuality !== "GOOD")
  )
    return "SOURCE_QUALITY_UNCERTAIN";
  return null;
}
const parsedKey = (b: z.infer<typeof ParsedDocumentBundle>) =>
  canonicalStringify({
    format: b.format,
    parserVersion: b.parserVersion,
    blocks: b.blocks.map(({ id, ...x }) => x),
    spans: b.spans.map(({ id, documentVersionId, ...x }) => x),
  });
// Python/JS share code-point order, including astral Unicode paths.
function cmp(a: string, b: string) {
  const x = Array.from(a),
    y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
}
const key = (a: SnapshotFileEntry | null, b: SnapshotFileEntry | null) =>
  JSON.stringify([a?.path ?? null, b?.path ?? null]);
/** Joint authority check: match EVERY result to frozen input, including fragment evidence. */
export function validateSnapshotDiff(input: unknown, report: unknown) {
  const parsed = SnapshotDiffInput.safeParse(input),
    out = SnapshotDiffReport.safeParse(report);
  if (!parsed.success || !out.success)
    return { ok: false, problems: ["快照输入或报告结构/元数据无效"] };
  const i = parsed.data,
    r = out.data,
    problems: string[] = [];
  const old = new Map(i.oldSnapshot.entries.map((e) => [e.path, e])),
    next = new Map(i.newSnapshot.entries.map((e) => [e.path, e]));
  const expected = new Map<
    string,
    {
      a: SnapshotFileEntry | null;
      b: SnapshotFileEntry | null;
      kind: SnapshotFileChange["kind"];
      code: Code | null;
    }
  >();
  const add = (
    a: SnapshotFileEntry | null,
    b: SnapshotFileEntry | null,
    forced?: Code,
  ) => {
    let code: Code | null = forced ?? null;
    let kind: SnapshotFileChange["kind"] = "uncertain";
    if (!code) {
      if (
        (!a && i.oldSnapshot.enumerationStatus !== "COMPLETE") ||
        (!b && i.newSnapshot.enumerationStatus !== "COMPLETE")
      )
        code = "SNAPSHOT_INCOMPLETE";
      else
        code =
          (a ? issue(a, i.bundles) : null) || (b ? issue(b, i.bundles) : null);
    }
    if (!code && a && b) {
      if (a.format !== b.format) code = "FORMAT_CHANGED";
      else if (a.checksum === b.checksum) {
        if (
          parsedKey(i.bundles[a.documentVersionId!]!) !==
          parsedKey(i.bundles[b.documentVersionId!]!)
        )
          code = "PARSE_CHANGED";
        else kind = a.path === b.path ? "unchanged" : "renamed";
      } else kind = "modified";
    } else if (!code) kind = a ? "removed" : "added";
    expected.set(key(a, b), { a, b, kind: code ? "uncertain" : kind, code });
  };
  for (const [p, a] of old) {
    const b = next.get(p);
    if (b) {
      add(a, b);
      old.delete(p);
      next.delete(p);
    }
  }
  const hashes = (m: Map<string, SnapshotFileEntry>) => {
    const result = new Map<string, SnapshotFileEntry[]>();
    for (const e of m.values())
      if (e.fetchStatus === "OK" && e.checksum) {
        result.set(e.checksum, [...(result.get(e.checksum) ?? []), e]);
      }
    return result;
  };
  const oh = hashes(old),
    nh = hashes(next);
  for (const [h, aa] of oh) {
    const bb = nh.get(h);
    if (!bb) continue;
    if (aa.length === 1 && bb.length === 1) {
      add(aa[0]!, bb[0]!);
      old.delete(aa[0]!.path);
      next.delete(bb[0]!.path);
    } else {
      for (const a of aa) {
        add(a, null, "AMBIGUOUS_RENAME");
        old.delete(a.path);
      }
      for (const b of bb) {
        add(null, b, "AMBIGUOUS_RENAME");
        next.delete(b.path);
      }
    }
  }
  for (const a of old.values()) add(a, null);
  for (const b of next.values()) add(null, b);
  const used = new Set<string>();
  for (const c of r.fileChanges) {
    const k = key(c.old, c.new),
      e = expected.get(k);
    if (!e || used.has(k)) {
      problems.push("文件对应关系伪造、遗漏或重复");
      continue;
    }
    used.add(k);
    if (
      canonicalStringify(c.old) !== canonicalStringify(e.a) ||
      canonicalStringify(c.new) !== canonicalStringify(e.b)
    )
      problems.push("文件元数据被篡改");
    if (
      c.kind !== e.kind ||
      c.reasonCode !== e.code ||
      Boolean(c.reason) !== Boolean(e.code)
    )
      problems.push("文件结论或不确定原因不符合输入");
    if (e.kind === "modified") {
      if (!c.spanReport) problems.push("修改缺少真实片段报告");
      else {
        const check = validateSourceComparison(
          {
            path: e.a!.path,
            oldBundle: i.bundles[e.a!.documentVersionId!]!,
            newBundle: i.bundles[e.b!.documentVersionId!]!,
          },
          c.spanReport,
        );
        problems.push(...check.problems);
      }
    } else if (c.spanReport) problems.push("非修改项不得附无关片段报告");
  }
  if (used.size !== expected.size) problems.push("报告遗漏输入文件");
  const complete =
    i.oldSnapshot.enumerationStatus === "COMPLETE" &&
    i.newSnapshot.enumerationStatus === "COMPLETE" &&
    [...expected.values()].every((e) => e.kind !== "uncertain");
  if (
    r.complete !== complete ||
    r.oldSnapshotId !== i.oldSnapshot.snapshotId ||
    r.newSnapshotId !== i.newSnapshot.snapshotId
  )
    problems.push("报告完整性或快照标识错误");
  if (
    canonicalStringify(r.coverage) !==
    canonicalStringify({
      oldFiles: i.oldSnapshot.entries.length,
      newFiles: i.newSnapshot.entries.length,
      oldCovered: i.oldSnapshot.entries.length,
      newCovered: i.newSnapshot.entries.length,
    })
  )
    problems.push("覆盖计数与冻结输入不一致");
  const sorted = [...r.fileChanges].sort(
    (a, b) =>
      cmp(a.old?.path ?? a.new?.path ?? "", b.old?.path ?? b.new?.path ?? "") ||
      cmp(a.new?.path ?? "", b.new?.path ?? ""),
  );
  if (canonicalStringify(sorted) !== canonicalStringify(r.fileChanges))
    problems.push("报告顺序不稳定");
  return { ok: problems.length === 0, problems };
}
