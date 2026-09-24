import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { createHash } from "node:crypto";
import { canonicalStringify } from "@ai-qa/contracts";
import { requireAuth, requireProjectAccess } from "./auth.js";
import { ApiError } from "./errors.js";

/**
 * R1 任务准备检查（W04/W06 共享）：
 * 按任务实际依赖判定——模型缺配置只阻塞依赖模型的步骤；确定性检索/已批准
 * 固定计划/纯浏览器不被无关模型挡住。结果绑定配置指纹/角色/环境版本并带
 * 过期时间；重复检查幂等（同指纹 upsert，不产生重复资源）；改配置=新指纹=
 * 旧结果自然失效（不再被读取）。秘密层只显示引用与可解析性，不回显值。
 */

export interface ReadinessBlocker {
  reasonCode: string;
  reason: string;
  impact: string;
  missing: string;
  ownerRole: string;
  nextAction: string;
  evidence: string;
  updatedAt: string;
}

const READINESS_TTL_MS = 10 * 60 * 1000;

const ReadinessRequest = z.object({
  sessionId: z.string().optional(),
  environmentId: z.string().min(1),
  role: z.string().max(80).optional(),
  /** 任务实际依赖（缺省全 false——只检查归属/环境）。 */
  needs: z.object({
    model: z.boolean().default(false),
    browser: z.boolean().default(false),
    http: z.boolean().default(false),
    engineeringRunner: z.boolean().default(false),
  }).strict().default({}),
  /** 任务引用的 secretRef（只查登记与可解析，不出值）。 */
  secretRefs: z.array(z.string().min(1).max(128)).max(20).default([]),
}).strict();

export function registerV2ReadinessRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const param = (req: FastifyRequest, key: string) =>
    (req.params as Record<string, string>)[key]!;

  app.post("/api/v2/projects/:id/readiness", async (req, reply) => {
    const projectId = param(req, "id");
    await requireProjectAccess(prisma, req, projectId, "LEAD");
    const body = ReadinessRequest.parse(req.body);

    if (body.sessionId) {
      const session = await prisma.v2ExecutionSession.findFirst({
        where: { id: body.sessionId, projectId },
      });
      if (!session) throw new ApiError("VALIDATION_ERROR", "sessionId 不存在或不属于本项目");
    }

    // 环境固定版本（不是"最新"）。
    const environment = await prisma.environment.findFirst({
      where: { id: body.environmentId, projectId },
    });
    const blockers: ReadinessBlocker[] = [];
    const now = new Date().toISOString();
    if (!environment) {
      blockers.push({
        reasonCode: "ENV_NOT_FOUND",
        reason: "所选环境不存在或不属于本项目",
        impact: "所有依赖该环境的步骤",
        missing: "环境登记",
        ownerRole: "LEAD",
        nextAction: "在项目中登记环境并固定版本后再检查",
        evidence: `environmentId=${body.environmentId}`,
        updatedAt: now,
      });
    }
    const environmentRevision = environment?.revision ?? 0;

    // 平台层：模型配置存在性（≠ 已验证语义质量；语义质量是独立状态）。
    if (body.needs.model) {
      const modelConfigured = Boolean(
        process.env.AIQA_TEXT_API_KEY || process.env.AIQA_INTELLIGENCE_TOKEN,
      );
      if (!modelConfigured) {
        blockers.push({
          reasonCode: "MODEL_NOT_CONFIGURED",
          reason: "生成模型未配置（存在性检查；连通与语义质量需另行验证）",
          impact: "仅依赖模型的步骤：规划建议/候选生成；确定性检索与已批准固定计划不受影响",
          missing: "模型 API 配置（环境变量）",
          ownerRole: "ADMIN",
          nextAction: "配置模型凭据后重查；或改用已批准固定计划/确定性流程",
          evidence: "env: AIQA_TEXT_API_KEY / AIQA_INTELLIGENCE_TOKEN 均未设置",
          updatedAt: now,
        });
      }
    }

    // 执行层：浏览器/HTTP 面由平台 worker 提供（存在 worker 心跳即视为配置）；
    // 工程运行器按显式配置判定。
    if (body.needs.browser) {
      const recentWorker = await prisma.job.findFirst({
        where: { projectId, updatedAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
        select: { id: true },
      });
      if (!recentWorker) {
        blockers.push({
          reasonCode: "BROWSER_RUNNER_UNAVAILABLE",
          reason: "近 24 小时无本项目 worker 心跳（浏览器执行面不可用）",
          impact: "仅浏览器步骤；HTTP/工程步骤不受影响",
          missing: "执行 worker 在线",
          ownerRole: "ADMIN",
          nextAction: "启动 worker 后重查；或先运行纯 HTTP/API 任务",
          evidence: "jobs.updatedAt 无近期记录",
          updatedAt: now,
        });
      }
    }
    if (body.needs.engineeringRunner && !process.env.AIQA_RUNNER_CONFIGURED) {
      blockers.push({
        reasonCode: "ENGINEERING_RUNNER_NOT_CONFIGURED",
        reason: "工程运行器未配置（自托管 runner 未接入）",
        impact: "仅工程检查节点（测试/构建/部署验证）",
        missing: "self-hosted runner 注册",
        ownerRole: "ADMIN",
        nextAction: "按 tools/self-hosted-runner 部署并注册；浏览器/模型步骤可先行",
        evidence: "env: AIQA_RUNNER_CONFIGURED 未设置",
        updatedAt: now,
      });
    }

    // 秘密层：只显示引用与可解析性（值不回显）。
    if (body.secretRefs.length) {
      const registered = (environment?.secretRefs ?? {}) as Record<string, unknown>;
      for (const ref of body.secretRefs) {
        const [role, field] = ref.split(".");
        const entry = registered[role ?? ""] as Record<string, unknown> | undefined;
        const envName = entry?.[field === "username" ? "usernameEnv" : "passwordEnv"];
        const resolvable = typeof envName === "string" && Boolean(process.env[envName]);
        if (!resolvable) {
          blockers.push({
            reasonCode: "SECRET_NOT_RESOLVABLE",
            reason: `凭据引用不可解析：${ref}（只检查登记与可解析，值不显示）`,
            impact: "依赖该凭据的登录/数据步骤",
            missing: `环境变量 ${typeof envName === "string" ? envName : "(未登记映射)"}`,
            ownerRole: "ADMIN",
            nextAction: "在环境 secretRefs 登录映射并配置对应环境变量",
            evidence: `secretRef=${ref} registered=${Boolean(entry)}`,
            updatedAt: now,
          });
        }
      }
    }

    // 配置指纹：环境版本/角色/依赖面/秘密引用集合——任一变化=新指纹=旧结果失效。
    const configFingerprint = createHash("sha256")
      .update(canonicalStringify({
        environmentId: body.environmentId,
        environmentRevision,
        role: body.role ?? null,
        needs: body.needs,
        secretRefs: [...body.secretRefs].sort(),
      }))
      .digest("hex");
    const status = blockers.length === 0 ? "ready" : "blocked";
    const expiresAt = new Date(Date.now() + READINESS_TTL_MS);

    // 幂等：同 (session, 指纹) upsert（重复检查不产生重复资源；改配置=新指纹=新行）。
    const key = { sessionId: body.sessionId ?? "__project__", configFingerprint };
    const existing = await prisma.v2ReadinessCheck.findFirst({
      where: { sessionId: body.sessionId ?? null, configFingerprint },
    });
    void key;
    const saved = existing
      ? await prisma.v2ReadinessCheck.update({
          where: { id: existing.id },
          data: { status, blockers: blockers as never, checkedAt: new Date(), expiresAt },
        })
      : await prisma.v2ReadinessCheck.create({
          data: {
            projectId,
            sessionId: body.sessionId ?? null,
            configFingerprint,
            role: body.role ?? null,
            environmentRevision,
            status,
            blockers: blockers as never,
            expiresAt,
          },
        });
    return reply.code(existing ? 200 : 201).send({
      readinessId: saved.id,
      status,
      configFingerprint,
      environmentRevision,
      blockers,
      expiresAt: expiresAt.toISOString(),
      note: blockers.length === 0
        ? "就绪（按任务依赖面判定；模型语义质量为独立状态，未在本检查中宣称）"
        : "存在阻塞（每项含影响范围与下一步；只阻塞受影响步骤，不阻塞无关面）",
    });
  });

  app.get("/api/v2/projects/:id/readiness/latest", async (req) => {
    const projectId = param(req, "id");
    await requireProjectAccess(prisma, req, projectId, "VIEWER");
    const latest = await prisma.v2ReadinessCheck.findFirst({
      where: { projectId },
      orderBy: { checkedAt: "desc" },
    });
    if (!latest) return { readiness: null };
    const expired = latest.expiresAt < new Date();
    return {
      readiness: expired
        ? { ...latest, status: "expired", note: "已过期（TTL 到期或配置已变化）：启动前需服务端重检" }
        : latest,
    };
  });
}
