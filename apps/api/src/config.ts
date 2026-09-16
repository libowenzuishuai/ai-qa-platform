import { z } from "zod";

export const ApiConfig = z.object({
  port: z.number().int().default(7300),
  host: z.string().default("127.0.0.1"),
  databaseUrl: z.string().min(1),
  sessionSecret: z.string().min(1),
  /** 会话有效期（秒） */
  sessionTtlSeconds: z.number().int().default(60 * 60 * 12),
});

export type ApiConfig = z.infer<typeof ApiConfig>;

export function loadConfig(): ApiConfig {
  return ApiConfig.parse({
    port: Number(process.env.API_PORT ?? 7300),
    host: process.env.API_HOST ?? "127.0.0.1",
    databaseUrl: process.env.DATABASE_URL,
    sessionSecret: process.env.SESSION_SECRET,
    sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS ?? 60 * 60 * 12),
  });
}
