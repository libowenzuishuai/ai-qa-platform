import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  CapabilityManifest,
  computeManifestHash,
} from "@ai-qa/contracts";
import { selfCheckSchema } from "@ai-qa/adapter-sdk";
import { requireAuth, requireProjectAccess } from "./auth.js";
import { ApiError } from "./errors.js";

/**
 * v2 能力安装与授权（HAR-01/06/07）：
 * Manifest→安装校验→注册→（管理员）授权→可调用；撤销立即阻止新调用。
 * 安装与授权分离：注册不等于允许调用。
 */

const MANIFEST_CHECK_VERSION = "manifest-check/1";

export function registerV2CapabilityRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const param = (req: FastifyRequest, key: string) =>
    (req.params as Record<string, string>)[key]!;

  app.post("/api/v2/projects/:id/capabilities/install", async (req, reply) => {
    const projectId = param(req, "id");
    await requireProjectAccess(prisma, req, projectId, "ADMIN");
    const body = z
      .object({
        manifest: z.unknown(),
        /** remote-http 安装时的 endpoint（local-ts 忽略）。 */
        endpoint: z.string().url().optional(),
      })
      .strict()
      .parse(req.body);

    const manifest = CapabilityManifest.safeParse(body.manifest);
    if (!manifest.success)
      throw new ApiError("VALIDATION_ERROR", "能力清单不符合契约", manifest.error.issues.slice(0, 5));
    // Schema 自检：声明子集内的字段组合必须自身合法（安装阶段失败，不进入运行时）。
    for (const [name, schema] of [["inputSchema", manifest.data.inputSchema], ["outputSchema", manifest.data.outputSchema]] as const) {
      const self = selfCheckSchema(schema);
      if (!self.ok) throw new ApiError("VALIDATION_ERROR", `${name} 自检失败：${self.problems.slice(0, 3).join("；")}`);
    }
    if (manifest.data.protocol === "remote-http" && !body.endpoint)
      throw new ApiError("VALIDATION_ERROR", "remote-http 能力必须提供 endpoint");

    const manifestHash = computeManifestHash(manifest.data);
    const saved = await prisma.$transaction(async (tx) => {
      // 清单不可变：同 id+version 内容哈希必须一致（防偷换）。
      const existing = await tx.v2CapabilityManifest.findUnique({
        where: { capabilityId_version: { capabilityId: manifest.data.id, version: manifest.data.version } },
      });
      if (existing && existing.manifestHash !== manifestHash)
        throw new ApiError("CONFLICT", `${manifest.data.id}@${manifest.data.version} 已存在且内容不同（清单不可变）`);
      if (!existing) {
        await tx.v2CapabilityManifest.create({
          data: {
            projectId, capabilityId: manifest.data.id, version: manifest.data.version,
            manifestHash, manifest: manifest.data as never, createdBy: requireAuth(req).userId,
          },
        });
      }
      // 幂等重装：最近的安装有效（非撤销/禁用）则返回原行；
      // 已撤销/禁用的安装重装 = 新安装行（撤销不可被幂等"复活"）。
      const prior = await tx.v2AdapterInstallation.findFirst({
        where: { projectId, capabilityId: manifest.data.id, capabilityVersion: manifest.data.version },
        orderBy: { installedAt: "desc" },
      });
      if (prior && !["REVOKED", "DISABLED"].includes(prior.status))
        return { installationId: prior.id, existed: true, status: prior.status };
      const installation = await tx.v2AdapterInstallation.create({
        data: {
          projectId, capabilityId: manifest.data.id, capabilityVersion: manifest.data.version,
          manifestHash, installedBy: requireAuth(req).userId,
          status: "VALIDATED",
          endpoint: manifest.data.protocol === "remote-http" ? body.endpoint! : null,
        },
      });
      await tx.auditEvent.create({
        data: {
          actorId: requireAuth(req).userId, action: "v2.capability.install",
          entityType: "V2AdapterInstallation", entityId: installation.id,
          metadata: { capabilityId: manifest.data.id, version: manifest.data.version, manifestHash, check: MANIFEST_CHECK_VERSION } as never,
        },
      });
      return { installationId: installation.id, existed: false, status: installation.status };
    });
    return saved.existed
      ? reply.code(200).send(saved)
      : reply.code(202).send(saved);
  });

  app.post("/api/v2/installations/:id/authorize", async (req) => {
    const id = param(req, "id");
    const installation = await prisma.v2AdapterInstallation.findUnique({ where: { id } });
    if (!installation) throw new ApiError("NOT_FOUND", "安装不存在");
    await requireProjectAccess(prisma, req, installation.projectId, "ADMIN");
    const body = z.object({ scope: z.array(z.string().min(1).max(200)).min(1).max(50) }).strict().parse(req.body);
    if (installation.status === "REVOKED")
      throw new ApiError("CONFLICT", "已撤销的安装不能直接恢复授权，请重新安装");
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "V2AdapterInstallation" WHERE id=${id} FOR UPDATE`;
      const fresh = await tx.v2AdapterInstallation.findUniqueOrThrow({ where: { id } });
      // R0.1：锁内再拒 REVOKED（事务外检查存在撤销/授权竞态）。
      if (fresh.status === "REVOKED")
        throw new ApiError("CONFLICT", "已撤销的安装不能直接恢复授权，请重新安装");
      if (fresh.status !== "VALIDATED" && fresh.status !== "AUTHORIZED")
        throw new ApiError("CONFLICT", `状态为 ${fresh.status}，不可授权`);
      if (fresh.status === "AUTHORIZED") {
        // 幂等按指纹区分：同 scope 幂等返回；不同 scope 是异体请求，拒绝。
        const existingScope = ((fresh.authorization ?? {}) as { scope?: string[] }).scope ?? [];
        const sameScope = existingScope.length === body.scope.length && body.scope.every((x) => existingScope.includes(x));
        if (!sameScope)
          throw new ApiError("IDEMPOTENCY_CONFLICT", "该安装已按不同 scope 授权；如需变更先撤销再重新授权");
        return fresh;
      }
      const updated = await tx.v2AdapterInstallation.update({
        where: { id },
        data: {
          status: "AUTHORIZED",
          authorization: {
            grantedBy: requireAuth(req).userId,
            grantedAt: new Date().toISOString(),
            scope: body.scope,
            revokedBy: null,
            revokedAt: null,
          },
        },
      });
      await tx.auditEvent.create({
        data: {
          actorId: requireAuth(req).userId, action: "v2.capability.authorize",
          entityType: "V2AdapterInstallation", entityId: id,
          metadata: { scope: body.scope } as never,
        },
      });
      return updated;
    });
  });

  app.post("/api/v2/installations/:id/revoke", async (req) => {
    const id = param(req, "id");
    const installation = await prisma.v2AdapterInstallation.findUnique({ where: { id } });
    if (!installation) throw new ApiError("NOT_FOUND", "安装不存在");
    await requireProjectAccess(prisma, req, installation.projectId, "ADMIN");
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "V2AdapterInstallation" WHERE id=${id} FOR UPDATE`;
      const fresh = await tx.v2AdapterInstallation.findUniqueOrThrow({ where: { id } });
      if (fresh.status === "REVOKED") return fresh; // 幂等
      const authorization = (fresh.authorization ?? {}) as Record<string, unknown>;
      const updated = await tx.v2AdapterInstallation.update({
        where: { id },
        data: {
          status: "REVOKED",
          authorization: {
            ...authorization,
            revokedBy: requireAuth(req).userId,
            revokedAt: new Date().toISOString(),
          },
        },
      });
      await tx.auditEvent.create({
        data: {
          actorId: requireAuth(req).userId, action: "v2.capability.revoke",
          entityType: "V2AdapterInstallation", entityId: id,
        },
      });
      return updated;
    });
  });

  app.get("/api/v2/projects/:id/capabilities", async (req) => {
    const projectId = param(req, "id");
    await requireProjectAccess(prisma, req, projectId, "VIEWER");
    const installations = await prisma.v2AdapterInstallation.findMany({
      where: { projectId },
      orderBy: { installedAt: "desc" },
    });
    const manifests = await prisma.v2CapabilityManifest.findMany({
      where: { capabilityId: { in: installations.map((i) => i.capabilityId) } },
    });
    const byId = new Map(manifests.map((m) => [`${m.capabilityId}@${m.version}`, m]));
    return {
      installations: installations.map((i) => ({
        id: i.id, capabilityId: i.capabilityId, capabilityVersion: i.capabilityVersion,
        status: i.status, endpoint: i.endpoint, installedAt: i.installedAt,
        humanName: byId.get(`${i.capabilityId}@${i.capabilityVersion}`)
          ? (byId.get(`${i.capabilityId}@${i.capabilityVersion}`)!.manifest as { humanName: string }).humanName
          : i.capabilityId,
      })),
    };
  });
}
