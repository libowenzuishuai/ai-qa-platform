import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { PrismaClient } from "@prisma/client";
import { loadConfig } from "./config.js";
import { registerAuth } from "./auth.js";
import { registerProjectRoutes } from "./routes-projects.js";
import { sendApiError } from "./errors.js";

const config = loadConfig();
if (!config.databaseUrl) {
  console.error("缺少 DATABASE_URL；请复制 .env.example 为 .env 并配置");
  process.exit(1);
}

export const prisma = new PrismaClient();

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

  return app;
}

const app = await buildServer();
app.listen({ port: config.port, host: config.host }).then(() => {
  app.log.info(`api listening on http://${config.host}:${config.port}`);
});

const shutdown = async () => {
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
