import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  ContextManifest,
  ContextRetrievalRequest,
  ContextRetrievalResponse,
  canonicalStringify,
} from "@ai-qa/contracts";
import { requireAuth, requireProjectAccess } from "./auth.js";
import { ApiError } from "./errors.js";
import { loadReviewBundle } from "./change-review-service.js";

/**
 * v2 ContextManifest（CTX-02/03/04）：规划实际消费的上下文账本。
 * 服务端装载 bundle（复用 v1 归属/校验和防线）→ Python 确定性检索基线
 * → 服务端组装 selections/预算/inputHash → 落库。截断必须保留 omittedRefs。
 */

const INTELLIGENCE_TIMEOUT_MS = 30_000;

export function registerV2ContextRoutes(app: FastifyInstance, prisma: PrismaClient, config: { intelligenceUrl?: string; intelligenceToken?: string; artifactDir?: string }) {
  const param = (req: FastifyRequest, key: string) =>
    (req.params as Record<string, string>)[key]!;

  app.post("/api/v2/projects/:id/context-manifests", async (req, reply) => {
    const projectId = param(req, "id");
    await requireProjectAccess(prisma, req, projectId, "LEAD");
    const body = z
      .object({
        query: z.string().min(1).max(4000),
        documentVersionIds: z.array(z.string().min(1)).min(1).max(50),
        ruleVersionIds: z.array(z.string().min(1)).max(500).default([]),
        /** 上下文 token 预算（估算：4 字符≈1 token）。 */
        tokensMax: z.number().int().min(100).max(200_000).default(20_000),
        maxSelected: z.number().int().min(1).max(500).default(50),
        sessionId: z.string().optional(),
      })
      .strict()
      .parse(req.body);

    // 服务端装载（浏览器只传 id；归属/解析状态/校验和复用 v1 防线）。
    const store = new (await import("@ai-qa/artifact-store")).ArtifactStore(config.artifactDir ?? process.env.AIQA_ARTIFACT_DIR ?? "data/artifacts");
    const bundles = [];
    for (const versionId of body.documentVersionIds) {
      const loaded = await loadReviewBundle(prisma, store, projectId, versionId);
      bundles.push(loaded.bundle);
    }

    // 批准规则来源引用（权威路径）。
    const ruleRefs: Array<{ ruleVersionId: string; sourceSpanIds: string[] }> = [];
    if (body.ruleVersionIds.length) {
      const rules = await prisma.ruleVersion.findMany({
        where: { id: { in: body.ruleVersionIds }, rule: { projectId }, reviewStatus: "APPROVED" },
      });
      if (rules.length !== new Set(body.ruleVersionIds).size)
        throw new ApiError("VALIDATION_ERROR", "存在未批准或不属于本项目的规则版本");
      for (const rule of rules) {
        const sources = z
          .array(z.object({ documentVersionId: z.string(), sourceSpanIds: z.array(z.string()) }))
          .parse(rule.sources);
        for (const source of sources) {
          if (body.documentVersionIds.includes(source.documentVersionId))
            ruleRefs.push({ ruleVersionId: rule.id, sourceSpanIds: source.sourceSpanIds });
        }
      }
    }

    // Python 检索基线（真实 HTTP；确定性）。
    if (!config.intelligenceUrl || !config.intelligenceToken)
      throw new ApiError("DEPENDENCY_UNAVAILABLE", "智能服务未配置，无法检索上下文");
    const input = ContextRetrievalRequest.parse({
      schemaVersion: "1.0",
      requestId: `ctx-${Date.now().toString(36)}`,
      mode: "mock" as const,
      timeoutMs: INTELLIGENCE_TIMEOUT_MS,
      input: {
        query: body.query,
        documentVersions: bundles,
        ruleRefs,
        maxSelected: body.maxSelected,
      },
    });
    let remote: unknown;
    try {
      const response = await fetch(new URL("/v2/context/retrieve", config.intelligenceUrl), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.intelligenceToken}` },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(INTELLIGENCE_TIMEOUT_MS),
      });
      remote = await response.json();
      if (!response.ok) throw new Error(`status ${response.status}`);
    } catch (error) {
      throw new ApiError("DEPENDENCY_UNAVAILABLE", `上下文检索失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = ContextRetrievalResponse.safeParse(remote);
    if (!parsed.success)
      throw new ApiError("MODEL_OUTPUT_INVALID", "检索输出不符合契约", parsed.error.issues.slice(0, 3));
    if (parsed.data.invocations.length)
      throw new ApiError("MODEL_OUTPUT_INVALID", "确定性检索不应产生模型调用");

    // 服务端组装：预算估算（选中项字符数/4）+ 截断对账（omitted 必须记录）。
    const selections = parsed.data.output.selections.map((s) => ({
      kind: s.kind === "unparsed_range" ? ("unparsed_range" as const) : ("span" as const),
      ref: s.ref,
      documentVersionId: s.documentVersionId,
      score: s.score,
      decision: s.decision,
      reason: s.reason,
    }));
    const spanText = new Map(bundles.flatMap((b) => b.spans.map((s) => [s.id, s.quotedText ?? ""])));
    let tokensUsed = 0;
    const omittedRefs: string[] = [];
    const finalSelections = selections.map((selection) => {
      if (selection.decision === "rejected") return selection;
      const cost = Math.ceil((spanText.get(selection.ref) ?? "").length / 4);
      if (tokensUsed + cost > body.tokensMax) {
        omittedRefs.push(selection.ref);
        return { ...selection, decision: "rejected" as const, reason: `上下文预算截断（累计 ${tokensUsed + cost} > ${body.tokensMax}）` };
      }
      tokensUsed += cost;
      return selection;
    });
    const truncated = omittedRefs.length > 0;
    if (!finalSelections.some((s) => s.decision === "selected"))
      throw new ApiError("CONFLICT", "检索无选中项：如实阻断（检索无命中≠没有要求，请扩大预算或检查资料）", { tokensUsed });

    const manifestPayload = {
      projectId,
      retrievalStrategy: parsed.data.output.strategy,
      selections: finalSelections,
      budget: { tokensMax: body.tokensMax, tokensUsed, truncated, omittedRefs },
    };
    const inputHash = createHash("sha256").update(canonicalStringify(manifestPayload)).digest("hex");
    const manifest = ContextManifest.parse({
      ...manifestPayload,
      id: "pending",
      sessionId: body.sessionId ?? null,
      inputHash,
      generatedAt: new Date().toISOString(),
    });
    const created = await prisma.v2ContextManifest.create({
      data: {
        projectId,
        sessionId: body.sessionId ?? null,
        retrievalStrategy: manifest.retrievalStrategy,
        selections: manifest.selections as never,
        budget: manifest.budget as never,
        inputHash,
      },
    });
    await prisma.auditEvent.create({
      data: {
        actorId: requireAuth(req).userId, action: "v2.context.create",
        entityType: "V2ContextManifest", entityId: created.id,
        metadata: { strategy: manifest.retrievalStrategy, selected: finalSelections.filter((s) => s.decision === "selected").length, tokensUsed, truncated } as never,
      },
    });
    return reply.code(202).send({
      contextManifestId: created.id,
      strategy: manifest.retrievalStrategy,
      selected: finalSelections.filter((s) => s.decision === "selected").length,
      rejected: finalSelections.filter((s) => s.decision === "rejected").length,
      tokensUsed, truncated, omittedRefs: omittedRefs.length,
      inputHash,
    });
  });

  app.get("/api/v2/context-manifests/:id", async (req) => {
    const id = param(req, "id");
    const row = await prisma.v2ContextManifest.findUnique({ where: { id } });
    if (!row) throw new ApiError("NOT_FOUND", "上下文清单不存在");
    await requireProjectAccess(prisma, req, row.projectId, "VIEWER");
    return row;
  });
}
