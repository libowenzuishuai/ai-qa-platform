import {ArtifactStore} from "@ai-qa/artifact-store";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import { z } from "zod";
import { canonicalStringify, SessionBudget } from "@ai-qa/contracts";
import { createHash } from "node:crypto";
import { requireAuth, requireProjectAccess } from "./auth.js";
import { ApiError } from "./errors.js";

/**
 * R2/R3：v2 会话 API（最小旅程）。
 * 创建会话（固定 script 规划器切片）→ V2_SESSION_LOOP 作业驱动 session-loop；
 * 详情返回会话+阶段+intent/invocation+观察（真实事件数据源）。
 */

export function registerV2SessionRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  queue: Pick<Queue, "add">,
  config: {intelligenceUrl?:string;intelligenceToken?:string;artifactDir?:string} = {},
) {
  const param = (req: FastifyRequest, key: string) =>
    (req.params as Record<string, string>)[key]!;

  app.post("/api/v2/projects/:id/sessions", async (req, reply) => {
    const projectId = param(req, "id");
    await requireProjectAccess(prisma, req, projectId, "LEAD");
    const body = z
      .object({
        goal: z.string().min(1).max(4000),
        oracleSpecId: z.string().min(1),
        environmentId: z.string().min(1),
        /** 合成系统地址（操作层输入；script 切片）。 */
        targetBaseUrl: z.string().url(),
        buildId: z.string().min(1).max(200).default("synthetic"),
        planner: z.enum(["script","python-real"]).default("script"),
        budget: SessionBudget.optional(),
        maxRounds: z.number().int().min(1).max(50).default(10),
        idempotencyKey: z.string().min(8).max(200),
      })
      .strict()
      .parse(req.body);

    if(body.planner === "python-real" && (!config.intelligenceUrl || !config.intelligenceToken)) throw new ApiError("DEPENDENCY_UNAVAILABLE","Python 规划服务未配置");
    const budget = body.budget ?? {maxWallClockMs:120000,maxActiveMs:120000,maxModelCalls:0,maxTokens:0,maxToolCalls:200,maxResources:10,maxCostMicros:null};
    if(body.planner === "python-real" && (!budget.maxModelCalls || !budget.maxTokens)) throw new ApiError("VALIDATION_ERROR","模型规划必须显式分配调用和令牌预算");
    if(body.planner === "script" && (budget.maxModelCalls || budget.maxTokens)) throw new ApiError("VALIDATION_ERROR","确定性模板不应分配模型预算");
    const oracle = await prisma.v2OracleSpec.findFirst({
      where: { id: body.oracleSpecId, projectId, status: "APPROVED" },
    });
    if (!oracle) throw new ApiError("VALIDATION_ERROR", "Oracle 不存在、未批准或不属于本项目");
    const environment = await prisma.environment.findFirst({
      where: { id: body.environmentId, projectId, isProduction: false },
    });
    if (!environment) throw new ApiError("VALIDATION_ERROR", "环境不可用或为生产环境");

    // 目标 origin 必须在环境白名单内（登记面与执行面一致）。
    const targetOrigin = new URL(body.targetBaseUrl).origin;
    if (!environment.allowedOrigins.includes(targetOrigin))
      throw new ApiError("VALIDATION_ERROR", `目标 origin ${targetOrigin} 不在环境白名单`);

    const fingerprint = createHash("sha256")
      .update(canonicalStringify({ kind: "V2_SESSION_LOOP", projectId, idempotencyKey: body.idempotencyKey }))
      .digest("hex");
    const requestHash = createHash("sha256").update(canonicalStringify(body)).digest("hex");
    const saved = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${projectId} FOR UPDATE`;
      const jobKey = await tx.job.findUnique({
        where: { projectId_kind_fingerprint: { projectId, kind: "V2_SESSION_LOOP", fingerprint } },
      });
      if (jobKey) {
        const previous = jobKey.request as {sessionId: string; requestHash?: string};
        if (previous.requestHash !== requestHash) throw new ApiError("CONFLICT", "相同幂等键对应不同请求");
        const session = await tx.v2ExecutionSession.findFirstOrThrow({ where: { id: previous.sessionId, projectId } });
        return { session, jobId: jobKey.id, existed: true };
      }
      const session = await tx.v2ExecutionSession.create({
        data: {
          projectId,
          goal: body.goal,
          oracleSpecId: oracle.id,
          oracleHash: oracle.oracleHash,
          profileId: `builtin-synthetic-draft-${body.planner}-v1`,
          profileHash: createHash("sha256").update(canonicalStringify({template:"synthetic-draft-v1",planner:body.planner,capability:"synthetic.draft-ops@1.0.0"})).digest("hex"),
          definitionId: "def-draft-loop",
          definitionVersion: 1,
          environmentId: environment.id,
          targetBaseUrl: body.targetBaseUrl,
          buildId: body.buildId,
          status: "QUEUED",
          budget,
          usage: {wallClockMsUsed:0,activeMsUsed:0,modelCallsUsed:0,modelCallsReserved:0,tokensUsed:0,tokensReserved:0,toolCallsUsed:0,toolCallsReserved:0,resourcesCreated:0,costKnownMicros:null},
        },
      });
      const job = await tx.job.create({
        data: {
          projectId, kind: "V2_SESSION_LOOP", fingerprint,
          request: {
            requestHash, sessionId: session.id, baseUrl: body.targetBaseUrl,
            planner: body.planner, maxRounds: body.maxRounds,
          } as never,
        },
      });
      await tx.auditEvent.create({
        data: {
          actorId: requireAuth(req).userId, action: "v2.session.create",
          entityType: "V2ExecutionSession", entityId: session.id,
          metadata: { oracleHash: oracle.oracleHash, planner: body.planner } as never,
        },
      });
      await tx.v2SessionEvent.create({data:{sessionId:session.id,type:"state",payload:{status:"QUEUED"}}});
      return { session, jobId: job.id, existed: false };
    });
    if (!saved.existed)
      try {
        await queue.add("run", { jobId: saved.jobId }, { removeOnComplete: true, removeOnFail: 200 });
      } catch { /* durable reconciliation */ }
    return reply.code(saved.existed ? 200 : 202).send({
      sessionId: saved.session.id, jobId: saved.jobId, existed: saved.existed,
    });
  });

  app.get("/api/v2/projects/:id/sessions", async (req) => {
    const projectId = param(req, "id");
    await requireProjectAccess(prisma, req, projectId, "VIEWER");
    const sessions = await prisma.v2ExecutionSession.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return {
      sessions: sessions.map((s) => ({
        id: s.id, goal: s.goal, status: s.status, buildId: s.buildId,
        oracleHash: s.oracleHash, createdAt: s.createdAt,
      })),
    };
  });

  app.get("/api/v2/sessions/:id", async (req) => {
    const id = param(req, "id");
    const session = await prisma.v2ExecutionSession.findUnique({ where: { id } });
    if (!session) throw new ApiError("NOT_FOUND", "会话不存在");
    await requireProjectAccess(prisma, req, session.projectId, "VIEWER");
    const [attempts, intents, observations] = await Promise.all([
      prisma.v2StepAttempt.findMany({ where: { sessionId: id }, orderBy: { round: "asc" } }),
      prisma.v2ActionIntent.findMany({ where: { sessionId: id }, orderBy: { createdAt: "asc" } }),
      prisma.v2Observation.findMany({ where: { sessionId: id }, orderBy: { round: "asc" } }),
    ]);
    const invocations = await prisma.v2Invocation.findMany({
      where: { intentId: { in: intents.map((i) => i.id) } },
      orderBy: { startedAt: "asc" },
    });
    const evidenceIds=[...new Set(observations.flatMap(o=>o.evidenceArtifactIds))];
    const artifacts=await prisma.artifact.findMany({where:{id:{in:evidenceIds},projectId:session.projectId}});
    const store=new ArtifactStore(config.artifactDir ?? process.env.AIQA_ARTIFACT_DIR ?? "data/artifacts");
    const missingEvidenceIds=evidenceIds.filter(id=>{
      const artifact=artifacts.find(a=>a.id===id);
      return !artifact || (artifact.expiresAt!==null&&artifact.expiresAt<=new Date()) || !artifact.storageKey.startsWith(`${session.id}/`) || !store.verify(artifact.storageKey,artifact.checksum);
    });
    const originalVerdict=(session.result as {verdict?:string}|null)?.verdict ?? null;
    const evidenceComplete=evidenceIds.length>0 && missingEvidenceIds.length===0;
    const graphBuildUnverified=(session.checkpoint as {kind?:string}).kind==='graph'&&(session.result as {buildVerification?:{verified:boolean}}|null)?.buildVerification?.verified!==true;
    const reportVerdict=originalVerdict === "pass" && (!evidenceComplete||graphBuildUnverified) ? "review" : originalVerdict;
    return { session, attempts, intents, invocations, observations, reportVerdict, evidenceComplete, missingEvidenceIds };
  });

  for (const action of ["cancel", "pause", "resume"] as const) {
    app.post(`/api/v2/sessions/:id/${action}`, async (req) => {
      const id = param(req, "id");
      const session = await prisma.v2ExecutionSession.findUnique({ where: { id } });
      if (!session) throw new ApiError("NOT_FOUND", "会话不存在");
      await requireProjectAccess(prisma, req, session.projectId, "LEAD");
      const status = action === "cancel" ? "CANCELLED" : action === "pause" ? "PAUSED" : "QUEUED";
      const jobId = await prisma.$transaction(async tx => {
        const allowed = action === "resume" ? ["PAUSED"] : action === "pause" ? ["QUEUED","PREPARING","RUNNING"] : ["QUEUED","PREPARING","RUNNING","WAITING_HUMAN","WAITING_AUTH","PAUSED"];
        const changed = await tx.v2ExecutionSession.updateMany({where:{id,status:{in:allowed}},data:{
          status, leaseToken:null,leaseExpiresAt:null,
          ...(action === "cancel" ? {cancelRequestedAt:new Date(),terminationReason:"用户取消"} : {pauseRequestedAt:action === "pause" ? new Date() : null}),
        }});
        if (!changed.count) throw new ApiError("CONFLICT", "当前状态不能执行此操作");
        await tx.v2SessionEvent.create({data:{sessionId:id,type:"state",payload:{status,action}}});
        await tx.auditEvent.create({data:{actorId:requireAuth(req).userId,action:`v2.session.${action}`,entityType:"V2ExecutionSession",entityId:id}});
        if (action !== "resume") return null;
        const job = await tx.job.findFirst({where:{projectId:session.projectId,kind:{in:["V2_SESSION_LOOP","V2_GRAPH_SESSION"]},request:{path:["sessionId"],equals:id}}});
        if (!job) throw new ApiError("CONFLICT", "会话缺少原始作业，不能恢复");
        await tx.job.update({where:{id:job.id},data:{status:"QUEUED",startedAt:null,finishedAt:null}});
        return job.id;
      });
      if(jobId) try { await queue.add("run",{jobId},{removeOnComplete:true,removeOnFail:200}); } catch { /* reconciliation retries */ }
      return {sessionId:id,status};
    });
  }

  app.get("/api/v2/sessions/:id/events", async (req, reply) => {
    const id = param(req,"id");
    const session = await prisma.v2ExecutionSession.findUnique({where:{id}});
    if(!session) throw new ApiError("NOT_FOUND","会话不存在");
    await requireProjectAccess(prisma,req,session.projectId,"VIEWER");
    const query = z.object({after:z.coerce.number().int().min(0).default(0),format:z.enum(["json","sse"]).default("sse")}).parse(req.query);
    let cursor = z.coerce.number().int().min(0).parse(req.headers["last-event-id"] ?? query.after);
    const read = () => prisma.v2SessionEvent.findMany({where:{sessionId:id,seq:{gt:cursor}},orderBy:{seq:"asc"},take:200});
    if(query.format === "json") return {events:await read()};
    reply.hijack();
    reply.raw.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache","connection":"keep-alive"});
    let closed=false;
    reply.raw.on("close",()=>{closed=true;});
    while(!closed){
      try {
        await requireProjectAccess(prisma,req,session.projectId,"VIEWER");
        const events=await read();
        for(const event of events){
          if(closed) break;
          if (!reply.raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) {
            // Bound slow consumers: reconnect resumes from its last acknowledged event.
            reply.raw.end(); closed=true; break;
          }
          cursor=event.seq;
        }
        if(!closed) reply.raw.write(": keepalive\n\n");
      } catch { reply.raw.end(); closed=true; }
      if(!closed) await new Promise(r=>setTimeout(r,500));
    }
  });
}
