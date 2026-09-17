import { z } from "zod";

export const WorkerConfig = z.object({
  port: z.number().int().default(7200),
  host: z.string().default("127.0.0.1"),
  databaseUrl: z.string().min(1),
  redisUrl: z.string().min(1),
  /** 证据存储根目录（与 API 一致）。 */
  artifactDir: z.string().default("data/artifacts"),
  /** demo-app 评测夹具令牌。 */
  demoFixtureToken: z.string().default("dev-fixture-token"),
  logLevel: z.string().default("info"),
});

export type WorkerConfig = z.infer<typeof WorkerConfig>;

export function loadConfig(): WorkerConfig {
  return WorkerConfig.parse({
    port: Number(process.env.WORKER_PORT ?? 7200),
    host: process.env.WORKER_HOST ?? "127.0.0.1",
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6380/0",
    artifactDir: process.env.AIQA_ARTIFACT_DIR ?? "data/artifacts",
    demoFixtureToken: process.env.DEMO_FIXTURE_TOKEN ?? "dev-fixture-token",
    logLevel: process.env.WORKER_LOG_LEVEL ?? "info",
  });
}
