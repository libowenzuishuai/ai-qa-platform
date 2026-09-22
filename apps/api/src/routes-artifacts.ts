import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { ArtifactStore } from "@ai-qa/artifact-store";
import { ApiError } from "./errors.js";
import { requireProjectAccess } from "./auth.js";

/**
 * 证据下载（PRD FR-09 / 阶段 1 提示词 E）：
 * - 服务端鉴权 + 项目归属；RESTRICTED_RAW 需要 LEAD 及以上；
 * - storageKey 由存储层安全解析（拒绝目录穿越）；
 * - 文件不存在 → 404（不伪造）。
 */

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  zip: "application/zip",
  html: "text/html; charset=utf-8",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
};

export function registerArtifactRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  store: ArtifactStore,
) {
  app.get("/api/artifacts/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const artifact = await prisma.artifact.findUnique({ where: { id } });
    if (!artifact) throw new ApiError("NOT_FOUND", "证据不存在");
    const access = await requireProjectAccess(prisma, req, artifact.projectId, "VIEWER");
    if (artifact.sensitivity === "RESTRICTED_RAW" && access.role === "VIEWER") {
      throw new ApiError("FORBIDDEN", "受限原始证据（trace 等）需要 LEAD 及以上权限");
    }
    if (artifact.expiresAt && artifact.expiresAt <= new Date()) throw new ApiError("NOT_FOUND", "证据已过期，历史结果保留但材料不再可验证");
    if (!store.exists(artifact.storageKey)) {
      throw new ApiError("NOT_FOUND", `证据文件不存在（storageKey 已登记）：${artifact.storageKey}`);
    }
    const ext = artifact.storageKey.split(".").pop()?.toLowerCase() ?? "";
    const stream = store.stream(artifact.storageKey);
    reply.header("content-type", MIME_BY_EXT[ext] ?? "application/octet-stream");
    reply.header("x-artifact-type", artifact.type);
    reply.header("x-artifact-sensitivity", artifact.sensitivity);
    if (ext === "zip") reply.header("content-disposition", `attachment; filename="trace-${id}.zip"`);
    return reply.send(stream);
  });

  app.get("/api/artifacts/:id/meta", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const artifact = await prisma.artifact.findUnique({ where: { id } });
    if (!artifact) throw new ApiError("NOT_FOUND", "证据不存在");
    await requireProjectAccess(prisma, req, artifact.projectId, "VIEWER");
    return {
      id: artifact.id,
      type: artifact.type,
      sensitivity: artifact.sensitivity,
      checksum: artifact.checksum,
      size: store.size(artifact.storageKey),
      exists: store.exists(artifact.storageKey) && (!artifact.expiresAt || artifact.expiresAt > new Date()),
      expiresAt: artifact.expiresAt,
      createdAt: artifact.createdAt,
    };
  });
}
