import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import {
  WorkflowRunRequest,
  WorkflowBudget,
} from '@ai-qa/contracts';
import { requireAuth, requireProjectAccess } from './auth.js';
import { ApiError } from './errors.js';

/**
 * P0-3 持久化任务编排 API。
 *
 * - POST /api/projects/:id/workflows        → 202 创建工作流运行
 * - GET  /api/projects/:id/workflows        → 列表
 * - GET  /api/workflows/:id                 → 详情（含节点）
 * - POST /api/workflows/:id/cancel          → 取消
 * - POST /api/workflows/:id/nodes/:nodeKey/confirm → 人工确认（批准门）
 * - GET  /api/workflows/:id/events          → SSE（Last-Event-ID 续传）
 */

export function registerWorkflowRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const param = (req: FastifyRequest, key: string) =>
    z.record(z.string()).parse(req.params)[key]!;

  function inputHash(inputs: unknown): string {
    return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
  }

  async function findWorkflow(req: FastifyRequest, id: string) {
    const wf = await prisma.workflowRun.findUnique({
      where: { id },
      include: { nodes: { orderBy: { seq: 'asc' } } },
    });
    if (!wf) throw new ApiError('NOT_FOUND', '工作流不存在');
    await requireProjectAccess(prisma, req, wf.projectId);
    return wf;
  }

  async function emitEvent(prisma: PrismaClient, workflowId: string, type: string, payload: Record<string, unknown>) {
    await prisma.$queryRaw`UPDATE "WorkflowRun" SET "updatedAt" = now() WHERE "id" = ${workflowId}`;
    const [row] = await prisma.$queryRaw<Array<{ seq: number }>>`
      SELECT COALESCE(MAX("seq"), 0) + 1 AS seq FROM "WorkflowEvent" WHERE "workflowId" = ${workflowId} FOR UPDATE
    `;
    await prisma.workflowEvent.create({
      data: { workflowId, seq: row!.seq, type, payload: payload as never },
    });
  }

  // ---------- 创建 ----------

  app.post('/api/projects/:id/workflows', async (req, reply) => {
    const projectId = param(req, 'id');
    await requireProjectAccess(prisma, req, projectId, 'LEAD');
    const body = WorkflowRunRequest.parse(req.body);

    if (!body.inputs.environmentId) throw new ApiError('VALIDATION_ERROR', '必须指定环境');
    const env = await prisma.environment.findFirst({
      where: { id: body.inputs.environmentId, projectId, isProduction: false },
    });
    if (!env) throw new ApiError('VALIDATION_ERROR', '环境不存在或不属于该项目');

    const wf = await prisma.workflowRun.create({
      data: {
        projectId,
        missionId: body.missionId ?? null,
        templateVersion: body.templateVersion,
        inputs: body.inputs as never,
        budget: body.budget as never,
        status: 'QUEUED',
      },
    });
    await emitEvent(prisma, wf.id, 'workflow.created', { workflowId: wf.id });
    reply.code(202);
    return { workflowId: wf.id };
  });

  // ---------- 列表/详情 ----------

  app.get('/api/projects/:id/workflows', async req => {
    const projectId = param(req, 'id');
    await requireProjectAccess(prisma, req, projectId);
    const workflows = await prisma.workflowRun.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, status: true, templateVersion: true, currentGate: true, createdAt: true, updatedAt: true },
    });
    return { workflows };
  });

  app.get('/api/workflows/:id', async req => {
    const wf = await findWorkflow(req, param(req, 'id'));
    return {
      id: wf.id,
      status: wf.status,
      templateVersion: wf.templateVersion,
      currentGate: wf.currentGate,
      budget: wf.budget,
      inputs: wf.inputs,
      nodes: wf.nodes.map(n => ({
        id: n.id,
        nodeKey: n.nodeKey,
        seq: n.seq,
        status: n.status,
        humanTodo: n.humanTodo,
        error: n.error,
        startedAt: n.startedAt,
        finishedAt: n.finishedAt,
      })),
      createdAt: wf.createdAt,
      updatedAt: wf.updatedAt,
    };
  });

  // ---------- 取消 ----------

  app.post('/api/workflows/:id/cancel', async req => {
    const wf = await findWorkflow(req, param(req, 'id'));
    const changed = await prisma.workflowRun.updateMany({
      where: { id: wf.id, status: { in: ['QUEUED', 'RUNNING', 'WAITING_HUMAN'] } },
      data: { status: 'CANCELLED', cancelRequestedAt: new Date() },
    });
    if (!changed.count) {
      return { workflowId: wf.id, status: wf.status, note: '已终态，幂等' };
    }
    await emitEvent(prisma, wf.id, 'workflow.cancelled', { workflowId: wf.id });
    return { workflowId: wf.id, status: 'CANCELLED' };
  });

  // ---------- 人工确认（批准门） ----------

  app.post('/api/workflows/:id/nodes/:nodeKey/confirm', async req => {
    const wf = await findWorkflow(req, param(req, 'id'));
    const nodeKey = param(req, 'nodeKey');
    const body = z.object({
      decision: z.enum(['approve', 'reject']),
      note: z.string().max(1000).optional(),
    }).strict().parse(req.body);

    const node = wf.nodes.find(n => n.nodeKey === nodeKey);
    if (!node) throw new ApiError('NOT_FOUND', `节点 ${nodeKey} 不存在`);
    if (node.status !== 'waiting_human') throw new ApiError('CONFLICT', `节点状态为 ${node.status}，仅在等待人工确认时可操作`);

    // CAS 确保不重复。
    const changed = await prisma.workflowNode.updateMany({
      where: { id: node.id, status: 'waiting_human' },
      data: {
        status: body.decision === 'approve' ? 'completed' : 'failed',
        finishedAt: new Date(),
        humanTodo: { cleared: true } as never,
        error: body.decision === 'reject' ? (body.note ?? '人工拒绝') : null,
      },
    });
    if (!changed.count) throw new ApiError('CONFLICT', '节点已被处理');

    await emitEvent(prisma, wf.id, 'workflow.resumed', {
      nodeKey,
      decision: body.decision,
      note: body.note,
    });

    // 如果整个工作流在等这个节点，恢复运行。
    if (wf.status === 'WAITING_HUMAN') {
      const remaining = await prisma.workflowNode.count({
        where: { workflowId: wf.id, status: 'waiting_human' },
      });
      if (remaining === 0) {
        await prisma.workflowRun.update({
          where: { id: wf.id },
          data: { status: 'RUNNING', currentGate: null },
        });
      }
    }
    return { nodeKey, status: body.decision === 'approve' ? 'completed' : 'failed' };
  });

  // ---------- SSE 事件流 ----------

  app.get('/api/workflows/:id/events', async (req, reply) => {
    const wf = await findWorkflow(req, param(req, 'id'));
    const lastEventHeader = req.headers['last-event-id'];
    const lastEventQuery = (req.query as { lastEventId?: string }).lastEventId;
    let cursor = 0;
    const raw = Array.isArray(lastEventHeader) ? lastEventHeader[0] : lastEventHeader;
    const rawSeq = raw ?? lastEventQuery;
    if (rawSeq && /^\d+$/.test(rawSeq)) cursor = Number(rawSeq);

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    const write = (chunk: string) => reply.raw.write(chunk);
    write(': connected\n\n');

    let closed = false;
    req.raw.on('close', () => { closed = true; });

    const poll = async () => {
      while (!closed) {
        const events = await prisma.workflowEvent.findMany({
          where: { workflowId: wf.id, seq: { gt: cursor } },
          orderBy: { seq: 'asc' },
          take: 200,
        });
        for (const event of events) {
          cursor = event.seq;
          write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify({
            seq: event.seq,
            type: event.type,
            payload: event.payload,
          })}\n\n`);
        }
        const current = await prisma.workflowRun.findUnique({
          where: { id: wf.id },
          select: { status: true },
        });
        const terminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(current?.status ?? '');
        if (terminal && events.length === 0) {
          write(`event: stream.end\ndata: ${JSON.stringify({ status: current?.status })}\n\n`);
          break;
        }
        await new Promise(r => setTimeout(r, 400));
      }
      if (!closed) reply.raw.end();
    };
    void poll().catch(err => req.log.error({ err }, 'SSE 轮询失败'));
    return reply;
  });
}
