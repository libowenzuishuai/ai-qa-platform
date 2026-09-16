import Fastify from "fastify";

/**
 * 执行 worker 骨架（阶段 0）。
 *
 * 本阶段只提供健康检查与能力声明；真实队列消费、Playwright 执行器、
 * 判定与证据保存在阶段 1 实现。禁止用假进度或模拟结果填充。
 */

const port = Number(process.env.WORKER_PORT ?? 7200);
const host = process.env.WORKER_HOST ?? "127.0.0.1";

const app = Fastify({ logger: { level: process.env.WORKER_LOG_LEVEL ?? "info" } });

app.get("/api/health", async () => ({
  ok: true,
  service: "worker",
  /** 阶段 0 骨架：尚不消费队列。阶段 1 起为 ready。 */
  status: "stub",
  capabilities: {
    executor: false,
    queue: false,
  },
}));

await app.listen({ port, host });
app.log.info(`worker skeleton listening on http://${host}:${port}`);
