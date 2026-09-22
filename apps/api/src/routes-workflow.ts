import { freezeExecutableTemplate } from './template-runtime.js';
import { requireAuth } from './auth.js';
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { configHash } from "./preparation-service.js";
import { WorkflowRunRequest } from "@ai-qa/contracts";
import { emitWorkflowEvent, cancelWorkflowChildren } from "@ai-qa/run-events";
import { requireProjectAccess } from "./auth.js";
import { ApiError } from "./errors.js";
import { workflowGateAssets } from "./workflow-service.js";

export function registerWorkflowRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
) {
  const param = (req: FastifyRequest, key: string) =>
    z.record(z.string()).parse(req.params)[key]!;
  async function find(req: FastifyRequest, write = false) {
    const wf = await prisma.workflowRun.findUnique({
      where: { id: param(req, "id") },
      include: { nodes: { orderBy: { seq: "asc" } } },
    });
    if (!wf) throw new ApiError("NOT_FOUND", "工作流不存在");
    await requireProjectAccess(
      prisma,
      req,
      wf.projectId,
      write ? "LEAD" : "VIEWER",
    );
    return wf;
  }
  app.post("/api/projects/:id/workflows", async (req, reply) => {
    const projectId = param(req, "id");
    await requireProjectAccess(prisma, req, projectId, "LEAD");
    const body = WorkflowRunRequest.parse(req.body);
    if (!body.inputs.baselineId && !body.inputs.documentVersionIds.length && !body.inputs.codeCheck)
      throw new ApiError("VALIDATION_ERROR", "请选择验收基线或需求资料");
    if (body.inputs.baselineId && body.inputs.documentVersionIds.length)
      throw new ApiError(
        "VALIDATION_ERROR",
        "一次工作流只使用固定基线或需求资料其中一种入口",
      );
    if (
      new Set(body.inputs.documentVersionIds).size !==
      body.inputs.documentVersionIds.length
    )
      throw new ApiError("VALIDATION_ERROR", "资料版本不能重复");
    const fingerprint = configHash(body);
    if (!body.templateVersion && !body.templateId)
      throw new ApiError("VALIDATION_ERROR", "请指定内置模板（templateVersion v1）或已发布的能力目录模板（templateId）");
    const wf = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${projectId} FOR UPDATE`;
      const old = await tx.workflowRun.findUnique({
        where: {
          projectId_idempotencyKey: {
            projectId,
            idempotencyKey: body.idempotencyKey,
          },
        },
      });
      if (old) {
        if (old.inputFingerprint !== fingerprint)
          throw new ApiError("IDEMPOTENCY_CONFLICT", "相同幂等键对应不同请求");
        return old;
      }
      // R07：目录模板 → 冻结节点快照（运行固定引用该版本，后续发布 v2 不影响）。
      let templateNodes: unknown = null, templateCapabilities:unknown=null, templateParallelism=1;
      if (body.templateId) {
        const template = await tx.workflowTemplate.findFirst({
          where: { id: body.templateId, projectId, status: "PUBLISHED" },
        });
        if (!template)
          throw new ApiError("VALIDATION_ERROR", "模板不存在、未发布或不属于本项目");
        const compiled=await freezeExecutableTemplate(tx,projectId,template.nodes);
        templateNodes=compiled.nodes;templateCapabilities=compiled.capabilities;templateParallelism=template.defaultParallelism;
        if(body.inputs.codeCheck && compiled.nodes.some(n=>n.capabilityKey!=="code-check"))throw new ApiError("VALIDATION_ERROR","工程体检输入只能使用工程检查模板");
      }
      if(body.inputs.codeCheck && !body.templateId)throw new ApiError("VALIDATION_ERROR","请选择工程体检模板");
      const env = body.inputs.environmentId ? await tx.environment.findFirst({
        where: {
          id: body.inputs.environmentId,
          projectId,
          isProduction: false,
        },
      }):null;
      if (!env && !body.inputs.codeCheck) throw new ApiError("VALIDATION_ERROR", "环境不可用");
      if (
        body.missionId &&
        !(await tx.mission.findFirst({
          where: { id: body.missionId, projectId, environmentId: env?.id },
        }))
      )
        throw new ApiError("VALIDATION_ERROR", "任务不属于该项目和环境");
      if (
        (await tx.documentVersion.count({
          where: {
            id: { in: body.inputs.documentVersionIds },
            document: { projectId },
          },
        })) !== body.inputs.documentVersionIds.length
      )
        throw new ApiError("VALIDATION_ERROR", "资料不属于该项目");
      let frozen = {};
      if (body.inputs.baselineId) {
        const base = await tx.baseline.findFirst({
          where: { id: body.inputs.baselineId, projectId },
        });
        if (!base?.caseVersionIds.length)
          throw new ApiError("VALIDATION_ERROR", "基线不存在或没有用例");
        const cases = await tx.testCaseVersion.findMany({
          where: {
            id: { in: base.caseVersionIds },
            projectId,
            approvalStatus: "APPROVED",
          },
          include: { plans: { orderBy: { version: "desc" }, take: 1 } },
        });
        if (cases.length !== base.caseVersionIds.length)
          throw new ApiError("VALIDATION_ERROR", "基线用例尚未批准");
        frozen = {
          caseVersionIds: base.caseVersionIds,
          ruleVersionIds: [...new Set(cases.flatMap((c) => c.ruleVersionIds))],
          pinnedPlans: cases.flatMap((c) =>
            c.plans[0]
              ? [
                  {
                    caseVersionId: c.id,
                    planVersionId: c.plans[0].id,
                    acceptanceHash: c.plans[0].acceptanceHash,
                  },
                ]
              : [],
          ),
        };
      }
      const row = await tx.workflowRun.create({
        data: {
          projectId,
          missionId: body.missionId,
          templateVersion: body.templateVersion ?? `catalog:${body.templateId}`,
          templateId: body.templateId ?? null,
          inputs: {
            ...body.inputs,
            ...frozen,
            environmentRevision: env?.revision??0,
            createdBy:requireAuth(req).userId,
            ...(templateNodes ? { templateNodes, templateCapabilities, templateParallelism,templateHash:configHash({templateNodes,templateCapabilities,templateParallelism}) } : {}),
          } as never,
          budget: body.budget,
          status: "QUEUED",
          idempotencyKey: body.idempotencyKey,
          inputFingerprint: fingerprint,
        },
      });
      await emitWorkflowEvent(tx, row.id, "workflow.created", {
        workflowId: row.id,
      });
      return row;
    });
    return reply.code(202).send({ workflowId: wf.id });
  });
  app.get("/api/projects/:id/workflows", async (req) => {
    const projectId = param(req, "id");
    await requireProjectAccess(prisma, req, projectId);
    return {
      workflows: await prisma.workflowRun.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
    };
  });
  app.get("/api/workflows/:id", async (req) => find(req));
  app.post("/api/workflows/:id/cancel", async (req) => {
    const wf = await find(req, true);
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "WorkflowRun" WHERE id=${wf.id} FOR UPDATE`;
      const changed = await tx.workflowRun.updateMany({
        where: {
          id: wf.id,
          status: { in: ["QUEUED", "RUNNING", "WAITING_HUMAN"] },
        },
        data: {
          status: "CANCELLED",
          cancelRequestedAt: new Date(),
          currentGate: null,
        },
      });
      if (changed.count) {
        await cancelWorkflowChildren(tx, wf.id);
        await emitWorkflowEvent(tx, wf.id, "workflow.cancelled");
      }
      return {
        workflowId: wf.id,
        status: (
          await tx.workflowRun.findUniqueOrThrow({ where: { id: wf.id } })
        ).status,
      };
    });
  });
  app.post("/api/workflows/:id/nodes/:nodeKey/confirm", async (req) => {
    const wf = await find(req, true);
    const nodeKey = param(req, "nodeKey");
    const body = z
      .object({
        decision: z.enum(["approve", "reject"]),
        note: z.string().max(1000).optional(),
      })
      .strict()
      .parse(req.body);
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "WorkflowRun" WHERE id=${wf.id} FOR UPDATE`;
      const current = await tx.workflowRun.findUniqueOrThrow({
        where: { id: wf.id },
      });
      const node = await tx.workflowNode.findUnique({
        where: { workflowId_nodeKey: { workflowId: wf.id, nodeKey } },
      });
      if (
        current.status !== "WAITING_HUMAN" ||
        current.currentGate !== nodeKey ||
        node?.status !== "waiting_human"
      )
        throw new ApiError("CONFLICT", "工作流已停止或节点已处理");
      const output =
        body.decision === "approve"
          ? await workflowGateAssets(tx, wf.id, nodeKey)
          : {};
      await tx.workflowNode.update({
        where: { id: node.id },
        data: {
          status: body.decision === "approve" ? "completed" : "failed",
          finishedAt: new Date(),
          outputRef: output,
          humanTodo: { cleared: true },
          error: body.decision === "reject" ? (body.note ?? "人工拒绝") : null,
        },
      });
      await tx.workflowRun.update({
        where: { id: wf.id },
        data: {
          status: body.decision === "approve" ? "RUNNING" : "FAILED",
          currentGate: null,
        },
      });
      if (body.decision === "reject") await cancelWorkflowChildren(tx, wf.id);
      await emitWorkflowEvent(
        tx,
        wf.id,
        body.decision === "approve" ? "workflow.resumed" : "workflow.failed",
        { nodeKey, decision: body.decision, note: body.note ?? null },
      );
      return {
        nodeKey,
        status: body.decision === "approve" ? "completed" : "failed",
      };
    });
  });
  app.get("/api/workflows/:id/events", async (req, reply) => {
    const wf = await find(req);
    const raw =
      req.headers["last-event-id"] ??
      (req.query as { lastEventId?: string }).lastEventId ??
      "0";
    const cursorInput = z.coerce
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .parse(raw);
    let cursor = cursorInput;
    let closed = false;
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    reply.raw.write(": connected\n\n");
    reply.raw.on("close", () => {
      closed = true;
    });
    try {
      while (!closed) {
        const events = await prisma.workflowEvent.findMany({
          where: { workflowId: wf.id, seq: { gt: cursor } },
          orderBy: { seq: "asc" },
          take: 200,
        });
        for (const event of events) {
          if (closed) break;
          reply.raw.write(
            `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          );
          cursor = event.seq;
        }
        const current = await prisma.workflowRun.findUniqueOrThrow({
          where: { id: wf.id },
          select: { status: true },
        });
        if (
          ["COMPLETED", "FAILED", "CANCELLED"].includes(current.status) &&
          events.length === 0
        ) {
          reply.raw.write(
            `event: stream.end\ndata: ${JSON.stringify(current)}\n\n`,
          );
          break;
        }
        if (events.length < 200) await new Promise((r) => setTimeout(r, 400));
      }
    } catch (err) {
      req.log.error({ err }, "workflow event stream failed");
    } finally {
      if (!closed) reply.raw.end();
    }
    return reply;
  });
}
