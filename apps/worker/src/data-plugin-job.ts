import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { ArtifactStore } from "@ai-qa/artifact-store";
import { checkDestination } from "@ai-qa/test-runtime";
import { configHash } from "../../api/src/preparation-service.js";
import {
  validateDataParameters,
  parseDataDefinition,
} from "../../api/src/data-plugin-service.js";
import type { PreparationJob, JobCommit } from "./login-check-job.js";

/** Network requests are bounded, never redirect, and contain only registered template data. */
async function requestResource(
  baseUrl: string,
  allowedOrigins: string[],
  path: string,
  method: string,
  body: unknown,
  timeoutMs: number,
  signal: AbortSignal,
) {
  const url = new URL(path, baseUrl);
  if (
    !checkDestination(url.href, { allowedOrigins, dependencyOrigins: [] })
      .allowed
  )
    throw new Error("模板目标不在环境白名单");
  const controller = new AbortController(),
    abort = () => controller.abort();
  signal.addEventListener("abort", abort);
  if (signal.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      redirect: "manual",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    // Do not retain response bodies; they may contain customer data. Resource identity is supplied by us.
    await response.body?.cancel();
    return response.status;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
export async function prepareData(
  prisma: PrismaClient,
  store: ArtifactStore,
  projectId: string,
  input: {
    pluginId: string;
    idempotencyKey: string;
    params: unknown;
    runId?: string;
    attemptId?: string;
  },
  signal: AbortSignal,
) {
  const plugin = await prisma.dataPlugin.findFirstOrThrow({
    where: { id: input.pluginId, projectId, enabled: true },
  });
  const env = await prisma.environment.findFirstOrThrow({
    where: {
      id: plugin.environmentId ?? "",
      projectId,
      isProduction: false,
      revision: plugin.environmentRevision ?? -1,
    },
  });
  const definition = parseDataDefinition(plugin.definition),
    params = validateDataParameters(plugin.paramSchema, input.params);
  if (
    input.runId &&
    !(await prisma.run.findFirst({
      where: { id: input.runId, projectId, environmentId: env.id },
    }))
  )
    throw new Error("运行环境归属不符");
  if (
    input.attemptId &&
    !(await prisma.caseAttempt.findFirst({
      where: { id: input.attemptId, projectId, runId: input.runId ?? "" },
    }))
  )
    throw new Error("attempt 归属不符");
  const namespace =
    "data-" +
    configHash({
      projectId,
      pluginId: plugin.id,
      key: input.idempotencyKey,
    }).slice(0, 32);
  const fingerprint = configHash({
    params,
    runId: input.runId ?? null,
    attemptId: input.attemptId ?? null,
  });
  // An immutable preallocated resource ID allows inspection even if create's response is lost.
  let resource = await prisma.dataResource.findFirst({
      where: { projectId, pluginId: plugin.id, namespace, action: "prepare" },
    }),
    owned = false;
  if (!resource) {
    try {
      resource = await prisma.dataResource.create({
        data: {
          projectId,
          pluginId: plugin.id,
          namespace,
          runId: input.runId,
          attemptId: input.attemptId,
          externalRef: randomUUID(),
          action: "prepare",
          actionFingerprint: fingerprint,
          parameters: params,
          status: "pending",
        },
      });
      owned = true;
    } catch (e) {
      resource = await prisma.dataResource.findFirst({
        where: { projectId, pluginId: plugin.id, namespace, action: "prepare" },
      });
      if (!resource) throw e;
    }
  }
  if (resource.actionFingerprint !== fingerprint)
    throw new Error("相同准备标识对应不同参数");
  if (!owned) {
    if (resource.status === "success") return resource;
    throw new Error("资源创建已尝试或结果未知，必须核对；未重放写入");
  }
  let status = "unknown",
    detail = "创建结果未知，需核对";
  try {
    if (signal.aborted) throw new Error("stopped");
    const path = definition.prepare.path
      .replaceAll("{resourceId}", resource.externalRef)
      .replaceAll("{namespace}", namespace);
    const code = await requestResource(
      env.baseUrl,
      env.allowedOrigins,
      path,
      definition.prepare.method,
      { resourceId: resource.externalRef, namespace, parameters: params },
      definition.timeoutMs,
      signal,
    );
    if (code >= 200 && code < 300) {
      const inspectPath = definition.inspect.path
        .replaceAll("{resourceId}", resource.externalRef)
        .replaceAll("{namespace}", namespace);
      const checked = await requestResource(
        env.baseUrl,
        env.allowedOrigins,
        inspectPath,
        "GET",
        undefined,
        definition.timeoutMs,
        signal,
      );
      if (checked >= 200 && checked < 300) {
        status = "success";
        detail = "创建后已核对预分配资源";
      }
    } else {
      detail = `创建返回 ${code}，未确认资源状态`;
    }
  } catch {
    /* Unknown writes are not retried. */
  }
  const evidence = store.put({
    runId: "data-preparation",
    attemptId: resource.id,
    filename: `prepare-${randomUUID()}.json`,
    data: Buffer.from(
      JSON.stringify({ resourceId: resource.id, status, detail }),
    ),
  });
  const artifact = await prisma.artifact.create({
    data: {
      projectId,
      type: "DATA_RESOURCE",
      sensitivity: "NORMAL",
      storageKey: evidence.storageKey,
      checksum: evidence.checksum,
    },
  });
  await prisma.dataResource.updateMany({
    where: {
      id: resource.id,
      status: "pending",
      updatedAt: resource.updatedAt,
    },
    data: { status, detail, evidenceId: artifact.id },
  });
  return prisma.dataResource.findUniqueOrThrow({ where: { id: resource.id } });
}
export async function operateData(
  prisma: PrismaClient,
  store: ArtifactStore,
  projectId: string,
  pluginId: string,
  resourceIds: string[],
  operation: "cleanup" | "inspect",
  signal: AbortSignal,
) {
  const plugin = await prisma.dataPlugin.findFirstOrThrow({
      where: { id: pluginId, projectId },
    }),
    definition = parseDataDefinition(plugin.definition);
  const env = await prisma.environment.findFirstOrThrow({
    where: { id: plugin.environmentId ?? "", projectId, isProduction: false },
  });
  const frozen = plugin.environmentSnapshot as { baseUrl?: string } | null;
  if (!frozen?.baseUrl || env.baseUrl !== frozen.baseUrl)
    throw new Error("环境地址已改变，不能在新环境清理旧资源");
  const resources = await prisma.dataResource.findMany({
    where: { id: { in: resourceIds }, projectId, pluginId },
  });
  if (!resources.length || resources.length !== new Set(resourceIds).size)
    throw new Error("资源归属不符");
  const deadline = Date.now() + 30000;
  for (const r of resources) {
    if (["cleaned", "cleaning", "pending"].includes(r.status)) continue;
    if (signal.aborted || Date.now() >= deadline) break;
    const claimedAt = new Date();
    const claim = await prisma.dataResource.updateMany({
      where: { id: r.id, status: r.status, updatedAt: r.updatedAt },
      data: { status: "cleaning", updatedAt: claimedAt },
    });
    if (!claim.count) continue;
    let status = "unknown",
      detail = "核对失败，保留资源记录";
    try {
      const path = definition.inspect.path
        .replaceAll("{resourceId}", encodeURIComponent(r.externalRef))
        .replaceAll("{namespace}", encodeURIComponent(r.namespace));
      const inspected = await requestResource(
        env.baseUrl,
        env.allowedOrigins,
        path,
        "GET",
        undefined,
        Math.min(definition.timeoutMs, Math.max(1, deadline - Date.now())),
        signal,
      );
      if (inspected === 404 && definition.cleanup.allow404) {
        status = "cleaned";
        detail = "核对确认资源不存在";
      } else if (inspected >= 200 && inspected < 300) {
        status = "success";
        detail = "核对确认本资源存在";
        if (operation === "cleanup") {
          if (signal.aborted || Date.now() >= deadline)
            throw new Error("清理预算到期");
          const cleanupPath = definition.cleanup.path
            .replaceAll("{resourceId}", encodeURIComponent(r.externalRef))
            .replaceAll("{namespace}", encodeURIComponent(r.namespace));
          const code = await requestResource(
            env.baseUrl,
            env.allowedOrigins,
            cleanupPath,
            "DELETE",
            undefined,
            Math.min(definition.timeoutMs, Math.max(1, deadline - Date.now())),
            signal,
          );
          status =
            (code >= 200 && code < 300) ||
            (code === 404 && definition.cleanup.allow404)
              ? "cleaned"
              : "cleanup_failed";
          detail = `本资源清理返回 ${code}`;
        }
      }
    } catch {
      status = operation === "cleanup" ? "cleanup_failed" : "unknown";
    }
    const saved = store.put({
      runId: "data-preparation",
      attemptId: r.id,
      filename: `${operation}-${randomUUID()}.json`,
      data: Buffer.from(JSON.stringify({ resourceId: r.id, status, detail })),
    });
    const evidence = await prisma.artifact.create({
      data: {
        projectId,
        type: "DATA_RESOURCE",
        sensitivity: "NORMAL",
        storageKey: saved.storageKey,
        checksum: saved.checksum,
      },
    });
    await prisma.dataResource.updateMany({
      where: { id: r.id, status: "cleaning", updatedAt: claimedAt },
      data: { status, detail, evidenceId: evidence.id },
    });
  }
  return prisma.dataResource.findMany({
    where: { id: { in: resourceIds }, projectId, pluginId },
  });
}
export async function runDataJob(
  prisma: PrismaClient,
  store: ArtifactStore,
  job: PreparationJob & { kind: string },
  commit: JobCommit,
  signal: AbortSignal,
) {
  const req = job.request as any;
  const rows =
    job.kind === "DATA_PREPARE"
      ? [await prepareData(prisma, store, job.projectId, req, signal)]
      : await operateData(
          prisma,
          store,
          job.projectId,
          req.pluginId,
          req.resourceIds,
          job.kind === "DATA_INSPECT" ? "inspect" : "cleanup",
          signal,
        );
  const okay = rows.every((r) =>
    job.kind === "DATA_CLEANUP"
      ? r.status === "cleaned"
      : ["success", "cleaned"].includes(r.status),
  );
  await commit(prisma, job, async (tx) => {
    await tx.job.update({
      where: { id: job.id },
      data: {
        status: okay ? "SUCCEEDED" : "FAILED",
        finishedAt: new Date(),
        result: {
          resourceIds: rows.map((r) => r.id),
          status: okay ? "complete" : "needs_review",
        },
        ...(!okay
          ? {
              error: {
                code: "DEPENDENCY_UNAVAILABLE",
                message: "数据资源仍需核对或清理",
                requestId: job.id,
              },
            }
          : {}),
      },
    });
  });
}
