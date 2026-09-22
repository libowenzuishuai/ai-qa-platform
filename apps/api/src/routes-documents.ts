import type { FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import { DocumentParseJobRequest, ParsedDocumentBundle } from "@ai-qa/contracts";
import { ArtifactStore } from "@ai-qa/artifact-store";
import { requireAuth, requireProjectAccess } from "./auth.js";
import { ApiError } from "./errors.js";

export const UPLOAD_LIMIT = 21 * 1024 * 1024;
export function registerDocumentRoutes(app: FastifyInstance, prisma: PrismaClient, queue: Pick<Queue, "add">, store: ArtifactStore) {
  app.addContentTypeParser(/^multipart\/form-data(?:;|$)/i, { parseAs: "buffer", bodyLimit: UPLOAD_LIMIT }, (_req, body, done) => done(null, body));
  app.post("/api/projects/:id/documents", { bodyLimit: UPLOAD_LIMIT }, async (req, reply) => {
    const auth = requireAuth(req);
    const { id: projectId } = z.object({ id: z.string() }).parse(req.params);
    await requireProjectAccess(prisma, req, projectId, "LEAD");
    if (!Buffer.isBuffer(req.body)) throw new ApiError("VALIDATION_ERROR", "请使用 multipart 上传文件与元数据");
    let form: FormData;
    try {
      form = await new Request("http://upload.local", { method: "POST", headers: { "content-type": req.headers["content-type"]! }, body: new Uint8Array(req.body) }).formData();
    } catch { throw new ApiError("VALIDATION_ERROR", "上传表单格式错误"); }
    // FormData 的 keys() 在不同 lib 环境下类型声明不一致（DOM/undici），显式窄化。
    const fieldNames: string[] = Array.from(
      (form as unknown as { keys(): Iterable<string> }).keys(),
    );
    for (const key of new Set(fieldNames)) if (form.getAll(key).length !== 1) throw new ApiError("VALIDATION_ERROR", "上传字段不能重复");
    const file = form.get("file");
    if (!file || typeof file === "string") throw new ApiError("VALIDATION_ERROR", "缺少 file 文件");
    let metadata: unknown;
    try { metadata = form.has("metadata") ? JSON.parse(String(form.get("metadata"))) : {
      title: form.get("title"), declaredFormat: form.get("declaredFormat"),
      fileSizeBytes: Number(form.get("fileSizeBytes")), mode: form.get("mode") ?? "mock",
      ...(form.get("documentId") ? { documentId: form.get("documentId") } : {}),
    }; } catch { throw new ApiError("VALIDATION_ERROR", "元数据不是有效 JSON"); }
    const body = DocumentParseJobRequest.parse(metadata);
    if (file.size !== body.fileSizeBytes) throw new ApiError("VALIDATION_ERROR", "文件实际大小与登记不符");
    if (body.documentId && !await prisma.document.findFirst({ where: { id: body.documentId, projectId } })) throw new ApiError("VALIDATION_ERROR", "文档不属于本项目");
    const data = Buffer.from(await file.arrayBuffer());
    const checksum = createHash("sha256").update(data).digest("hex");
    const fingerprint = createHash("sha256").update(JSON.stringify({ ...body, checksum })).digest("hex");
    const unique = { projectId_kind_fingerprint: { projectId, kind: "DOCUMENT_PARSE", fingerprint } };
    let job = await prisma.job.findUnique({ where: unique });
    let existed = Boolean(job);
    if (!job) {
      const documentVersionId = randomUUID();
      const stored = store.put({ runId: "documents", attemptId: documentVersionId, filename: "source", data });
      try {
        job = await prisma.$transaction(async tx => {
          const document = body.documentId
            ? await tx.document.update({ where: { id: body.documentId }, data: { title: body.title } })
            : await tx.document.create({ data: { projectId, title: body.title } });
          const latest = await tx.documentVersion.aggregate({ where: { documentId: document.id }, _max: { version: true } });
          await tx.documentVersion.create({ data: {
            id: documentVersionId, documentId: document.id, version: (latest._max.version ?? 0) + 1,
            checksum, storageKey: stored.storageKey, fileSizeBytes: stored.size, format: body.declaredFormat,
            parseStatus: "PENDING", mode: body.mode,
          } });
          const created = await tx.job.create({ data: { projectId, kind: "DOCUMENT_PARSE", fingerprint,
            request: { documentVersionId, mode: body.mode } } });
          await tx.auditEvent.create({ data: { actorId: auth.userId, action: "document.upload", entityType: "DocumentVersion", entityId: documentVersionId } });
          return created;
        });
      } catch (error) {
        const registered = await prisma.documentVersion.findUnique({ where: { id: documentVersionId } }).catch(() => undefined);
        if (registered === null) rmSync(store.resolveSafe(stored.storageKey), { force: true });
        if ((error as { code?: string }).code !== "P2002") throw error;
        job = await prisma.job.findUnique({ where: unique });
        if (!job) throw error;
        existed = true;
      }
    }
    if (job.status === "QUEUED") {
      try { await queue.add("run", { jobId: job.id }, { jobId: `job-${job.id}`, removeOnComplete: true, removeOnFail: 200 }); }
      catch { app.log.warn({ jobId: job.id }, "解析入队失败，等待对账补投"); }
    }
    return reply.code(existed ? 200 : 202).send({ jobId: job.id, existed });
  });

  app.get("/api/projects/:id/documents", async req => {
    requireAuth(req);
    const { id: projectId } = z.object({ id: z.string() }).parse(req.params);
    await requireProjectAccess(prisma, req, projectId, "VIEWER");
    return { documents: await prisma.document.findMany({ where: { projectId }, orderBy: { createdAt: "desc" },
      include: { versions: { orderBy: { version: "desc" }, select: {
        id: true, version: true, format: true, parseStatus: true, parserVersion: true, fileSizeBytes: true,
        coverageSummary: true, parseWarnings: true, mode: true, createdAt: true,
      } } } }) };
  });
  app.get("/api/document-versions/:id", async req => {
    requireAuth(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const row = await prisma.documentVersion.findUnique({ where: { id }, include: { document: true } });
    if (!row) throw new ApiError("NOT_FOUND", "文档版本不存在");
    await requireProjectAccess(prisma, req, row.document.projectId, "VIEWER");
    let bundle = null;
    if (row.bundleStorageKey) {
      if (!store.verify(row.bundleStorageKey, row.bundleChecksum)) throw new ApiError("VALIDATION_ERROR", "解析文件丢失或校验和不符，请重新上传新版本");
      bundle = ParsedDocumentBundle.parse(JSON.parse(store.read(row.bundleStorageKey).toString("utf8")));
      if (bundle.documentVersionId !== id) throw new ApiError("VALIDATION_ERROR", "解析文件版本不匹配");
    }
    const { storageKey: _source, bundleStorageKey: _bundle, ...documentVersion } = row;
    return { documentVersion, bundle };
  });
}
