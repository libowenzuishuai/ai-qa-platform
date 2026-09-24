import {registerGithubRoutes} from './routes-github.js';
import {registerChangeReviewRoutes} from "./routes-change-review.js";
import { registerRunnerRoutes } from "./routes-runners.js";
import { registerDefectRoutes } from "./routes-defects.js";
import { registerProductRoutes } from "./routes-product.js";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { PrismaClient } from "@prisma/client";
import { Queue } from "bullmq";
import { ArtifactStore } from "@ai-qa/artifact-store";
import { parseRedisConnection } from "@ai-qa/run-events";
import { loadConfig } from "./config.js";
import { registerAuth } from "./auth.js";
import { registerProjectRoutes } from "./routes-projects.js";
import { registerRunRoutes } from "./routes-runs.js";
import { registerAssetRoutes } from "./routes-assets.js";
import { registerArtifactRoutes } from "./routes-artifacts.js";
import { registerDocumentRoutes } from "./routes-documents.js";
import { registerReviewRoutes } from "./routes-review.js";
import { registerJobRoutes } from "./routes-jobs.js";
import { registerPreparationRoutes } from "./routes-preparation.js";
import { registerDataPluginRoutes } from "./routes-data-plugins.js";
import { registerWorkflowRoutes } from "./routes-workflow.js";
import { registerReleaseRoutes } from "./routes-release.js";
import { registerSnapshotChangeRoutes } from "./routes-snapshot-changes.js";
import { registerChunkRoutes } from "./routes-chunks.js";
import { registerV2CapabilityRoutes } from "./routes-v2-capabilities.js";
import { registerV2OracleRoutes } from "./routes-v2-oracle.js";
import { registerV2ContextRoutes } from "./routes-v2-context.js";
import { registerV2ReadinessRoutes } from "./routes-v2-readiness.js";
import { registerV2SessionRoutes } from "./routes-v2-sessions.js";
import { registerV2MemoryRoutes } from "./routes-v2-memory.js";
import { registerV2FindingRoutes } from "./routes-v2-findings.js";
import { sendApiError } from "./errors.js";

const config = loadConfig();
if (!config.databaseUrl) {
  console.error("缺少 DATABASE_URL；请复制 .env.example 为 .env 并配置");
  process.exit(1);
}

export const prisma = new PrismaClient();

// Redis URL 完整解析（§三.1）：db/密码/TLS 实际生效。
const parsedRedis = parseRedisConnection(process.env.REDIS_URL ?? "redis://127.0.0.1:6380/0");
const redisConnection = {
  host: parsedRedis.host,
  port: parsedRedis.port,
  ...(parsedRedis.username ? { username: parsedRedis.username } : {}),
  ...(parsedRedis.password ? { password: parsedRedis.password } : {}),
  ...(parsedRedis.db !== undefined ? { db: parsedRedis.db } : {}),
  ...(parsedRedis.tls ? { tls: {} } : {}),
};

const runsQueue = new Queue("runs", { connection: redisConnection });
const seedQueue = new Queue("seed-fixed-assets", { connection: redisConnection });
const agentJobsQueue = new Queue("agent-jobs", { connection: redisConnection });

const artifactStore = new ArtifactStore(process.env.AIQA_ARTIFACT_DIR ?? "data/artifacts");

export async function buildServer() {
  const app = Fastify({
    logger: { level: process.env.API_LOG_LEVEL ?? "info" },
    genReqId: () => `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
  });
  await app.register(cookie);
  await app.register(import("@fastify/formbody"));

  app.setErrorHandler((err, req, reply) => sendApiError(req, reply, err));
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      code: "NOT_FOUND",
      message: `路径不存在：${req.method} ${req.url}`,
      requestId: req.id,
    });
  });

  app.get("/api/health", async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { ok: true, service: "api", db: "up" };
    } catch {
      return { ok: false, service: "api", db: "down" };
    }
  });

  registerAuth(app, prisma, config.sessionTtlSeconds);
  registerProjectRoutes(app, prisma);
  registerAssetRoutes(app, prisma, seedQueue);
  registerRunRoutes(app, prisma, runsQueue, artifactStore);
  registerArtifactRoutes(app, prisma, artifactStore);
  registerJobRoutes(app, prisma, agentJobsQueue);
  registerPreparationRoutes(app, prisma, agentJobsQueue);
  registerDataPluginRoutes(app, prisma, agentJobsQueue);
  registerWorkflowRoutes(app, prisma);
  registerGithubRoutes(app, prisma);
  registerReleaseRoutes(app, prisma, artifactStore, agentJobsQueue);
  registerDocumentRoutes(app, prisma, agentJobsQueue, artifactStore);
  registerReviewRoutes(app, prisma);
  registerProductRoutes(app, prisma, artifactStore, agentJobsQueue, runsQueue);
  registerChangeReviewRoutes(app,prisma,artifactStore,agentJobsQueue);
  registerSnapshotChangeRoutes(app,prisma,artifactStore,agentJobsQueue);
  registerChunkRoutes(app,prisma,agentJobsQueue);
  registerV2CapabilityRoutes(app,prisma);
  registerV2OracleRoutes(app,prisma);
  registerV2ReadinessRoutes(app,prisma);
  registerV2SessionRoutes(app,prisma,agentJobsQueue);
  registerV2MemoryRoutes(app,prisma);
  registerV2FindingRoutes(app,prisma);
  registerV2ContextRoutes(app,prisma,{
    intelligenceUrl: process.env.AIQA_INTELLIGENCE_URL,
    intelligenceToken: process.env.AIQA_INTELLIGENCE_TOKEN,
    artifactDir: process.env.AIQA_ARTIFACT_DIR,
  });
  registerDefectRoutes(app, prisma, artifactStore, runsQueue);
  registerRunnerRoutes(app, prisma, artifactStore);

  return app;
}

const app = await buildServer();
app.listen({ port: config.port, host: config.host }).then(() => {
  app.log.info(`api listening on http://${config.host}:${config.port}`);
});

const shutdown = async () => {
  await app.close();
  await runsQueue.close();
  await seedQueue.close();
  await agentJobsQueue.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
