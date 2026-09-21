import type { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';

/**
 * P0-3 工作流编排引擎。
 *
 * 首版模板 v1 显式图（按序执行）：
 *   document_parse → rule_suggest → rule_approval_gate → case_suggest →
 *   case_approval_gate → page_observation → plan_proposal_gate →
 *   preparation_check → execution → evaluation
 *
 * - 已完成节点按结果引用续跑，不从头重放。
 * - 人工门（*_approval_gate）暂停工作流等人确认。
 * - 节点幂等键 = (workflowId, nodeKey, inputHash)。
 * - 只读操作有限重试；写入结果不确定进入 unknown。
 */

type PrismaTx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/** 模板 v1 节点定义。 */
const TEMPLATE_V1: Array<{ key: string; effect: 'READ' | 'WRITE'; gate: boolean }> = [
  { key: 'document_parse', effect: 'READ', gate: false },
  { key: 'rule_suggest', effect: 'READ', gate: false },
  { key: 'rule_approval_gate', effect: 'READ', gate: true },
  { key: 'case_suggest', effect: 'READ', gate: false },
  { key: 'case_approval_gate', effect: 'READ', gate: true },
  { key: 'page_observation', effect: 'WRITE', gate: false },
  { key: 'plan_proposal_gate', effect: 'READ', gate: true },
  { key: 'preparation_check', effect: 'READ', gate: false },
  { key: 'execution', effect: 'WRITE', gate: false },
  { key: 'evaluation', effect: 'READ', gate: false },
];

function inputHash(inputs: unknown): string {
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}

async function emitNodeEvent(prisma: PrismaClient, workflowId: string, type: string, payload: Record<string, unknown>) {
  const [row] = await prisma.$queryRaw<Array<{ seq: number }>>`
    SELECT COALESCE(MAX("seq"), 0) + 1 AS seq FROM "WorkflowEvent" WHERE "workflowId" = ${workflowId}
  `;
  await prisma.workflowEvent.create({
    data: { workflowId, seq: row!.seq, type, payload: payload as never },
  });
}

/**
 * 恢复/推进工作流。
 * 幂等：只处理 QUEUED→RUNNING / WAITING_HUMAN 恢复；已完成节点跳过。
 */
export async function advanceWorkflow(prisma: PrismaClient, workflowId: string): Promise<void> {
  // CAS 认领。
  const claimed = await prisma.workflowRun.updateMany({
    where: { id: workflowId, status: 'QUEUED' },
    data: { status: 'RUNNING' },
  });

  const wf = await prisma.workflowRun.findUniqueOrThrow({
    where: { id: workflowId },
    include: { nodes: { orderBy: { seq: 'asc' } } },
  });

  // WAITING_HUMAN 状态的恢复由 confirm 端点处理，此处只推进。
  if (wf.status === 'COMPLETED' || wf.status === 'FAILED' || wf.status === 'CANCELLED') return;
  if (wf.status === 'WAITING_HUMAN') return;
  if (!claimed.count && wf.status === 'RUNNING') {
    // 已在运行中（可能是恢复/续跑），继续推进未完成节点。
  }

  const template = wf.templateVersion === 'v1' ? TEMPLATE_V1 : null;
  if (!template) throw new Error(`未知模板版本 ${wf.templateVersion}`);

  const inputs = wf.inputs as Record<string, unknown>;
  const hash = inputHash(inputs);

  // 确保所有节点已初始化。
  for (const [seq, nodeDef] of template.entries()) {
    const existing = wf.nodes.find(n => n.nodeKey === nodeDef.key);
    if (!existing) {
      await prisma.workflowNode.create({
        data: {
          workflowId,
          nodeKey: nodeDef.key,
          seq: seq + 1,
          status: 'queued',
          idempotencyKey: `${workflowId}:${nodeDef.key}:${hash}`,
          inputHash: hash,
        },
      });
    }
  }

  // 重新读取节点。
  const nodes = await prisma.workflowNode.findMany({
    where: { workflowId },
    orderBy: { seq: 'asc' },
  });

  for (const node of nodes) {
    if (node.status === 'completed' || node.status === 'skipped') continue;

    if (node.status === 'failed') {
      await prisma.workflowRun.update({
        where: { id: workflowId },
        data: { status: 'FAILED', currentGate: node.nodeKey },
      });
      await emitNodeEvent(prisma, workflowId, 'workflow.failed', { nodeKey: node.nodeKey });
      return;
    }

    // CAS 认领节点。
    const claimedNode = await prisma.workflowNode.updateMany({
      where: { id: node.id, status: 'queued' },
      data: { status: 'running', startedAt: new Date() },
    });
    if (!claimedNode.count && node.status !== 'running') continue;

    await emitNodeEvent(prisma, workflowId, 'workflow.node_started', { nodeKey: node.nodeKey });

    const nodeDef = template.find(t => t.key === node.nodeKey)!;

    if (nodeDef.gate) {
      // 人工门：设为 waiting_human，暂停工作流。
      await prisma.workflowNode.update({
        where: { id: node.id },
        data: {
          status: 'waiting_human',
          humanTodo: {
            description: `${node.nodeKey} 需要人工确认`,
            nodeKey: node.nodeKey,
          } as never,
        },
      });
      await prisma.workflowRun.update({
        where: { id: workflowId },
        data: { status: 'WAITING_HUMAN', currentGate: node.nodeKey },
      });
      await emitNodeEvent(prisma, workflowId, 'workflow.waiting_human', { nodeKey: node.nodeKey });
      return; // 暂停，等人确认。
    }

    // 非门节点：模拟执行（首版骨架——后续接入已有能力）。
    try {
      const output = await executeNode(prisma, workflowId, node.nodeKey, inputs);
      await prisma.workflowNode.update({
        where: { id: node.id },
        data: {
          status: 'completed',
          finishedAt: new Date(),
          outputRef: output as never,
        },
      });
      await emitNodeEvent(prisma, workflowId, 'workflow.node_completed', {
        nodeKey: node.nodeKey,
        output,
      });
    } catch (err) {
      await prisma.workflowNode.update({
        where: { id: node.id },
        data: { status: 'failed', error: String(err).slice(0, 500), finishedAt: new Date() },
      });
      await emitNodeEvent(prisma, workflowId, 'workflow.node_failed', { nodeKey: node.nodeKey, error: String(err).slice(0, 500) });
      await prisma.workflowRun.update({
        where: { id: workflowId },
        data: { status: 'FAILED' },
      });
      return;
    }
  }

  // 全部完成。
  await prisma.workflowRun.update({
    where: { id: workflowId },
    data: { status: 'COMPLETED', currentGate: null },
  });
  await emitNodeEvent(prisma, workflowId, 'workflow.completed', { workflowId });
}

/**
 * 执行单个节点（首版骨架：返回占位输出）。
 * 后续按 nodeKey 接入已有能力（文档解析/规则提取/观察/执行等）。
 */
async function executeNode(
  _prisma: PrismaClient,
  _workflowId: string,
  nodeKey: string,
  _inputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (nodeKey) {
    case 'document_parse':
      return { status: 'completed', note: '文档解析已就绪（待接入 DOCUMENT_PARSE 作业）' };
    case 'rule_suggest':
      return { status: 'completed', note: '规则建议已就绪（待接入 RULE_EXTRACTION 作业）' };
    case 'case_suggest':
      return { status: 'completed', note: '用例建议已就绪（待接入 CASE_GENERATION 作业）' };
    case 'page_observation':
      return { status: 'completed', note: '页面观察已就绪（待接入 WEB_OBSERVATION 作业）' };
    case 'preparation_check':
      return { status: 'completed', note: '准备检查已就绪（待接入 preparation-summary）' };
    case 'execution':
      return { status: 'completed', note: '执行已就绪（待接入 Run 创建）' };
    case 'evaluation':
      return { status: 'completed', note: '评估已就绪（待接入 buildRunReport）' };
    default:
      // 人工门节点不在此执行。
      return { status: 'completed', note: nodeKey };
  }
}
