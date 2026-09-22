import {diagnoseRun} from './diagnosis-service.js';
import {assertMemorySource,refreshMemories} from './memory-service.js';
import {createWorkflow} from './routes-workflow.js';
import {capabilityValidator} from './capability-schema.js';
import type {Queue} from 'bullmq';
import {freezeGoalInput} from './goal-service.js';
import {contentHash} from './change-review-service.js';
import { freezeExecutableTemplate, installBuiltinTemplates } from './template-runtime.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import {
  ReleaseDecisionKind, TemplateNodeDefinition, EvidenceRetentionPolicy, WorkflowRunRequest, ExplorationRequest,
  GoalProposal,
  MemoryRecord,
  DiagnosisEntry,
  DiagnosisCategory,
} from '@ai-qa/contracts';
import { buildRunReport } from '@ai-qa/reporting';
import type { ArtifactStore } from '@ai-qa/artifact-store';
import { requireAuth, requireProjectAccess } from './auth.js';
import { ApiError } from './errors.js';

/**
 * R07 能力目录/DAG 模板 + R08 目标规划/记忆/诊断 + R09 发布决策/导出 API。
 *
 * 关键不变式：
 * - ReleaseDecision 只影响发布决定，绝不回写 Run/CaseAttempt verdict；
 * - 导出与页面统计共用 reporting.buildRunReport 唯一口径；
 * - RESTRICTED_RAW 证据在导出中只给 artifactId+敏感级别，不内嵌公开地址；
 * - 记忆检索按 projectId 隔离，跨项目一律拒绝。
 */

export function registerReleaseRoutes(app: FastifyInstance, prisma: PrismaClient, store: ArtifactStore, queue?:Pick<Queue,"add">) {
  const param = (req: FastifyRequest, key: string) =>
    (req.params as Record<string, string>)[key]!;
  const json = (x: unknown) => x as never;

  app.get('/api/projects/:id/evidence-retention', async req => {
    const projectId=param(req,'id');await requireProjectAccess(prisma,req,projectId);
    const project=await prisma.project.findUniqueOrThrow({where:{id:projectId}});
    return {policy:EvidenceRetentionPolicy.parse((project.settings as any).evidenceRetention??{}),scope:'仅终态运行的执行证据；资料原文与计划观察来源保留',note:'停用策略不会恢复已删除或已过期的证据'};
  });
  app.put('/api/projects/:id/evidence-retention', async req => {
    const projectId=param(req,'id');await requireProjectAccess(prisma,req,projectId,'ADMIN');
    const policy=EvidenceRetentionPolicy.parse(req.body);
    return prisma.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;
      const project=await tx.project.findUniqueOrThrow({where:{id:projectId}});
      await tx.project.update({where:{id:projectId},data:{settings:json({...project.settings as object,evidenceRetention:policy})}});
      await tx.auditEvent.create({data:{actorId:requireAuth(req).userId,action:'evidenceRetention.configure',entityType:'Project',entityId:projectId,metadata:json({previous:(project.settings as any).evidenceRetention??null,policy})}});
      return {policy};
    });
  });

  // ============ R09: ReleaseDecision ============

  app.post('/api/projects/:id/release-decisions', async req => {
    const projectId = param(req, 'id');
    await requireProjectAccess(prisma, req, projectId, 'LEAD');
    const body = z.object({
      runIds: z.array(z.string().min(1)).min(1).max(200).refine(v=>new Set(v).size===v.length),
      idempotencyKey:z.string().min(8).max(120).optional(),
      decision: ReleaseDecisionKind,
      reason: z.string().min(1).max(4000),
      scope: z.string().max(2000).optional(),
    }).strict().parse(req.body);

    // Run 必须存在且属于本项目（错项目/不存在 → 拒绝）。
    const runs = await prisma.run.findMany({ where: { id: { in: body.runIds }, projectId } });
    if (runs.length !== new Set(body.runIds).size) {
      throw new ApiError('VALIDATION_ERROR', '存在不属于本项目的运行');
    }

    // ACCEPT_WITH_RISK 必须说明风险（契约同款校验，服务端兜底）。
    if (body.decision === 'ACCEPT_WITH_RISK' && !body.reason.includes('风险')) {
      throw new ApiError('VALIDATION_ERROR', '接受风险的决策必须在 reason 中说明风险');
    }

    // 决策引用的运行必须已冻结报告（终态）。
    for (const run of runs) {
      if (run.lifecycle !== 'FINISHED' && run.lifecycle !== 'CANCELLED' && run.lifecycle !== 'ERROR') {
        throw new ApiError('CONFLICT', `运行 ${run.id} 未到终态，不能作为决策依据`);
      }
    }

    // 冻结证据快照：决策时引用的报告口径（不修改原始证据）。
    const evidenceSnapshot: Record<string, unknown> = {};
    for (const run of runs) {
      const report = await buildRunReport(prisma, store, run.id);
      evidenceSnapshot[run.id] = {
        acceptanceStatus: report.metrics.acceptanceStatus,
        counts: report.metrics.counts,
        totalSelected: report.metrics.totalSelected,
        // FAIL + 接受风险仍是 FAIL：快照原样记录，导出时同口径。
        hasFail: report.cases.some(c => c.verdict === 'FAIL'),
      };
    }

    const fingerprint=contentHash({runIds:[...body.runIds].sort(),decision:body.decision,reason:body.reason,scope:body.scope??null});
    return prisma.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${projectId} FOR UPDATE`;
      if(body.idempotencyKey){const old=await tx.releaseDecision.findUnique({where:{projectId_idempotencyKey:{projectId,idempotencyKey:body.idempotencyKey}}});if(old){if(old.requestFingerprint!==fingerprint)throw new ApiError('IDEMPOTENCY_CONFLICT','同一提交标识的决策内容发生变化');return old;}}
      const decision=await tx.releaseDecision.create({data:{projectId,runIds:body.runIds,decision:body.decision,decidedBy:requireAuth(req).userId,reason:body.reason,scope:body.scope,evidenceSnapshot:json(evidenceSnapshot),idempotencyKey:body.idempotencyKey,requestFingerprint:fingerprint}});
      await tx.auditEvent.create({data:{actorId:requireAuth(req).userId,action:'releaseDecision.create',entityType:'ReleaseDecision',entityId:decision.id,metadata:json({decision:body.decision,runIds:body.runIds})}});
      return decision;
    });
  });

  app.get('/api/projects/:id/release-decisions', async req => {
    const projectId=param(req,'id');await requireProjectAccess(prisma,req,projectId);
    const page=z.coerce.number().int().min(1).max(100000).default(1).parse((req.query as any).page);
    return {page,pageSize:30,total:await prisma.releaseDecision.count({where:{projectId}}),decisions:await prisma.releaseDecision.findMany({where:{projectId},orderBy:[{decidedAt:'desc'},{id:'asc'}],skip:(page-1)*30,take:30})};
  });

  // ============ R09: 导出（JSON / Markdown）与全量统计 ============

  /** 脱敏：RESTRICTED_RAW 不内嵌公开地址。 */
  const sanitizeEvidence = <T extends { sensitivity: string; url: string }>(e: T) => {
    if (e.sensitivity === 'RESTRICTED_RAW') {
      return { ...e, url: null, note: '受限证据：不在导出中内嵌地址，请在平台内按权限下载' };
    }
    return { ...e, note: null as string | null };
  };

  const buildExport = async (runId: string) => {
    const report = await buildRunReport(prisma, store, runId);
    return {
      ...report,
      exportedAt: new Date().toISOString(),
      cases: report.cases.map(c => ({
        ...c,
        traces: c.traces.map(sanitizeEvidence),
        assertions: c.assertions.map(a => ({ ...a, evidence: a.evidence.map(sanitizeEvidence) })),
      })),
    };
  };

  app.get('/api/runs/:id/export/json', async (req, reply) => {
    const runId = param(req, 'id');
    const run = await prisma.run.findUnique({ where: { id: runId } });
    if (!run) throw new ApiError('NOT_FOUND', '运行不存在');
    await requireProjectAccess(prisma, req, run.projectId);
    reply.header('content-type', 'application/json; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="run-${runId}.json"`);
    return buildExport(runId);
  });

  app.get('/api/runs/:id/export/markdown', async req => {
    const runId = param(req, 'id');
    const run = await prisma.run.findUnique({ where: { id: runId } });
    if (!run) throw new ApiError('NOT_FOUND', '运行不存在');
    await requireProjectAccess(prisma, req, run.projectId);
    const r = await buildExport(runId);
    const lines: string[] = [];
    lines.push(`# 运行报告 ${r.run.id}`);
    lines.push('');
    lines.push(`- 生命周期：${r.run.lifecycle}`);
    lines.push(`- 验收状态：${r.run.acceptanceStatus}`);
    lines.push(`- 模式：${r.run.mode}`);
    lines.push(`- 构建：${r.run.buildId ?? '未声明'}（已核验：${r.run.buildVerified ? '是' : '否'}）`);
    lines.push(`- 导出时间：${r.exportedAt}`);
    lines.push('');
    lines.push('## 统计');
    lines.push('');
    lines.push(`- 选用用例：${r.metrics.totalSelected}`);
    for (const [k, v] of Object.entries(r.metrics.counts)) lines.push(`- ${k}：${v}`);
    lines.push(`- 不稳定：${r.metrics.unstable}`);
    lines.push(`- 执行率：${r.metrics.executionRateDisplay}`);
    lines.push(`- 通过率：${r.metrics.passRateDisplay}`);
    lines.push(`- 规则覆盖：${r.metrics.ruleCoverageDisplay}`);
    lines.push('');
    lines.push('## 用例');
    lines.push('');
    lines.push('| 用例 | 结论 | 原始结论 | 原因 | 证据降级 |');
    lines.push('|---|---|---|---|---|');
    for (const c of r.cases) {
      lines.push(`| ${c.title} | ${c.verdict} | ${c.reportedVerdict} | ${c.reasonCode} | ${c.evidenceDowngraded ? '是' : '否'} |`);
    }
    lines.push('');
    for (const c of r.cases) {
      lines.push(`### ${c.title}（${c.verdict}）`);
      lines.push('');
      for (const a of c.assertions) {
        lines.push(`- 断言 ${a.assertionId}${a.required ? '' : '（非必需）'}：${a.result}`);
        if (a.expected !== null) lines.push(`  - 预期：${a.expected}${a.unit ? ` ${a.unit}` : ''}`);
        if (a.actual !== null) lines.push(`  - 实际：${a.actual}`);
        for (const e of a.evidence) {
          lines.push(e.url
            ? `  - 证据：[${e.artifactId}](${e.url})（${e.sensitivity}${e.integrityOk ? '' : '，校验失败'}）`
            : `  - 证据：${e.artifactId}（${e.sensitivity}，${e.note ?? '受限'}）`);
        }
      }
      if (c.downgradeReasons.length) {
        lines.push('');
        lines.push('降级原因：');
        for (const d of c.downgradeReasons) lines.push(`- ${d}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  });

  /** 服务端全量统计：不受列表 take 限额影响，直接数库。 */
  app.get('/api/projects/:id/stats', async req => {
    const projectId = param(req, 'id');
    await requireProjectAccess(prisma, req, projectId);
    const [total, byLifecycle, recordedByAcceptance, defectCounts] = await Promise.all([
      prisma.run.count({ where: { projectId } }),
      prisma.run.groupBy({ by: ['lifecycle'], where: { projectId }, _count: { _all: true } }),
      prisma.run.groupBy({ by: ['acceptanceStatus'], where: { projectId }, _count: { _all: true } }),
      prisma.defect.groupBy({ by: ['status'], where: { projectId }, _count: { _all: true } }),
    ]);
    const lifecycle: Record<string, number> = {};
    for (const row of byLifecycle) lifecycle[row.lifecycle] = row._count._all;
    const acceptance: Record<string, number> = {};
    const recordedAcceptance: Record<string,number> = {};
    for (const row of recordedByAcceptance) recordedAcceptance[row.acceptanceStatus] = row._count._all;
    // Re-evaluate evidence through the same report builder; cached terminal PASS can outlive its files.
    let cursor:string|undefined;
    do {
      const batch=await prisma.run.findMany({where:{projectId},select:{id:true},orderBy:{id:'asc'},take:50,...(cursor?{cursor:{id:cursor},skip:1}:{})});
      for(let offset=0;offset<batch.length;offset+=4){
        const reports=await Promise.all(batch.slice(offset,offset+4).map(run=>buildRunReport(prisma,store,run.id)));
        for(const report of reports){const status=report.metrics.acceptanceStatus;acceptance[status]=(acceptance[status]??0)+1;}
      }
      cursor=batch.length===50?batch.at(-1)!.id:undefined;
    }while(cursor);
    const defects: Record<string, number> = {};
    for (const row of defectCounts) defects[row.status] = row._count._all;
    return {
      runs: { total, byLifecycle: lifecycle, byAcceptance: acceptance, recordedByAcceptance: recordedAcceptance },
      defects: { byStatus: defects, total: Object.values(defects).reduce((a, b) => a + b, 0) },
      generatedAt: new Date().toISOString(),
      note: '服务端全量统计；当前验收状态重新核对证据，与报告同源，另保留入库时状态',
    };
  });

  // ============ R07: Capability Catalog ============

  app.post('/api/projects/:id/capabilities', async req => {
    const projectId = param(req, 'id');
    await requireProjectAccess(prisma, req, projectId, 'ADMIN');
    const body = z.object({
      key: z.string().regex(/^[a-z][a-z0-9-]*$/),
      name: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      effects: z.array(z.enum(['READ', 'WRITE', 'CREATE', 'DELETE'])).min(1),
      requiredRoles: z.array(z.enum(['VIEWER','LEAD','ADMIN'])).default([]),
      requiresEnvironment: z.boolean().default(false),
      budgetCategory: z.enum(['none', 'model', 'browser', 'compute']).default('none'),
      idempotencyStrategy: z.enum(['idempotent', 'read_only', 'write_uncertain', 'manual']),
      recoveryStrategy: z.enum(['idempotent', 'read_only', 'write_uncertain', 'manual']),
      cleanupResponsibility: z.string().max(1000).optional(),
    }).strict().parse(req.body);

    capabilityValidator(body.inputSchema);capabilityValidator(body.outputSchema);
    return prisma.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;
    const prior = await tx.capabilityCatalog.findFirst({
      where: { projectId, key: body.key },
      orderBy: { version: 'desc' },
    });
    const created = await tx.capabilityCatalog.create({
      data: {
        projectId,
        key: body.key,
        version: (prior?.version ?? 0) + 1,
        name: body.name,
        description: body.description,
        inputSchema: json(body.inputSchema),
        outputSchema: json(body.outputSchema),
        effects: body.effects,
        requiredRoles: body.requiredRoles,
        requiresEnvironment: body.requiresEnvironment,
        budgetCategory: body.budgetCategory,
        idempotencyStrategy: body.idempotencyStrategy,
        recoveryStrategy: body.recoveryStrategy,
        cleanupResponsibility: body.cleanupResponsibility,
        createdBy: requireAuth(req).userId,
      },
    });
    await tx.auditEvent.create({
      data: {
        actorId: requireAuth(req).userId,
        action: 'capability.create',
        entityType: 'CapabilityCatalog',
        entityId: created.id,
        metadata: json({ key: body.key, version: created.version }),
      },
    });
    return created;
    });
  });

  app.get('/api/projects/:id/capabilities', async req => {
    const projectId = param(req, 'id');
    await requireProjectAccess(prisma, req, projectId);
    return {
      capabilities: await prisma.capabilityCatalog.findMany({
        where: { projectId, enabled: true },
        orderBy: [{ key: 'asc' }, { version: 'desc' }],
      }),
    };
  });

  // ============ R07: Workflow Template（DAG 校验 + 发布不可变） ============

  app.post('/api/projects/:id/workflow-templates/validate',async req=>{
    const projectId=param(req,'id');await requireProjectAccess(prisma,req,projectId,'ADMIN');
    const body=z.object({nodes:z.array(TemplateNodeDefinition).min(1).max(64)}).strict().parse(req.body);
    const compiled=await freezeExecutableTemplate(prisma,projectId,body.nodes);return {valid:true,nodeCount:compiled.nodes.length};
  });

  app.post('/api/projects/:id/workflow-templates', async req => {
    const projectId = param(req, 'id');
    await requireProjectAccess(prisma, req, projectId, 'ADMIN');
    const body = z.object({
      key: z.string().regex(/^[a-z][a-z0-9-]*$/),
      name: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
      nodes: z.array(TemplateNodeDefinition).min(1).max(64),
      defaultBudget: z.object({
        maxWallClockMs: z.number().int().min(60_000).default(3_600_000),
        maxModelCalls: z.number().int().min(1).default(50),
        maxToolCalls: z.number().int().min(1).default(200),
        maxTokens: z.number().int().min(1000).default(2_000_000),
      }).default({}),
      defaultParallelism: z.number().int().min(1).max(2).default(1),
    }).strict().parse(req.body);

    // 引用校验：能力必须已注册且启用（悬空/越权引用 → 拒绝）。
    const nodeKeys = new Set(body.nodes.map(n => n.key));
    if (nodeKeys.size !== body.nodes.length) throw new ApiError('VALIDATION_ERROR', '节点 key 重复');
    for (const node of body.nodes) {
      for (const dep of node.dependsOn) {
        if (!nodeKeys.has(dep)) throw new ApiError('VALIDATION_ERROR', `节点 ${node.key} 依赖不存在的 ${dep}`);
      }
      const cap = await prisma.capabilityCatalog.findUnique({
        where: { projectId_key_version: { projectId, key: node.capabilityKey, version: node.capabilityVersion } },
      });
      if (!cap || !cap.enabled) {
        throw new ApiError('VALIDATION_ERROR', `能力 ${node.capabilityKey}@${node.capabilityVersion} 未注册或未启用`);
      }
    }

    // 拓扑排序检测环。
    const inDeg = new Map(body.nodes.map(n => [n.key, n.dependsOn.length]));
    const edges = new Map<string, string[]>();
    for (const n of body.nodes) {
      for (const dep of n.dependsOn) {
        if (!edges.has(dep)) edges.set(dep, []);
        edges.get(dep)!.push(n.key);
      }
    }
    const queue = [...inDeg.entries()].filter(([, d]) => d === 0).map(([k]) => k);
    const visited: string[] = [];
    while (queue.length) {
      const cur = queue.shift()!;
      visited.push(cur);
      for (const next of edges.get(cur) ?? []) {
        const d = (inDeg.get(next) ?? 0) - 1;
        inDeg.set(next, d);
        if (d === 0) queue.push(next);
      }
    }
    if (visited.length !== body.nodes.length) {
      const cycle = body.nodes.filter(n => !visited.includes(n.key)).map(n => n.key);
      throw new ApiError('VALIDATION_ERROR', `模板包含环：${cycle.join(', ')}`);
    }

    return prisma.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;
    const prior = await tx.workflowTemplate.findFirst({
      where: { projectId, key: body.key },
      orderBy: { version: 'desc' },
    });
    const created = await tx.workflowTemplate.create({
      data: {
        projectId,
        key: body.key,
        version: (prior?.version ?? 0) + 1,
        name: body.name,
        description: body.description,
        nodes: json(body.nodes),
        defaultBudget: json(body.defaultBudget),
        defaultParallelism: body.defaultParallelism,
        createdBy: requireAuth(req).userId,
      },
    });
    await tx.auditEvent.create({
      data: {
        actorId: requireAuth(req).userId,
        action: 'workflowTemplate.create',
        entityType: 'WorkflowTemplate',
        entityId: created.id,
        metadata: json({ key: body.key, version: created.version }),
      },
    });
    return created;
    });
  });

  app.post('/api/projects/:id/workflow-templates/builtins',async req=>{
    const projectId=param(req,'id');await requireProjectAccess(prisma,req,projectId,'ADMIN');
    return prisma.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${projectId} FOR UPDATE`;return {templates:await installBuiltinTemplates(tx,projectId,requireAuth(req).userId)};});
  });

  app.get('/api/projects/:id/workflow-templates', async req => {
    const projectId = param(req, 'id');
    await requireProjectAccess(prisma, req, projectId);
    return {
      templates: await prisma.workflowTemplate.findMany({
        where: { projectId },
        orderBy: [{ key: 'asc' }, { version: 'desc' }],
      }),
    };
  });

  app.post('/api/workflow-templates/:id/publish', async req => {
    const id = param(req, 'id');
    const template = await prisma.workflowTemplate.findUnique({ where: { id } });
    if (!template) throw new ApiError('NOT_FOUND', '模板不存在');
    await requireProjectAccess(prisma, req, template.projectId, 'ADMIN');
    if (template.status === 'PUBLISHED') return { id, status: 'PUBLISHED', note: '已发布（幂等）' };
    if (template.status === 'DEPRECATED') throw new ApiError('CONFLICT', '已废弃的模板不能发布');
    await freezeExecutableTemplate(prisma,template.projectId,template.nodes);
    await prisma.workflowTemplate.update({
      where: { id },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });
    await prisma.auditEvent.create({
      data: {
        actorId: requireAuth(req).userId,
        action: 'workflowTemplate.publish',
        entityType: 'WorkflowTemplate',
        entityId: id,
        metadata: json({ key: template.key, version: template.version }),
      },
    });
    return { id, status: 'PUBLISHED' };
  });

  app.post('/api/projects/:id/explorations',async(req,reply)=>{
    const projectId=param(req,'id');await requireProjectAccess(prisma,req,projectId,'LEAD');
    const body=ExplorationRequest.parse(req.body);
    const environment=await prisma.environment.findFirst({where:{id:body.environmentId,projectId,isProduction:false}});
    if(!environment)throw new ApiError('VALIDATION_ERROR','请选择本项目测试环境');
    const fingerprint=contentHash({key:body.idempotencyKey});
    const job=await prisma.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${projectId} FOR UPDATE`;
      const old=await tx.job.findUnique({where:{projectId_kind_fingerprint:{projectId,kind:'EXPLORATION',fingerprint}}});
      if(old){if((old.request as any).bodyHash!==contentHash(body))throw new ApiError('IDEMPOTENCY_CONFLICT','相同键对应不同探索范围');return old;}
      return tx.job.create({data:{projectId,kind:'EXPLORATION',fingerprint,request:{...body,bodyHash:contentHash(body),environmentRevision:environment.revision,createdBy:requireAuth(req).userId}}});
    });
    if(job.status==='QUEUED'&&queue)try{await queue.add('run',{jobId:job.id},{removeOnComplete:true,removeOnFail:200});}catch{/* durable reconciliation */}
    return reply.code(202).send({jobId:job.id});
  });

  // ============ R08: GoalProposal ============

  app.post('/api/projects/:id/goal-proposals/propose',async(req,reply)=>{
    const projectId=param(req,'id');await requireProjectAccess(prisma,req,projectId,'LEAD');
    const body=z.object({goal:z.string().trim().min(1).max(4000),idempotencyKey:z.string().min(8).max(120),documentVersionIds:z.array(z.string().min(1)).max(20).default([]),environmentId:z.string().optional(),mode:z.enum(['real','mock']).default('real')}).strict().parse(req.body);
    const fingerprint=contentHash({key:body.idempotencyKey});
    const job=await prisma.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${projectId} FOR UPDATE`;
      const old=await tx.job.findUnique({where:{projectId_kind_fingerprint:{projectId,kind:'GOAL_PROPOSAL',fingerprint}}});
      if(old){if((old.request as any).bodyHash!==contentHash(body))throw new ApiError('IDEMPOTENCY_CONFLICT','相同幂等键的目标内容不同');return old;}
      const frozen=await freezeGoalInput(tx,projectId,body);
      if(body.mode==='real'&&frozen.pins.documents.some(d=>d.mode!=='real'))throw new ApiError('VALIDATION_ERROR','模拟资料不能作为真实规划依据');
      return tx.job.create({data:{projectId,kind:'GOAL_PROPOSAL',fingerprint,request:{...body,bodyHash:contentHash(body),frozen,createdBy:requireAuth(req).userId}}});
    });
    if(job.status==='QUEUED'&&queue)try{await queue.add('run',{jobId:job.id},{removeOnComplete:true,removeOnFail:200});}catch{/* durable reconciliation */}
    return reply.code(202).send({jobId:job.id});
  });

  app.post('/api/projects/:id/goal-proposals', async req => {
    const projectId = param(req, 'id');
    await requireProjectAccess(prisma, req, projectId, 'LEAD');
    // 只接受 Python 端 GoalProposal 的可写字段；工具引用必须在本项目能力目录中存在。
    const Body = GoalProposal.pick({
      goal: true, suggestedTools: true, suggestedScope: true, suggestedBudget: true, blockers: true,
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', '不符合目标规划契约', parsed.error.issues.slice(0, 3));
    }
    // 未知工具 → 拒绝（模型建议的 capabilityKey 必须真实注册）。
    for (const tool of parsed.data.suggestedTools) {
      const cap = await prisma.capabilityCatalog.findFirst({
        where: { projectId, key: tool.capabilityKey, enabled: true },
        orderBy: { version: 'desc' },
      });
      if (!cap) throw new ApiError('VALIDATION_ERROR', `建议的工具 ${tool.capabilityKey} 未在本项目能力目录注册`);
    }
    const created = await prisma.goalProposal.create({
      data: { projectId, ...parsed.data, createdBy: requireAuth(req).userId },
    });
    return created;
  });

  app.get('/api/projects/:id/goal-proposals', async req => {
    const projectId=param(req,'id');await requireProjectAccess(prisma,req,projectId);
    const page=z.coerce.number().int().min(1).max(100000).default(1).parse((req.query as any).page);
    return {page,pageSize:50,total:await prisma.goalProposal.count({where:{projectId}}),proposals:await prisma.goalProposal.findMany({where:{projectId},orderBy:[{createdAt:'desc'},{id:'asc'}],take:50,skip:(page-1)*50})};
  });
  app.get('/api/goal-proposals/:id',async req=>{
    const proposal=await prisma.goalProposal.findUnique({where:{id:param(req,'id')}});if(!proposal)throw new ApiError('NOT_FOUND','规划不存在');await requireProjectAccess(prisma,req,proposal.projectId);return proposal;
  });

  app.post('/api/goal-proposals/:id/review', async req => {
    const id = param(req, 'id');
    const proposal = await prisma.goalProposal.findUnique({ where: { id } });
    if (!proposal) throw new ApiError('NOT_FOUND', '目标规划不存在');
    await requireProjectAccess(prisma, req, proposal.projectId, 'LEAD');
    const body = z.object({
      decision: z.enum(['approve', 'reject']),
      note: z.string().max(2000).optional(),
    }).strict().parse(req.body);
    // CAS：仅 DRAFT 可审核，并发审核只有一个成功。
    const updated = await prisma.goalProposal.updateMany({
      where: { id, status: 'DRAFT' },
      data: {
        status: body.decision === 'approve' ? 'APPROVED' : 'REJECTED',
        reviewedBy: requireAuth(req).userId,
        reviewedAt: new Date(),
      },
    });
    if (updated.count === 0) throw new ApiError('CONFLICT', '目标规划不在 DRAFT 状态（可能已被并发审核）');
    await prisma.auditEvent.create({
      data: {
        actorId: requireAuth(req).userId,
        action: `goalProposal.${body.decision}`,
        entityType: 'GoalProposal',
        entityId: id,
        metadata: json({ note: body.note ?? null }),
      },
    });
    return prisma.goalProposal.findUniqueOrThrow({ where: { id } });
  });

  app.post('/api/goal-proposals/:id/execute',async(req,reply)=>{
    const id=param(req,'id'),proposal=await prisma.goalProposal.findUnique({where:{id}});
    if(!proposal)throw new ApiError('NOT_FOUND','目标规划不存在');
    await requireProjectAccess(prisma,req,proposal.projectId,'LEAD');
    const body=WorkflowRunRequest.innerType().omit({idempotencyKey:true,missionId:true}).parse(req.body);
    const actor=requireAuth(req).userId;
    const workflow=await prisma.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${proposal.projectId} FOR UPDATE`;
      const current=await tx.goalProposal.findUniqueOrThrow({where:{id}});
      if(current.workflowId){
        if(contentHash(current.executionRequest)!==contentHash(body))throw new ApiError('IDEMPOTENCY_CONFLICT','本规划已经按其他输入启动');
        return tx.workflowRun.findUniqueOrThrow({where:{id:current.workflowId}});
      }
      if(current.status!=='APPROVED')throw new ApiError('CONFLICT','先批准规划再执行');
      if((current.blockers as any[]).length)throw new ApiError('CONFLICT','规划仍有阻塞项，请补齐条件后重新规划');
      const scope=current.suggestedScope as any;
      if(scope.mode==='mock')throw new ApiError('VALIDATION_ERROR','模拟规划不能启动真实任务');
      if(scope.pins){
        const now=await freezeGoalInput(tx,current.projectId,{goal:current.goal,documentVersionIds:scope.documentVersionIds??[],environmentId:scope.environmentId??undefined});
        if(contentHash(now.pins)!==contentHash(scope.pins))throw new ApiError('CONFLICT','规划依据已变化，请重新规划');
      }
      const proposedDocs=[...(scope.documentVersionIds??[])].sort(),actualDocs=[...body.inputs.documentVersionIds].sort();
      if(contentHash(proposedDocs)!==contentHash(actualDocs)||scope.environmentId&&scope.environmentId!==body.inputs.environmentId||scope.baselineId&&scope.baselineId!==body.inputs.baselineId)throw new ApiError('VALIDATION_ERROR','执行范围与批准规划不一致');
      if(!body.templateId)throw new ApiError('VALIDATION_ERROR','请选择已发布模板');
      const template=await tx.workflowTemplate.findFirst({where:{id:body.templateId,projectId:current.projectId,status:'PUBLISHED'}});
      if(!template)throw new ApiError('VALIDATION_ERROR','模板不可用');
      const keys=new Set((template.nodes as any[]).map(n=>n.capabilityKey));
      if((current.suggestedTools as any[]).some(t=>!keys.has(t.capabilityKey)))throw new ApiError('VALIDATION_ERROR','模板未覆盖批准的建议工具');
      const suggested=current.suggestedBudget as any;
      for(const key of ['maxWallClockMs','maxModelCalls','maxToolCalls'] as const)if(suggested[key]&&body.budget[key]>suggested[key])throw new ApiError('BUDGET_EXCEEDED','执行预算超过已批准的规划预算');
      const wf=await createWorkflow(prisma,current.projectId,{...body,idempotencyKey:'goal:'+id},actor,tx);
      await tx.goalProposal.update({where:{id},data:{status:'EXECUTED',workflowId:wf.id,executionRequest:body as never}});
      await tx.auditEvent.create({data:{actorId:actor,action:'goalProposal.execute',entityType:'GoalProposal',entityId:id,metadata:{workflowId:wf.id}}});return wf;
    });
    return reply.code(202).send({workflowId:workflow.id});
  });

  // ============ R08: ProjectMemory（项目隔离 + 失效触发） ============

  app.post('/api/projects/:id/memories', async req => {
    const projectId = param(req, 'id');
    await requireProjectAccess(prisma, req, projectId, 'LEAD');
    const Body = MemoryRecord.pick({ content: true, source: true, context: true, validUntil: true, invalidationTriggers: true });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', '不符合记忆契约', parsed.error.issues.slice(0, 3));
    }
    const validUntil=parsed.data.validUntil?new Date(parsed.data.validUntil):new Date(Date.now()+7*86400000);
    await assertMemorySource(prisma,store,projectId,{...parsed.data,validUntil});
    return prisma.projectMemory.create({
      data: {
        projectId,
        content: parsed.data.content,
        source: json(parsed.data.source),
        context: json(parsed.data.context),
        validUntil,
        environmentId:parsed.data.context.environmentId,
        invalidationTriggers: json(parsed.data.invalidationTriggers),
      },
    });
  });

  app.get('/api/projects/:id/memories', async req => {
    const projectId = param(req, 'id');
    // 跨项目检索被 projectId where 条件硬隔离；无本项目权限一律 FORBIDDEN。
    await requireProjectAccess(prisma, req, projectId);
    const query = z.object({
      includeInvalidated: z.enum(['true','false']).default('false').transform(v=>v==='true'),
      page:z.coerce.number().int().min(1).max(100000).default(1),
    }).strict().parse(req.query);
    await refreshMemories(prisma,store,projectId);
    return {
      page:query.page,total:await prisma.projectMemory.count({where:{projectId,...(query.includeInvalidated?{}:{invalidated:false})}}),
      memories: await prisma.projectMemory.findMany({
        where: { projectId, ...(query.includeInvalidated?{}:{invalidated:false}) },
        orderBy: { createdAt: 'desc' },
        take: 50,skip:(query.page-1)*50,
      }),
    };
  });

  app.post('/api/memories/:id/invalidate', async req => {
    const id = param(req, 'id');
    const memory = await prisma.projectMemory.findUnique({ where: { id } });
    if (!memory) throw new ApiError('NOT_FOUND', '记忆不存在');
    await requireProjectAccess(prisma, req, memory.projectId, 'LEAD');
    const body = z.object({
      reason: z.string().min(1).max(1000),
    }).strict().parse(req.body);
    const updated = await prisma.projectMemory.updateMany({
      where: { id, invalidated: false },
      data: { invalidated: true, invalidatedReason: body.reason },
    });
    if (updated.count === 0) throw new ApiError('CONFLICT', '记忆已失效');
    return { id, invalidated: true, reason: body.reason };
  });

  // ============ R08: DiagnosisEntry（事实/假设/建议，不改变判） ============

  app.post('/api/projects/:id/diagnoses/generate',async(req,reply)=>{
    const projectId=param(req,'id');await requireProjectAccess(prisma,req,projectId,'LEAD');
    const body=z.object({runId:z.string().min(1)}).strict().parse(req.body);
    return diagnoseRun(prisma,store,projectId,body.runId,requireAuth(req).userId);
  });
  app.post('/api/projects/:id/diagnoses', async req => {
    const projectId = param(req, 'id');
    await requireProjectAccess(prisma, req, projectId, 'LEAD');
    const Body = DiagnosisEntry.pick({ runId: true, attemptId: true, category: true, facts: true, hypotheses: true, suggestions: true, confidence: true });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', '不符合诊断契约', parsed.error.issues.slice(0, 3));
    }
    // 引用的 Run/Attempt 必须属于本项目。
    if (parsed.data.runId) {
      const run = await prisma.run.findUnique({ where: { id: parsed.data.runId } });
      if (!run || run.projectId !== projectId) throw new ApiError('VALIDATION_ERROR', '引用的运行不属于本项目');
    }
    if (parsed.data.attemptId) {
      const attempt = await prisma.caseAttempt.findUnique({ where: { id: parsed.data.attemptId } });
      const run = attempt && await prisma.run.findUnique({ where: { id: attempt.runId } });
      if (!attempt || !run || run.projectId !== projectId || parsed.data.runId && attempt.runId !== parsed.data.runId) {
        throw new ApiError('VALIDATION_ERROR', '引用的尝试不属于本项目');
      }
    }
    for(const fact of parsed.data.facts){
      if(!fact.evidenceId)continue; // Human-entered notes remain attributed to their author.
      const artifact=await prisma.artifact.findFirst({where:{id:fact.evidenceId,projectId}});
      if(!artifact||!artifact.checksum||!store.verify(artifact.storageKey,artifact.checksum)||artifact.expiresAt&&artifact.expiresAt<=new Date())throw new ApiError('VALIDATION_ERROR','诊断证据不可用');
      if(parsed.data.attemptId&&artifact.attemptId!==parsed.data.attemptId)throw new ApiError('VALIDATION_ERROR','证据不属于此执行尝试');
      if(parsed.data.runId&&(!artifact.attemptId||!await prisma.caseAttempt.findFirst({where:{id:artifact.attemptId,runId:parsed.data.runId}})))throw new ApiError('VALIDATION_ERROR','证据不属于此运行');
    }
    return prisma.diagnosisEntry.create({
      data: {
        projectId,
        runId: parsed.data.runId,
        attemptId: parsed.data.attemptId,
        category: parsed.data.category,
        facts: json(parsed.data.facts),
        hypotheses: json(parsed.data.hypotheses),
        suggestions: json(parsed.data.suggestions),
        confidence: parsed.data.confidence,
        createdBy: requireAuth(req).userId,
      },
    });
  });

  app.get('/api/projects/:id/diagnoses', async req => {
    const projectId = param(req, 'id');
    await requireProjectAccess(prisma, req, projectId);
    const query = z.object({
      runId: z.string().optional(),
      category: DiagnosisCategory.optional(),
      page:z.coerce.number().int().min(1).max(100000).default(1),
    }).strict().parse(req.query);
    return {
      page:query.page,pageSize:50,total:await prisma.diagnosisEntry.count({where:{projectId,runId:query.runId,category:query.category}}),
      diagnoses: await prisma.diagnosisEntry.findMany({
        where: { projectId, runId: query.runId, category: query.category },
        orderBy: [{ createdAt: 'desc' },{id:'asc'}],
        take:50,skip:(query.page-1)*50,
      }),
    };
  });
}
