import { describe, expect, it } from 'vitest';
import {
  ChunkManifest,
  ChunkCoverageReport,
  DocumentChunk,
  CapabilityVersion,
  WorkflowTemplateVersion,
  TemplateNodeDefinition,
  ReleaseDecision,
  ReleaseDecisionKind,
  GoalProposal,
  MemoryRecord,
  DiagnosisEntry,
} from '../src/index.js';

const id = (n: number) => `id-${n.toString().padStart(4, '0')}`;
const iso = '2026-09-21T00:00:00Z';

describe('R00 分块契约', () => {
  const chunk = (seq: number, over = ''): DocumentChunk => ({
    chunkId: id(100 + seq),
    seq,
    boundary: 'paragraph',
    text: `块 ${seq}`,
    contextOverlap: over,
    spanRefs: [{ type: 'span', spanId: id(seq) }],
    isTableContinuation: false,
    estimatedChars: 3,
  });

  it('合法 manifest 通过；序号不连续拒绝', () => {
    const ok = ChunkManifest.safeParse({
      documentVersionId: id(1), strategyVersion: 'chunk-v1', documentChecksum: 'sha256:x',
      strategyParams: { maxCharsPerChunk: 2000, contextOverlapChars: 200, modelBudgetChars: 8000 },
      chunks: [chunk(0), chunk(1, '重叠'), chunk(2, '重叠')],
      totalCodePoints: 9, createdAt: iso,
    });
    expect(ok.success).toBe(true);

    const bad = ChunkManifest.safeParse({
      documentVersionId: id(1), strategyVersion: 'chunk-v1', documentChecksum: 'sha256:x',
      strategyParams: { maxCharsPerChunk: 2000, contextOverlapChars: 200, modelBudgetChars: 8000 },
      chunks: [chunk(0), chunk(2)],
      totalCodePoints: 6, createdAt: iso,
    });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error!.issues)).toContain('连续');
  });

  it('span 切片保留原 span 引用与偏移', () => {
    const c = DocumentChunk.parse({
      chunkId: id(9), seq: 0, boundary: 'fixed-size', text: '长段落切片',
      spanRefs: [{ type: 'slice', slice: { sourceSpanId: id(1), startOffset: 0, endOffset: 500, sliceId: 's-0' } }],
      estimatedChars: 5,
    });
    expect(c.spanRefs[0]).toEqual({
      type: 'slice',
      slice: { sourceSpanId: id(1), startOffset: 0, endOffset: 500, sliceId: 's-0' },
    });
  });

  it('覆盖对账：三类归属之和必须等于总数', () => {
    const base = {
      documentVersionId: id(1), chunkManifestChecksum: 'sha256:y',
      assignments: [
        { fragmentId: 'f1', assignment: 'processed', chunkId: id(100) },
        { fragmentId: 'f2', assignment: 'context', chunkId: id(100) },
        { fragmentId: 'f3', assignment: 'blocked', chunkId: null, reason: '表格截断' },
      ],
    };
    expect(ChunkCoverageReport.safeParse({ ...base, totalFragments: 3, processedFragments: 1, contextFragments: 1, blockedFragments: 1 }).success).toBe(true);
    const bad = ChunkCoverageReport.safeParse({ ...base, totalFragments: 3, processedFragments: 2, contextFragments: 1, blockedFragments: 1 });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error!.issues)).toContain('对账失败');
  });
});

describe('R00 能力与模板契约', () => {
  const capability = CapabilityVersion.parse({
    id: id(1), key: 'doc-parse', version: 1, name: '解析',
    inputSchema: {}, outputSchema: {}, effects: ['READ'],
    requiredRoles: [], requiresEnvironment: false, budgetCategory: 'none',
    idempotencyStrategy: 'idempotent', recoveryStrategy: 'read_only',
    enabled: true, createdBy: 'u1', createdAt: iso,
  });
  expect(capability.key).toBe('doc-parse');

  const template = (nodes: unknown[]) => ({
    id: id(2), key: 'release-acceptance', version: 1, name: '发布验收',
    nodes, defaultBudget: {}, defaultParallelism: 1,
    status: 'DRAFT', createdBy: 'u1', createdAt: iso, publishedAt: null,
  });
  const node = (key: string, dependsOn: string[] = []): TemplateNodeDefinition => ({
    key, capabilityKey: 'doc-parse', capabilityVersion: 1, dependsOn,
    isApprovalGate: false, inputMapping: {},
  });

  it('合法 DAG 通过；环/悬空依赖拒绝', () => {
    expect(WorkflowTemplateVersion.safeParse(template([node('a'), node('b', ['a'])])).success).toBe(true);
    const cycle = WorkflowTemplateVersion.safeParse(template([node('a', ['b']), node('b', ['a'])]));
    expect(cycle.success).toBe(false);
    expect(JSON.stringify(cycle.error!.issues)).toContain('环');
    const dangling = WorkflowTemplateVersion.safeParse(template([node('a', ['ghost'])]));
    expect(dangling.success).toBe(false);
    expect(JSON.stringify(dangling.error!.issues)).toContain('ghost');
  });

  it('节点数超过 64 拒绝；并行度超过 2 拒绝', () => {
    expect(WorkflowTemplateVersion.safeParse(template(Array.from({ length: 65 }, (_, i) => node(`n${i}`)))).success).toBe(false);
    expect(WorkflowTemplateVersion.safeParse({ ...template([node('a')]), defaultParallelism: 3 }).success).toBe(false);
  });
});

describe('R00 发布决策与目标规划契约', () => {
  it('ACCEPT_WITH_RISK 必须说明风险', () => {
    const base = {
      id: id(1), projectId: id(2), runIds: [id(3)], decidedBy: 'u1',
      decidedAt: iso, evidenceSnapshot: {},
    };
    expect(ReleaseDecision.safeParse({ ...base, decision: 'ACCEPT', reason: '通过' }).success).toBe(true);
    const risky = ReleaseDecision.safeParse({ ...base, decision: 'ACCEPT_WITH_RISK', reason: '一切正常' });
    expect(risky.success).toBe(false);
    expect(ReleaseDecision.safeParse({ ...base, decision: 'ACCEPT_WITH_RISK', reason: '存在风险：次要缺陷' }).success).toBe(true);
    expect(ReleaseDecisionKind.options).toEqual(['ACCEPT', 'REJECT', 'ACCEPT_WITH_RISK']);
  });

  it('GoalProposal 带默认值与 blocker 分类', () => {
    const p = GoalProposal.parse({
      id: id(1), projectId: id(2), goal: '验证发布',
      suggestedTools: [{ capabilityKey: 'doc-parse', reason: '解析' }],
      createdBy: 'u1', createdAt: iso,
    });
    expect(p.suggestedScope).toEqual({ documentVersionIds: [] });
    expect(p.blockers).toEqual([]);
    expect(p.status).toBe('DRAFT');
    expect(p.reviewedBy).toBeNull();
  });

  it('MemoryRecord 失效触发与 DiagnosisEntry 事实/假设/建议结构', () => {
    const m = MemoryRecord.parse({
      id: id(1), projectId: id(2), content: '登录页 /login',
      source: { kind: 'observation', referenceId: id(3) },
      invalidationTriggers: [{ kind: 'document_change', condition: 'PRD 变更' }],
      createdAt: iso,
    });
    expect(m.context).toEqual({});
    expect(m.invalidated).toBe(false);

    const d = DiagnosisEntry.parse({
      id: id(4), projectId: id(2), category: 'PRODUCT_FAILURE',
      facts: [{ text: '实际值不符', evidenceId: id(5) }],
      hypotheses: [{ text: '环境差异', basis: '仅测试环境' }],
      suggestions: [{ text: '复测', riskNote: '不稳定' }],
      confidence: 'high', createdBy: 'u1', createdAt: iso,
    });
    expect(d.hypotheses[0]!.basis).toBe('仅测试环境');
    expect(DiagnosisEntry.safeParse({ ...d, category: 'NOT_A_CATEGORY' }).success).toBe(false);
  });
});
