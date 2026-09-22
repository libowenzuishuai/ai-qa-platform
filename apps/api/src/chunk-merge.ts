import {
  RuleExtractionOutput,
  type RuleDraft,
  type RuleExtractionInput,
} from "@ai-qa/contracts";

/**
 * R03 分层有界合并（确定性，纯函数）：
 * - 去重：规范化签名（statement/action/condition/expectation/role/precondition）
 *   完全一致的草稿合并为一条，来源 span 并集保留（原始 span ID 不变）；
 * - 不合并条件不同的规则：statement 相同但其余字段不同的成对草稿保留两条，
 *   并以 conflictsWith 双向引用（重编号后的新 key）；
 * - UNPARSED/LOW 约束沿用：来源质量不在此处改写（批准流程负责约束）；
 * - clarifications 去重合并；unparsedRanges 按块拼接；
 * - 输出按确定性顺序重编号（rule-draft-NN），同一输入必然同一输出。
 */

export interface ChunkExtractionResult {
  chunkId: string;
  seq: number;
  output: RuleExtractionOutput;
}

interface DraftIdentity {
  statement: string;
  action: string;
  condition: string | null;
  expectation: string;
  role: string | null;
  precondition: string | null;
}

function identity(draft: RuleDraft): DraftIdentity {
  return {
    statement: draft.statement.trim(),
    action: draft.action.trim(),
    condition: draft.condition?.trim() ?? null,
    expectation: draft.expectation.trim(),
    role: draft.role?.trim() ?? null,
    precondition: draft.precondition?.trim() ?? null,
  };
}

function sameIdentity(a: DraftIdentity, b: DraftIdentity): boolean {
  return (
    a.statement === b.statement &&
    a.action === b.action &&
    a.condition === b.condition &&
    a.expectation === b.expectation &&
    a.role === b.role &&
    a.precondition === b.precondition
  );
}

function sameStatement(a: DraftIdentity, b: DraftIdentity): boolean {
  return a.statement === b.statement;
}

function mergeSources(drafts: RuleDraft[]) {
  const byDocument = new Map<string, Set<string>>();
  for (const draft of drafts) {
    for (const source of draft.sources) {
      const set = byDocument.get(source.documentVersionId) ?? new Set<string>();
      for (const spanId of source.sourceSpanIds) set.add(spanId);
      byDocument.set(source.documentVersionId, set);
    }
  }
  return [...byDocument.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([documentVersionId, spanIds]) => ({
      documentVersionId,
      sourceSpanIds: [...spanIds].sort(),
    }));
}

export function mergeChunkExtractions(results: ChunkExtractionResult[]): RuleExtractionOutput {
  if (!results.length) return { ruleDrafts: [], clarifications: [], unparsedRanges: [] };
  // 按清单顺序处理（seq 升序），保证确定性。
  const ordered = [...results].sort((a, b) => a.seq - b.seq);

  // 1) 收集全部草稿（携带块序号）。
  const collected: Array<{ seq: number; draft: RuleDraft }> = [];
  for (const result of ordered) {
    for (const draft of result.output.ruleDrafts) collected.push({ seq: result.seq, draft });
  }

  // 2) 规范化签名分组：完全一致 → 合并；仅 statement 一致 → 冲突对。
  const groups: Array<{ seq: number; drafts: RuleDraft[] }> = [];
  for (const item of collected) {
    const target = groups.find((group) =>
      sameIdentity(identity(group.drafts[0]!), identity(item.draft)),
    );
    if (target) {
      // 合并候选还要求块内不重复引用（跨块去重，块内同名不同条件各自成组）。
      target.drafts.push(item.draft);
    } else {
      groups.push({ seq: item.seq, drafts: [item.draft] });
    }
  }

  // 3) 稳定排序：首个出现位置（seq + 组内序）。
  const firstSeen = new Map<RuleDraft, number>();
  let counter = 0;
  for (const item of collected) firstSeen.set(item.draft, counter++);
  groups.sort((a, b) => firstSeen.get(a.drafts[0]!)! - firstSeen.get(b.drafts[0]!)!);

  // 4) 重编号并构建输出草稿（记录组索引用于冲突引用）。
  const mergedDrafts: Array<{ groupIndex: number; draft: RuleDraft }> = groups.map(
    (group, groupIndex) => ({
      groupIndex,
      draft: {
        ...group.drafts[0]!,
        sources: mergeSources(group.drafts),
        conflictsWith: [], // 稍后按新编号回填
      },
    }),
  );

  // 5) 冲突双向引用：statement 一致但整体签名不同的组。
  for (let i = 0; i < mergedDrafts.length; i += 1) {
    for (let j = i + 1; j < mergedDrafts.length; j += 1) {
      const a = mergedDrafts[i]!, b = mergedDrafts[j]!;
      if (
        sameStatement(identity(a.draft), identity(b.draft)) &&
        !sameIdentity(identity(a.draft), identity(b.draft))
      ) {
        a.draft.conflictsWith.push(`rule-draft-${String(j + 1).padStart(2, "0")}`);
        b.draft.conflictsWith.push(`rule-draft-${String(i + 1).padStart(2, "0")}`);
      }
    }
  }

  const ruleDrafts = mergedDrafts.map((entry, index) => ({
    ...entry.draft,
    key: `rule-draft-${String(index + 1).padStart(2, "0")}`,
    conflictsWith: [...new Set(entry.draft.conflictsWith)].sort(),
  }));

  // 6) clarifications 去重（按引用集合与问题文本）；unparsedRanges 拼接。
  const clarifications: RuleExtractionOutput["clarifications"] = [];
  for (const result of ordered) {
    for (const clarification of result.output.clarifications) {
      const normalized = {
        keys: [...clarification.ruleDraftKeys].sort(),
        question: clarification.question.trim(),
      };
      const exists = clarifications.some((existing) => {
        const candidate = {
          keys: [...existing.ruleDraftKeys].sort(),
          question: existing.question.trim(),
        };
        return (
          candidate.keys.length === normalized.keys.length &&
          candidate.keys.every((k, idx) => k === normalized.keys[idx]) &&
          candidate.question === normalized.question
        );
      });
      if (!exists) clarifications.push(clarification);
    }
  }
  const unparsedRanges = ordered.flatMap((result) => result.output.unparsedRanges);

  const merged = { ruleDrafts, clarifications, unparsedRanges };
  // 输出必须仍符合提取契约（含 draft key 唯一性等约束）。
  return RuleExtractionOutput.parse(merged);
}

/** 覆盖对账：清单内全部块必须都有明确状态；部分完成只可审阅不可合并。 */
export function chunkCoverage(
  manifestChunks: Array<{ chunkId: string; seq: number }>,
  rows: Array<{ chunkId: string; status: string }>,
): {
  complete: boolean;
  processed: string[];
  pending: string[];
  failed: string[];
  inProgress: string[];
  cancelled: string[];
  missing: string[];
} {
  const byId = new Map(rows.map((row) => [row.chunkId, row.status]));
  const state = {
    complete: true,
    processed: [] as string[],
    pending: [] as string[],
    failed: [] as string[],
    inProgress: [] as string[],
    cancelled: [] as string[],
    missing: [] as string[],
  };
  for (const chunk of manifestChunks) {
    const status = byId.get(chunk.chunkId);
    if (status === undefined) {
      state.missing.push(chunk.chunkId);
      state.complete = false;
    } else if (status === "completed") state.processed.push(chunk.chunkId);
    else if (status === "pending") {
      state.pending.push(chunk.chunkId);
      state.complete = false;
    } else if (status === "in_progress") {
      state.inProgress.push(chunk.chunkId);
      state.complete = false;
    } else if (status === "failed") {
      state.failed.push(chunk.chunkId);
      state.complete = false;
    } else if (status === "cancelled") {
      state.cancelled.push(chunk.chunkId);
      state.complete = false;
    }
  }
  return state;
}
